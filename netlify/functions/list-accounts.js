// Read-only health check: proves the OAuth + developer-token + clean-IP path works.
// Calls customers:listAccessibleCustomers. Cannot spend, change, or create anything.
exports.handler = async () => {
  const H = { "Content-Type": "application/json" };
  try {
    const clientId     = process.env.GOOGLE_ADS_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
    const devToken     = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
    const loginCid     = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "").replace(/-/g, "");
    const version      = process.env.GOOGLE_ADS_API_VERSION || "v22";

    const missing = Object.entries({
      GOOGLE_ADS_CLIENT_ID: clientId,
      GOOGLE_OAUTH_CLIENT_SECRET: clientSecret,
      GOOGLE_OAUTH_REFRESH_TOKEN: refreshToken,
      GOOGLE_ADS_DEVELOPER_TOKEN: devToken,
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: loginCid,
    }).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      return { statusCode: 500, headers: H, body: JSON.stringify({ ok: false, error: "Missing env vars", missing }) };
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
      return { statusCode: 502, headers: H, body: JSON.stringify({ ok: false, step: "token_exchange", status: tokenRes.status, detail: tokenJson }) };
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
      return { statusCode: 502, headers: H, body: JSON.stringify({ ok: false, step: "list_accounts", status: adsRes.status, detail: adsJson }) };
    }

    return {
      statusCode: 200,
      headers: H,
      body: JSON.stringify({
        ok: true,
        version,
        refresh_token_expires_in: tokenJson.refresh_token_expires_in ?? "not_present_good",
        accounts: adsJson,
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ ok: false, error: String(e) }) };
  }
};
