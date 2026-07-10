// Management engine: the check-then-do loop for mutating accounts under the MCC.
//
// SAFETY MODEL (do not weaken):
//   1. Every request defaults to a DRY RUN (validateOnly:true). Nothing changes
//      unless the caller sends confirm:true.
//   2. Before any mutation the target customer is verified to sit UNDER the MCC
//      (login-customer-id). A customer not in the hierarchy is refused outright.
//   3. The current value is read first, so the response shows old -> new.
//   4. Every applied change returns an audit record (persist to Supabase later).
//
// POST JSON body:
//   { action, customerId, confirm?, ...action-specific fields }
//
//   action="set_campaign_status": { campaignId, status: "PAUSED"|"ENABLED"|"REMOVED" }
//   action="update_campaign_budget": { budgetId, amount /* dollars */ }
//
// Returns (dry run):  { ok:true, dry_run:true, preview:{ old, new, request } }
// Returns (applied):  { ok:true, dry_run:false, applied:true, audit:{...}, result }

const ALLOWED_STATUS = new Set(["PAUSED", "ENABLED", "REMOVED"]);
const MATCH_TYPES = new Set(["EXACT", "PHRASE", "BROAD"]);

const mask = (v) => {
  if (!v) return { present: false };
  const raw = String(v); const t = raw.trim();
  return { present: true, length: t.length, had_whitespace: raw !== t, has_quotes: /["']/.test(raw), first4: t.slice(0, 4), last4: t.slice(-4) };
};
const digits = (v) => String(v || "").replace(/[^0-9]/g, "");
const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

async function getAccessToken(env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.clientId, client_secret: env.clientSecret,
      refresh_token: env.refreshToken, grant_type: "refresh_token",
    }),
  });
  const body = await res.json();
  if (!res.ok) throw { step: "token_exchange", status: res.status, detail: body };
  return body.access_token;
}

// Run a GAQL read against a specific customer id.
async function search(env, access, customerId, query) {
  const url = `https://googleads.googleapis.com/${env.version}/customers/${customerId}/googleAds:searchStream`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`, "developer-token": env.devToken,
      "login-customer-id": env.loginCid, "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw { step: "search", status: res.status, detail: body };
  const batches = Array.isArray(body) ? body : [];
  return batches.flatMap((b) => b.results || []);
}

// Guardrail: is customerId in the MCC hierarchy (a descendant, or the MCC itself)?
async function assertUnderMcc(env, access, customerId) {
  if (customerId === env.loginCid) return; // acting on the MCC itself is allowed
  const rows = await search(env, access, env.loginCid,
    "SELECT customer_client.id FROM customer_client WHERE customer_client.status = 'ENABLED'");
  const ids = new Set(rows.map((r) => String(r.customerClient?.id)));
  if (!ids.has(customerId)) {
    throw { step: "guardrail", status: 403, detail: `Customer ${customerId} is not under MCC ${env.loginCid}. Refusing to mutate.` };
  }
}

// Persist an applied change to Supabase via PostgREST (service-role key).
// Never throws: a logging failure must not hide that the change happened.
async function writeAudit(env, record) {
  if (!env.supabaseUrl || !env.supabaseKey) return { persisted: false, reason: "supabase_env_missing" };
  try {
    const res = await fetch(`${env.supabaseUrl}/rest/v1/audit_log`, {
      method: "POST",
      headers: {
        apikey: env.supabaseKey,
        Authorization: `Bearer ${env.supabaseKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(record),
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) return { persisted: false, reason: "supabase_error", status: res.status, detail: body };
    return { persisted: true, row: Array.isArray(body) ? body[0] : body };
  } catch (e) {
    return { persisted: false, reason: "supabase_exception", detail: String(e) };
  }
}

