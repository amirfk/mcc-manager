// Read-only: enumerate the child accounts under the MCC.
// Runs a customer_client GAQL query via googleAds:searchStream against the
// login (manager) customer id. Returns clean account rows — id, name, currency,
// timezone, whether it's itself a manager, its depth under the MCC, and status.
// Cannot spend, change, or create anything.

const mask = (v) => {
  if (!v) return { present: false };
  const raw = String(v);
  const t = raw.trim();
  return {
    present: true,
    length: t.length,
    had_whitespace: raw !== t,
    has_quotes: /["']/.test(raw),
    first4: t.slice(0, 4),
    last4: t.slice(-4),
  };
};

// customer_client returns every account BELOW the given manager (all levels).
// level 0 is the manager account itself; level >= 1 are descendants.
const GAQL = `
  SELECT
    customer_client.id,
    customer_client.descriptive_name,
    customer_client.currency_code,
    customer_client.time_zone,
    customer_client.manager,
    customer_client.level,
    customer_client.status,
    customer_client.test_account,
    customer_client.client_customer
  FROM customer_client
  WHERE customer_client.status = 'ENABLED'
  ORDER BY customer_client.level, customer_client.descriptive_name
`.trim();

exports.handler = async () => {
  const H = { "Content-Type": "application/json" };
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

    // 2) query the child accounts under the MCC (read-only)
    const url = `https://googleads.googleapis.com/${version}/customers/${loginCid}/googleAds:searchStream`;
    const adsRes = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenJson.access_token}`,
        "developer-token": devToken,
        "login-customer-id": loginCid,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: GAQL }),
    });
    const adsText = await adsRes.text();
    let adsJson;
    try { adsJson = JSON.parse(adsText); } catch { adsJson = adsText; }
    if (!adsRes.ok) {
      return { statusCode: 502, headers: H, body: JSON.stringify({ ok: false, step: "search_clients", status: adsRes.status, detail: adsJson, debug }) };
    }

    // searchStream returns an ARRAY of batches; each batch has a `results` array.
    const batches = Array.isArray(adsJson) ? adsJson : [];
    const accounts = batches.flatMap((b) => (b.results || [])).map((r) => {
      const c = r.customerClient || {};
      return {
        id: c.id,
        name: c.descriptiveName || null,
        currency: c.currencyCode || null,
        time_zone: c.timeZone || null,
        is_manager: !!c.manager,
        level: Number(c.level ?? 0),
        status: c.status,
        test_account: !!c.testAccount,
        resource: c.clientCustomer || null,
      };
    });

    const children = accounts.filter((a) => a.level >= 1);

    return {
      statusCode: 200,
      headers: H,
      body: JSON.stringify({
        ok: true,
        version,
        manager_customer_id: loginCid,
        total_returned: accounts.length,
        child_count: children.length,
        accounts,
        debug,
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers: H, body: JSON.stringify({ ok: false, error: String(e) }) };
  }
};
