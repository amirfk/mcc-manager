// Pull DAILY (date-segmented) performance and UPSERT it into Supabase
// metrics_daily, so history accumulates across pulls. Idempotent: re-running a
// day refreshes its rows (merge on report_date+level+entity_id).
//
// GET /.netlify/functions/snapshot-metrics?customerId=9427798225
//     &level=campaign|ad_group|keyword|ad   (default campaign)
//     &days=7|14|30                         (default 30)
//     x-mcc-token required

const digits = (v) => String(v || "").replace(/[^0-9]/g, "");
const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const authError = (event) => {
  const s = (process.env.MCC_API_SECRET || "").trim();
  if (!s) return json(500, { ok: false, error: "Server not configured: MCC_API_SECRET is not set" });
  const p = ((event && event.headers && (event.headers["x-mcc-token"] || event.headers["X-Mcc-Token"])) || "").trim();
  if (p.length !== s.length || p !== s) return json(401, { ok: false, error: "Unauthorized: missing or invalid x-mcc-token header" });
  return null;
};

const RANGE = { "7": "LAST_7_DAYS", "14": "LAST_14_DAYS", "30": "LAST_30_DAYS" };

const LEVELS = {
  campaign: { from: "campaign", idFields: "campaign.id, campaign.name",
    row: (r) => ({ entity_id: r.campaign?.id, entity_name: r.campaign?.name, campaign_id: r.campaign?.id, campaign_name: r.campaign?.name }) },
  ad_group: { from: "ad_group", idFields: "campaign.id, campaign.name, ad_group.id, ad_group.name",
    row: (r) => ({ entity_id: r.adGroup?.id, entity_name: r.adGroup?.name, campaign_id: r.campaign?.id, campaign_name: r.campaign?.name }) },
  keyword: { from: "keyword_view", idFields: "campaign.name, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text",
    row: (r) => ({ entity_id: r.adGroupCriterion?.criterionId, entity_name: r.adGroupCriterion?.keyword?.text, campaign_id: null, campaign_name: r.campaign?.name }) },
  ad: { from: "ad_group_ad", idFields: "campaign.name, ad_group.name, ad_group_ad.ad.id",
    row: (r) => ({ entity_id: r.adGroupAd?.ad?.id, entity_name: r.adGroup?.name, campaign_id: null, campaign_name: r.campaign?.name }) },
};

async function search(env, access, customerId, query) {
  const url = `https://googleads.googleapis.com/${env.version}/customers/${customerId}/googleAds:searchStream`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "developer-token": env.devToken, "login-customer-id": env.loginCid, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw { step: "search", status: res.status, detail: body };
  return (Array.isArray(body) ? body : []).flatMap((b) => b.results || []);
}

async function upsert(env, rows) {
  if (!env.supabaseUrl || !env.supabaseKey) return { persisted: false, reason: "supabase_env_missing" };
  if (!rows.length) return { persisted: true, count: 0 };
  const res = await fetch(`${env.supabaseUrl}/rest/v1/metrics_daily?on_conflict=report_date,level,entity_id`, {
    method: "POST",
    headers: {
      apikey: env.supabaseKey, Authorization: `Bearer ${env.supabaseKey}`,
      "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) { const t = await res.text(); return { persisted: false, reason: "supabase_error", status: res.status, detail: t }; }
  return { persisted: true, count: rows.length };
}

exports.handler = async (event) => {
  const denied = authError(event);
  if (denied) return denied;

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

  const q = event.queryStringParameters || {};
  const customerId = digits(q.customerId);
  if (!customerId) return json(400, { ok: false, error: "Missing ?customerId=" });
  const levelKey = String(q.level || "campaign").toLowerCase();
  const level = LEVELS[levelKey];
  if (!level) return json(400, { ok: false, error: `level must be one of ${Object.keys(LEVELS).join(", ")}` });
  const during = RANGE[String(q.days || "30")] || "LAST_30_DAYS";

  const gaql = `SELECT ${level.idFields}, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM ${level.from} WHERE segments.date DURING ${during}`;

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, refresh_token: env.refreshToken, grant_type: "refresh_token" }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) return json(502, { ok: false, step: "token_exchange", status: tokenRes.status, detail: tokenJson });

    const results = await search(env, tokenJson.access_token, customerId, gaql);
    const rows = results.map((r) => {
      const m = r.metrics || {};
      const base = level.row(r);
      return {
        report_date: r.segments?.date,
        level: levelKey,
        entity_id: String(base.entity_id ?? ""),
        entity_name: base.entity_name || null,
        campaign_id: base.campaign_id ? String(base.campaign_id) : null,
        campaign_name: base.campaign_name || null,
        cost: m.costMicros ? Number(m.costMicros) / 1e6 : 0,
        impressions: Number(m.impressions || 0),
        clicks: Number(m.clicks || 0),
        conversions: Number(m.conversions || 0),
        conv_value: Number(m.conversionsValue || 0),
      };
    }).filter((r) => r.report_date && r.entity_id);

    const saved = await upsert(env, rows);
    return json(saved.persisted ? 200 : 502, { ok: saved.persisted, level: levelKey, range: during, rows_pulled: rows.length, ...saved });
  } catch (e) {
    const status = (e && e.status) || 502;
    return json(status >= 400 && status < 600 ? status : 502, { ok: false, ...(e && typeof e === "object" ? e : { error: String(e) }) });
  }
};