async function mutate(env, access, customerId, resource, operation, validateOnly) {
  const url = `https://googleads.googleapis.com/${env.version}/customers/${customerId}/${resource}:mutate`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`, "developer-token": env.devToken,
      "login-customer-id": env.loginCid, "Content-Type": "application/json",
    },
    body: JSON.stringify({ operations: [operation], validateOnly }),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw { step: `mutate_${resource}`, status: res.status, detail: body };
  return body;
}

exports.handler = async (event) => {
  try {
    const env = {
      clientId: (process.env.GOOGLE_ADS_CLIENT_ID || "").trim(),
      clientSecret: (process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim(),
      refreshToken: (process.env.GOOGLE_OAUTH_REFRESH_TOKEN || "").trim(),
      devToken: (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim(),
      loginCid: digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
      version: (process.env.GOOGLE_ADS_API_VERSION || "v22").trim(),
      supabaseUrl: (process.env.SUPABASE_URL || "").trim().replace(/\/$/, ""),
      supabaseKey: (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim(),
    };
    const debug = { version: env.version, developer_token: mask(process.env.GOOGLE_ADS_DEVELOPER_TOKEN), login_customer_id: mask(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) };

    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "Use POST" });

    // Auth gate: only callers presenting the shared secret may mutate anything.
    const secret = (process.env.MCC_API_SECRET || "").trim();
    if (!secret) return json(500, { ok: false, error: "Server not configured: MCC_API_SECRET is not set" });
    const provided = ((event.headers && (event.headers["x-mcc-token"] || event.headers["X-Mcc-Token"])) || "").trim();
    if (provided.length !== secret.length || provided !== secret) {
      return json(401, { ok: false, error: "Unauthorized: missing or invalid x-mcc-token header" });
    }

    let req; try { req = JSON.parse(event.body || "{}"); } catch { return json(400, { ok: false, error: "Body must be JSON" }); }

    const action = req.action;
    const customerId = digits(req.customerId);
    const confirm = req.confirm === true;
    const validateOnly = !confirm; // DRY RUN unless explicitly confirmed
    if (!action) return json(400, { ok: false, error: "Missing 'action'" });
    if (!customerId) return json(400, { ok: false, error: "Missing 'customerId'" });

    const access = await getAccessToken(env);
    await assertUnderMcc(env, access, customerId); // hard guardrail

    let resource, operation, preview;

    if (action === "set_campaign_status") {
      const campaignId = digits(req.campaignId);
      const status = String(req.status || "").toUpperCase();
      if (!campaignId) return json(400, { ok: false, error: "Missing 'campaignId'" });
      if (!ALLOWED_STATUS.has(status)) return json(400, { ok: false, error: `status must be one of ${[...ALLOWED_STATUS].join(", ")}` });

      const rows = await search(env, access, customerId,
        `SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.id = ${campaignId}`);
      if (!rows.length) return json(404, { ok: false, error: `Campaign ${campaignId} not found in ${customerId}` });
      const current = rows[0].campaign;

      resource = "campaigns";
      operation = { updateMask: "status", update: { resourceName: `customers/${customerId}/campaigns/${campaignId}`, status } };
      preview = { target: `campaign ${campaignId} (${current.name})`, field: "status", old: current.status, new: status };

    } else if (action === "update_campaign_budget") {
      const budgetId = digits(req.budgetId);
      const amount = Number(req.amount);
      if (!budgetId) return json(400, { ok: false, error: "Missing 'budgetId'" });
      if (!(amount > 0)) return json(400, { ok: false, error: "'amount' (dollars) must be a positive number" });
      const amountMicros = String(Math.round(amount * 1e6));

      const rows = await search(env, access, customerId,
        `SELECT campaign_budget.id, campaign_budget.name, campaign_budget.amount_micros FROM campaign_budget WHERE campaign_budget.id = ${budgetId}`);
      if (!rows.length) return json(404, { ok: false, error: `Budget ${budgetId} not found in ${customerId}` });
      const current = rows[0].campaignBudget;
      const oldDollars = current.amountMicros ? Number(current.amountMicros) / 1e6 : null;

      resource = "campaignBudgets";
      operation = { updateMask: "amount_micros", update: { resourceName: `customers/${customerId}/campaignBudgets/${budgetId}`, amountMicros } };
      preview = { target: `budget ${budgetId} (${current.name})`, field: "daily budget", old: oldDollars, new: amount };

    } else if (action === "set_ad_group_status") {
      const adGroupId = digits(req.adGroupId);
      const status = String(req.status || "").toUpperCase();
      if (!adGroupId) return json(400, { ok: false, error: "Missing 'adGroupId'" });
      if (!ALLOWED_STATUS.has(status)) return json(400, { ok: false, error: `status must be one of ${[...ALLOWED_STATUS].join(", ")}` });

      const rows = await search(env, access, customerId,
        `SELECT ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE ad_group.id = ${adGroupId}`);
      if (!rows.length) return json(404, { ok: false, error: `Ad group ${adGroupId} not found in ${customerId}` });
      const current = rows[0].adGroup;

      resource = "adGroups";
      operation = { updateMask: "status", update: { resourceName: `customers/${customerId}/adGroups/${adGroupId}`, status } };
      preview = { target: `ad group ${adGroupId} (${current.name})`, field: "status", old: current.status, new: status };

    } else if (action === "set_asset_group_status") {
      const assetGroupId = digits(req.assetGroupId);
      const status = String(req.status || "").toUpperCase();
      if (!assetGroupId) return json(400, { ok: false, error: "Missing 'assetGroupId'" });
      if (!ALLOWED_STATUS.has(status)) return json(400, { ok: false, error: `status must be one of ${[...ALLOWED_STATUS].join(", ")}` });

      const rows = await search(env, access, customerId,
        `SELECT asset_group.id, asset_group.name, asset_group.status FROM asset_group WHERE asset_group.id = ${assetGroupId}`);
      if (!rows.length) return json(404, { ok: false, error: `Asset group ${assetGroupId} not found in ${customerId}` });
      const current = rows[0].assetGroup;

      resource = "assetGroups";
      operation = { updateMask: "status", update: { resourceName: `customers/${customerId}/assetGroups/${assetGroupId}`, status } };
      preview = { target: `asset group ${assetGroupId} (${current.name})`, field: "status", old: current.status, new: status };

    } else if (action === "set_target_cpa") {
      const campaignId = digits(req.campaignId);
      const amount = Number(req.amount);
      if (!campaignId) return json(400, { ok: false, error: "Missing 'campaignId'" });
      if (!(amount > 0)) return json(400, { ok: false, error: "'amount' (target CPA in dollars) must be a positive number" });
      const amountMicros = String(Math.round(amount * 1e6));

      const rows = await search(env, access, customerId,
        `SELECT campaign.id, campaign.name, campaign.bidding_strategy_type, campaign.bidding_strategy, campaign.target_cpa.target_cpa_micros, campaign.maximize_conversions.target_cpa_micros FROM campaign WHERE campaign.id = ${campaignId}`);
      if (!rows.length) return json(404, { ok: false, error: `Campaign ${campaignId} not found in ${customerId}` });
      const c = rows[0].campaign;

      // Portfolio/shared strategies must be edited on the strategy resource, not the campaign.
      if (c.biddingStrategy) return json(409, { ok: false, error: `Campaign ${campaignId} uses a shared/portfolio bidding strategy. Edit the strategy directly, not the campaign.` });

      let maskPath, updateBody, oldMicros;
      if (c.biddingStrategyType === "MAXIMIZE_CONVERSIONS") {
        maskPath = "maximize_conversions.target_cpa_micros";
        updateBody = { resourceName: `customers/${customerId}/campaigns/${campaignId}`, maximizeConversions: { targetCpaMicros: amountMicros } };
        oldMicros = c.maximizeConversions?.targetCpaMicros ?? null;
      } else if (c.biddingStrategyType === "TARGET_CPA") {
        maskPath = "target_cpa.target_cpa_micros";
        updateBody = { resourceName: `customers/${customerId}/campaigns/${campaignId}`, targetCpa: { targetCpaMicros: amountMicros } };
        oldMicros = c.targetCpa?.targetCpaMicros ?? null;
      } else {
        return json(409, { ok: false, error: `Target CPA not applicable: campaign bidding strategy is ${c.biddingStrategyType}. Supported: MAXIMIZE_CONVERSIONS, TARGET_CPA.` });
      }

      resource = "campaigns";
      operation = { updateMask: maskPath, update: updateBody };
      preview = { target: `campaign ${campaignId} (${c.name})`, field: "target CPA", old: oldMicros != null ? Number(oldMicros) / 1e6 : null, new: amount };

    } else if (action === "add_keyword") {
      const adGroupId = digits(req.adGroupId);
      const text = String(req.text || "").trim();
      const matchType = String(req.matchType || "BROAD").toUpperCase();
      if (!adGroupId) return json(400, { ok: false, error: "Missing 'adGroupId'" });
      if (!text) return json(400, { ok: false, error: "Missing 'text' (keyword)" });
      if (!MATCH_TYPES.has(matchType)) return json(400, { ok: false, error: `matchType must be one of ${[...MATCH_TYPES].join(", ")}` });

      const rows = await search(env, access, customerId,
        `SELECT ad_group.id, ad_group.name FROM ad_group WHERE ad_group.id = ${adGroupId}`);
      if (!rows.length) return json(404, { ok: false, error: `Ad group ${adGroupId} not found in ${customerId}` });

      resource = "adGroupCriteria";
      operation = { create: { adGroup: `customers/${customerId}/adGroups/${adGroupId}`, status: "ENABLED", keyword: { text, matchType } } };
      preview = { target: `ad group ${adGroupId} (${rows[0].adGroup?.name})`, field: `add ${matchType} keyword`, old: null, new: text };

    } else if (action === "set_keyword_status") {
      const adGroupId = digits(req.adGroupId);
      const criterionId = digits(req.criterionId);
      const status = String(req.status || "").toUpperCase();
      if (!adGroupId || !criterionId) return json(400, { ok: false, error: "Missing 'adGroupId' and/or 'criterionId'" });
      if (!ALLOWED_STATUS.has(status)) return json(400, { ok: false, error: `status must be one of ${[...ALLOWED_STATUS].join(", ")}` });

      const rows = await search(env, access, customerId,
        `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.status FROM ad_group_criterion WHERE ad_group_criterion.criterion_id = ${criterionId} AND ad_group.id = ${adGroupId}`);
      if (!rows.length) return json(404, { ok: false, error: `Keyword ${criterionId} not found in ad group ${adGroupId}` });
      const cur = rows[0].adGroupCriterion;

      resource = "adGroupCriteria";
      operation = { updateMask: "status", update: { resourceName: `customers/${customerId}/adGroupCriteria/${adGroupId}~${criterionId}`, status } };
      preview = { target: `keyword "${cur.keyword?.text}" (${criterionId})`, field: "status", old: cur.status, new: status };

    } else if (action === "remove_keyword") {
      const adGroupId = digits(req.adGroupId);
      const criterionId = digits(req.criterionId);
      if (!adGroupId || !criterionId) return json(400, { ok: false, error: "Missing 'adGroupId' and/or 'criterionId'" });

      const rows = await search(env, access, customerId,
        `SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.status FROM ad_group_criterion WHERE ad_group_criterion.criterion_id = ${criterionId} AND ad_group.id = ${adGroupId}`);
      if (!rows.length) return json(404, { ok: false, error: `Keyword ${criterionId} not found in ad group ${adGroupId}` });
      const cur = rows[0].adGroupCriterion;

      resource = "adGroupCriteria";
      operation = { remove: `customers/${customerId}/adGroupCriteria/${adGroupId}~${criterionId}` };
      preview = { target: `keyword "${cur.keyword?.text}" (${criterionId})`, field: "remove keyword", old: cur.status, new: "REMOVED" };

    } else if (action === "add_negative_keyword") {
      const campaignId = digits(req.campaignId);
      const text = String(req.text || "").trim();
      const matchType = String(req.matchType || "BROAD").toUpperCase();
      if (!campaignId) return json(400, { ok: false, error: "Missing 'campaignId'" });
      if (!text) return json(400, { ok: false, error: "Missing 'text' (negative keyword)" });
      if (!MATCH_TYPES.has(matchType)) return json(400, { ok: false, error: `matchType must be one of ${[...MATCH_TYPES].join(", ")}` });

      const rows = await search(env, access, customerId,
        `SELECT campaign.id, campaign.name FROM campaign WHERE campaign.id = ${campaignId}`);
      if (!rows.length) return json(404, { ok: false, error: `Campaign ${campaignId} not found in ${customerId}` });

      resource = "campaignCriteria";
      operation = { create: { campaign: `customers/${customerId}/campaigns/${campaignId}`, negative: true, keyword: { text, matchType } } };
      preview = { target: `campaign ${campaignId} (${rows[0].campaign?.name})`, field: `add ${matchType} NEGATIVE keyword`, old: null, new: text };

    } else {
      return json(400, { ok: false, error: `Unknown action '${action}'` });
    }

    // Always call the API with validateOnly first-or-only.
    const result = await mutate(env, access, customerId, resource, operation, validateOnly);

    if (validateOnly) {
      return json(200, { ok: true, dry_run: true, action, customerId, preview, request: operation, note: "Nothing changed. Re-send with confirm:true to apply." });
    }

    const record = {
      action, customer_id: customerId,
      target: preview.target, field: preview.field,
      old_value: preview.old == null ? null : String(preview.old),
      new_value: preview.new == null ? null : String(preview.new),
      request: operation, result, status: "applied",
    };
    const audit = await writeAudit(env, record);
    return json(200, {
      ok: true, dry_run: false, applied: true, action, customerId,
      change: preview,
      audit_persisted: audit.persisted,
      audit: audit.persisted
        ? audit.row
        : { warning: "Change APPLIED but NOT logged to Supabase.", ...audit },
      result,
    });

  } catch (e) {
    const status = (e && e.status) || 500;
    return json(status >= 400 && status < 600 ? status : 502, { ok: false, ...(e && typeof e === "object" ? e : { error: String(e) }) });
  }
};
