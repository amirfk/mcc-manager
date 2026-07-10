// Read-only: the account's conversion actions and — crucially — their VALUE
// settings. This is what explains a near-zero conversion value / ROAS: if
// actions have no default value and no per-conversion value, Google can't
// optimize toward money.
//
// GET /.netlify/functions/list-conversion-actions?customerId=9427798225   (x-mcc-token required)

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

  const customerId = digits((event.queryStringParameters || {}).customerId);
  if (!customerId) return json(400, { ok: false, error: "Missing ?customerId=" });

  const gaql = `
    SELECT conversion_action.id, conversion_action.name, conversion_action.status,
      conversion_action.category, conversion_action.type,
      conversion_action.counting_type, conversion_action.primary_for_goal,
      conversion_action.value_settings.default_value,
      conversion_action.value_settings.always_use_default_value
    FROM conversion_action
    ORDER BY conversion_action.name
  `.trim();

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, refresh_token: env.refreshToken, grant_type: "refresh_token" }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) return json(502, { ok: false, step: "token_exchange", status: tokenRes.status, detail: tokenJson });

    const rows = await search(env, tokenJson.access_token, customerId, gaql);
    const actions = rows.map((r) => {
      const c = r.conversionAction || {};
      const vs = c.valueSettings || {};
      const defVal = vs.defaultValue != null ? Number(vs.defaultValue) : null;
      return {
        id: c.id,
        name: c.name || null,
        status: c.status,
        category: c.category || null,
        type: c.type || null,
        counting_type: c.countingType || null,
        primary_for_goal: c.primaryForGoal ?? null,
        default_value: defVal,
        always_use_default_value: vs.alwaysUseDefaultValue ?? null,
        // the tell: no value configured at all
        has_value: !!(defVal && defVal > 0),
      };
    });

    return json(200, { ok: true, version: env.version, customerId, count: actions.length, conversion_actions: actions });
  } catch (e) {
    const status = (e && e.status) || 502;
    return json(status >= 400 && status < 600 ? status : 502, { ok: false, ...(e && typeof e === "object" ? e : { error: String(e) }) });
  }
};
