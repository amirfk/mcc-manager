// Read-only health check: proves the OAuth + developer-token + clean-IP path works.
// Calls customers:listAccessibleCustomers. Cannot spend, change, or create anything.
// Includes a MASKED diagnostic (no secrets exposed) to debug auth issues.

const mask = (v) => {
  if (!v) return { present: false };
  const raw = String(v);
  const t = raw.trim();
  return {
    present: true,
    length: t.length,
    had_whitespace: raw !== t,          // true if a stray space/newline was pasted
    has_quotes: /["']/.test(raw),        // true if quotes were pasted around it
    first4: t.slice(0, 4),
    last4: t.slice(-4),
  };
};

const authError = (event) => {
  const s = (process.env.MCC_API_SECRET || "").trim();
  if (!s) return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "Server not configured: MCC_API_SECRET is not set" }) };
  const p = ((event && event.headers && (event.headers["x-mcc-token"] || event.headers["X-Mcc-Token"])) || "").trim();
  if (p.length !== s.length || p !== s) return { statusCode: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ok: false, error: "Unauthorized: missing or invalid x-mcc-token header" }) };
  return null;
};

exports.handler = async (event) => {
  const H = { "Content-Type": "application/json" };
  const denied = authError(event);
  if (denied) return denied;
  try {
    const clientId     = (process.env.GOOGLE_ADS_CLIENT_ID || "").trim();
    const clientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
    const refreshToken = (process.env.GOOGLE_OAUTH_REFRESH_TOKEN || "").trim();
    const devToken     = (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim();
    const loginCid     = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "").replace(/[^0-9]/g, "");
    const version      = (process.env.GOOGLE_ADS_API_VERSION || "v22").trim();

    const debug = {
      version,
      developer_token: mask(process.env.GOOGLE_ADS_DEVELOPER_TOKEN),
      login_customer_id: mask(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
      client_id_suffix: (clientId.match(/(\.apps\.googleusercontent\.com)$/) ? "ok" : "unexpected"),
    };

    const missing = Object.entries({
      GOOGLE_ADS_CLIENT_ID: clientId,
      GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
      GOOGLE_OAUTH_REFRESH_TOKEN: refreshToken,
      GOOGLE_ADS_DEVELOPER_TOKEN: devToken,
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: loginCid,
    }).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      return { statusCode: 500, headers: H, body: JSON.stringify({ ok: false, error: "Missing env vars", missing, debug }) };
    }

    // 1) refresh token -> access token
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) {
      return { statusCode: 502, headers: H, body: JSON.stringify({ ok: false, step: "token_exchange", status: tokenRes.status, detail: tokenJson, debug }) };
    }

    // 2) list accounts this login can access (read-only)
    const url = `https://googleads.googleapis.com/${version}/customers:listAccessibleCustomers`;
    const adsRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        "developer-token": devToken,
        "login-customer-id": loginCid,
      },
    });
    const adsText = await adsRes.text();
    let adsJson;
    try { adsJson = JSON.parse(adsText); } catch { adsJson = adsText; }
    if (!adsRes.ok) {
      return { statusCode: 502, headers: H, body: JSON.stringify({ ok: false, step: "list_accounts", status: adsRes.status, detail: adsJson, debug }) };
    }

    return {
      statusCode: 200,
      headers: H,
      body: JSON.stringify({
        ok: true,
        version,
        refresh_token_expires_in: tokenJson.refresh_token_expires_in ?? "not_present_good",
        accounts: adsJson,
        debug,
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ ok: false, error: String(e) }) };
  }
};
