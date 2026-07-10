// Read-only: list ad groups AND asset groups in an account, with status and
// parent campaign. Source of adGroupId / assetGroupId for the `manage` status
// actions. (Search/Display/Demand Gen use ad groups; Performance Max uses
// asset groups.)
//
// GET /.netlify/functions/list-adgroups?customerId=9427798225   (x-mcc-token required)

const digits = (v) => String(v || "").replace(/[^0-9]/g, "");
const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const authError = (event) => {
  const s = (process.env.MCC_API_SECRET || "").trim();
  if (!s) return json(500, { ok: false, error: "Server not configured: MCC_API_SECRET is not set" });
  const p = ((event && event.headers && (event.headers["x-mcc-token"] || event.headers["X-Mcc-Token"])) || "").trim();
  if (p.length !== s.length || p !== s) return json(401, { ok: false, error: "Unauthorized: missing or invalid x-mcc-token header" });
  return null;
};

const AD_GROUP_GAQL = `
  SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id, campaign.name
  FROM ad_group
  ORDER BY campaign.name, ad_group.name
`.trim();

const ASSET_GROUP_GAQL = `
  SELECT asset_group.id, asset_group.name, asset_group.status, campaign.id, campaign.name
  FROM asset_group
  ORDER BY campaign.name, asset_group.name
`.trim();

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

  const customerId = digits((event.queryStringParameters || {}).customerId);
  if (!customerId) return json(400, { ok: false, error: "Missing ?customerId=" });

  try {
    // token exchange
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, refresh_token: env.refreshToken, grant_type: "refresh_token" }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) return json(502, { ok: false, step: "token_exchange", status: tokenRes.status, detail: tokenJson });
    const access = tokenJson.access_token;

    const [agRows, asgRows] = await Promise.all([
      search(env, access, customerId, AD_GROUP_GAQL),
      search(env, access, customerId, ASSET_GROUP_GAQL),
    ]);

    const ad_groups = agRows.map((r) => ({
      ad_group_id: r.adGroup?.id,
      name: r.adGroup?.name || null,
      status: r.adGroup?.status,
      campaign_id: r.campaign?.id || null,
      campaign_name: r.campaign?.name || null,
    }));

    const asset_groups = asgRows.map((r) => ({
      asset_group_id: r.assetGroup?.id,
      name: r.assetGroup?.name || null,
      status: r.assetGroup?.status,
      campaign_id: r.campaign?.id || null,
      campaign_name: r.campaign?.name || null,
    }));

    return json(200, {
      ok: true, version: env.version, customerId,
      ad_group_count: ad_groups.length, asset_group_count: asset_groups.length,
      ad_groups, asset_groups,
    });
  } catch (e) {
    const status = (e && e.status) || 502;
    return json(status >= 400 && status < 600 ? status : 502, { ok: false, ...(e && typeof e === "object" ? e : { error: String(e) }) });
  }
};
