// Read-only: the search terms (actual user queries) that triggered ads in the
// last N days, with the keyword they matched and performance. This is the
// discovery view for optimization: find winning terms to add as keywords and
// junk terms to add as negatives.
//
// GET /.netlify/functions/list-search-terms?customerId=9427798225[&campaignId=...][&days=30][&limit=200]
//     (x-mcc-token required)

const digits = (v) => String(v || "").replace(/[^0-9]/g, "");
const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const authError = (event) => {
  const s = (process.env.MCC_API_SECRET || "").trim();
  if (!s) return json(500, { ok: false, error: "Server not configured: MCC_API_SECRET is not set" });
  const p = ((event && event.headers && (event.headers["x-mcc-token"] || event.headers["X-Mcc-Token"])) || "").trim();
  if (p.length !== s.length || p !== s) return json(401, { ok: false, error: "Unauthorized: missing or invalid x-mcc-token header" });
  return null;
};

// DURING accepts named ranges; we map a small allowlist to avoid injection.
const RANGE = { "7": "LAST_7_DAYS", "14": "LAST_14_DAYS", "30": "LAST_30_DAYS" };

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
  const during = RANGE[String(q.days || "30")] || "LAST_30_DAYS";
  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  if (limit > 1000) limit = 1000;

  let gaql = `
    SELECT search_term_view.search_term, search_term_view.status,
      campaign.id, campaign.name, ad_group.id, ad_group.name,
      segments.keyword.info.text, segments.keyword.info.match_type,
      metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions
    FROM search_term_view
    WHERE segments.date DURING ${during}
  `;
  if (campaignId) gaql += ` AND campaign.id = ${campaignId}`;
  gaql += ` ORDER BY metrics.cost_micros DESC LIMIT ${limit}`;

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, refresh_token: env.refreshToken, grant_type: "refresh_token" }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) return json(502, { ok: false, step: "token_exchange", status: tokenRes.status, detail: tokenJson });

    const rows = await search(env, tokenJson.access_token, customerId, gaql.trim());
    const terms = rows.map((r) => {
      const m = r.metrics || {};
      return {
        search_term: r.searchTermView?.searchTerm || null,
        status: r.searchTermView?.status || null, // ADDED / EXCLUDED / NONE / ADDED_EXCLUDED
        matched_keyword: r.segments?.keyword?.info?.text || null,
        match_type: r.segments?.keyword?.info?.matchType || null,
        campaign_id: r.campaign?.id || null,
        campaign_name: r.campaign?.name || null,
        ad_group_id: r.adGroup?.id || null,
        ad_group_name: r.adGroup?.name || null,
        impressions: Number(m.impressions || 0),
        clicks: Number(m.clicks || 0),
        cost: m.costMicros ? Number(m.costMicros) / 1e6 : 0,
        conversions: Number(m.conversions || 0),
      };
    });

    return json(200, { ok: true, version: env.version, customerId, range: during, count: terms.length, search_terms: terms });
  } catch (e) {
    const status = (e && e.status) || 502;
    return json(status >= 400 && status < 600 ? status : 502, { ok: false, ...(e && typeof e === "object" ? e : { error: String(e) }) });
  }
};
