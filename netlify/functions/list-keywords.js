// Read-only: list all KEYWORD criteria in an account (optionally one campaign),
// with match type and status. Source of criterion ids for keyword mutations.
//
// GET /.netlify/functions/list-keywords?customerId=9427798225[&campaignId=...]   (x-mcc-token required)

const digits = (v) => String(v || "").replace(/[^0-9]/g, "");
const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const authError = (event) => {
  const s = (process.env.MCC_API_SECRET || "").trim();
  if (!s) return json(500, { ok: false, error: "Server not configured: MCC_API_SECRET is not set" });
  const p = ((event && event.headers && (event.headers["x-mcc-token"] || event.headers["X-Mcc-Token"])) || "").trim();
  if (p.length !== s.length || p !== s) return json(401, { ok: false, error: "Unauthorized: missing or invalid x-mcc-token header" });
  return null;
};

async function search(env, access, customerId, query) {
  const url = `https://googleads.googleapis.com/${env.version}/customers/${customerId}/googleAds:searchStream`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access}`,
      "developer-token": env.devToken,
      "login-customer-id": env.loginCid,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw { step: "search", status: res.status, detail: body };
  const batches = Array.isArray(body) ? body : [];
  return batches.flatMap((b) => b.results || []);
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
  };

  const q = event.queryStringParameters || {};
  const customerId = digits(q.customerId);
  const campaignId = digits(q.campaignId);
  if (!customerId) return json(400, { ok: false, error: "Missing ?customerId=" });

  let gaql = `
    SELECT campaign.id, campaign.name, ad_group.id, ad_group.name,
      ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type, ad_group_criterion.status
    FROM ad_group_criterion
    WHERE ad_group_criterion.type = 'KEYWORD'
  `;
  if (campaignId) gaql += ` AND campaign.id = ${campaignId}`;
  gaql += ` ORDER BY campaign.name, ad_group.name`;

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, refresh_token: env.refreshToken, grant_type: "refresh_token" }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) return json(502, { ok: false, step: "token_exchange", status: tokenRes.status, detail: tokenJson });

    const rows = await search(env, tokenJson.access_token, customerId, gaql.trim());
    const keywords = rows.map((r) => ({
      criterion_id: r.adGroupCriterion?.criterionId,
      text: r.adGroupCriterion?.keyword?.text || null,
      match_type: r.adGroupCriterion?.keyword?.matchType || null,
      status: r.adGroupCriterion?.status,
      ad_group_id: r.adGroup?.id || null,
      ad_group_name: r.adGroup?.name || null,
      campaign_id: r.campaign?.id || null,
      campaign_name: r.campaign?.name || null,
      // resource path used to pause/remove this keyword later:
      resource: (r.adGroup?.id && r.adGroupCriterion?.criterionId)
        ? `customers/${customerId}/adGroupCriteria/${r.adGroup.id}~${r.adGroupCriterion.criterionId}`
        : null,
    }));

    return json(200, { ok: true, version: env.version, customerId, count: keywords.length, keywords });
  } catch (e) {
    const status = (e && e.status) || 502;
    return json(status >= 400 && status < 600 ? status : 502, { ok: false, ...(e && typeof e === "object" ? e : { error: String(e) }) });
  }
};
