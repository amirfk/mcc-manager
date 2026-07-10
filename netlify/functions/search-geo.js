// Read-only: resolve a place name to its geoTargetConstant ID(s) — the number
// add_location needs. Uses GeoTargetConstantService.SuggestGeoTargetConstants.
//
// GET /.netlify/functions/search-geo?q=Kingston upon Thames[&country=GB][&locale=en]
//     (x-mcc-token required)

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const authError = (event) => {
  const s = (process.env.MCC_API_SECRET || "").trim();
  if (!s) return json(500, { ok: false, error: "Server not configured: MCC_API_SECRET is not set" });
  const p = ((event && event.headers && (event.headers["x-mcc-token"] || event.headers["X-Mcc-Token"])) || "").trim();
  if (p.length !== s.length || p !== s) return json(401, { ok: false, error: "Unauthorized: missing or invalid x-mcc-token header" });
  return null;
};

exports.handler = async (event) => {
  const denied = authError(event);
  if (denied) return denied;

  const clientId = (process.env.GOOGLE_ADS_CLIENT_ID || "").trim();
  const clientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
  const refreshToken = (process.env.GOOGLE_OAUTH_REFRESH_TOKEN || "").trim();
  const devToken = (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim();
  const version = (process.env.GOOGLE_ADS_API_VERSION || "v22").trim();

  const q = event.queryStringParameters || {};
  const name = String(q.q || "").trim();
  const country = String(q.country || "GB").trim();
  const locale = String(q.locale || "en").trim();
  if (!name) return json(400, { ok: false, error: "Missing ?q= (place name)" });

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) return json(502, { ok: false, step: "token_exchange", status: tokenRes.status, detail: tokenJson });

    // Not customer-scoped; no login-customer-id needed.
    const url = `https://googleads.googleapis.com/${version}/geoTargetConstants:suggest`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenJson.access_token}`, "developer-token": devToken, "Content-Type": "application/json" },
      body: JSON.stringify({ countryCode: country, locale, locationNames: { names: [name] } }),
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) return json(502, { ok: false, step: "suggest_geo", status: res.status, detail: body });

    const results = (body.geoTargetConstantSuggestions || []).map((s) => {
      const g = s.geoTargetConstant || {};
      return {
        geo_target_constant_id: g.id,
        name: g.name || null,
        canonical_name: g.canonicalName || null,
        country_code: g.countryCode || null,
        target_type: g.targetType || null,
        status: g.status || null,
        reach: s.reach != null ? Number(s.reach) : null,
      };
    });

    return json(200, { ok: true, query: name, country, count: results.length, geo_targets: results });
  } catch (e) {
    return json(502, { ok: false, error: String(e) });
  }
};
