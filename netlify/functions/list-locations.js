// Read-only: the location targets (and exclusions) set on each campaign, with
// readable place names resolved from geo_target_constant.
//
// GET /.netlify/functions/list-locations?customerId=9427798225[&campaignId=...]   (x-mcc-token required)

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
    headers: { Authorization: `Bearer ${access}`, "developer-token": env.devToken, "login-customer-id": env.loginCid, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw { step: "search", status: res.status, detail: body };
  return (Array.isArray(body) ? body : []).flatMap((b) => b.results || []);
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
    SELECT campaign.id, campaign.name,
      campaign_criterion.criterion_id, campaign_criterion.location.geo_target_constant, campaign_criterion.negative
    FROM campaign_criterion
    WHERE campaign_criterion.type = 'LOCATION'
  `;
  if (campaignId) gaql += ` AND campaign.id = ${campaignId}`;
  gaql += ` ORDER BY campaign.name`;

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, refresh_token: env.refreshToken, grant_type: "refresh_token" }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) return json(502, { ok: false, step: "token_exchange", status: tokenRes.status, detail: tokenJson });
    const access = tokenJson.access_token;

    const rows = await search(env, access, customerId, gaql.trim());

    // Resolve geo constant IDs -> readable names in one follow-up query.
    const geoIds = [...new Set(rows.map((r) => (r.campaignCriterion?.location?.geoTargetConstant || "").split("/")[1]).filter(Boolean))];
    const names = {};
    if (geoIds.length) {
      const geoRows = await search(env, access, customerId,
        `SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.canonical_name, geo_target_constant.target_type FROM geo_target_constant WHERE geo_target_constant.id IN (${geoIds.join(",")})`);
      for (const g of geoRows) {
        const gc = g.geoTargetConstant || {};
        if (gc.id) names[String(gc.id)] = { name: gc.name, canonical_name: gc.canonicalName, target_type: gc.targetType };
      }
    }

    const locations = rows.map((r) => {
      const cc = r.campaignCriterion || {};
      const gid = (cc.location?.geoTargetConstant || "").split("/")[1] || null;
      const meta = gid ? names[gid] : null;
      return {
        criterion_id: cc.criterionId,
        geo_target_constant_id: gid,
        name: meta?.name || null,
        canonical_name: meta?.canonical_name || null,
        target_type: meta?.target_type || null,
        excluded: !!cc.negative,
        campaign_id: r.campaign?.id || null,
        campaign_name: r.campaign?.name || null,
      };
    });

    return json(200, { ok: true, version: env.version, customerId, count: locations.length, locations });
  } catch (e) {
    const status = (e && e.status) || 502;
    return json(status >= 400 && status < 600 ? status : 502, { ok: false, ...(e && typeof e === "object" ? e : { error: String(e) }) });
  }
};
