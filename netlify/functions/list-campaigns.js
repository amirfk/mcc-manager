// Read-only: list every campaign in a given account, with its status and the
// budget attached to it. This is what lets the manager "see" before it acts —
// the source of campaignId / budgetId for the `manage` endpoint.
//
// GET /.netlify/functions/list-campaigns?customerId=9427798225

const digits = (v) => String(v || "").replace(/[^0-9]/g, "");
const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const GAQL = `
  SELECT
    campaign.id,
    campaign.name,
    campaign.status,
    campaign.advertising_channel_type,
    campaign.bidding_strategy_type,
    campaign.bidding_strategy,
    campaign.target_cpa.target_cpa_micros,
    campaign.target_roas.target_roas,
    campaign.maximize_conversions.target_cpa_micros,
    campaign.maximize_conversion_value.target_roas,
    campaign_budget.id,
    campaign_budget.amount_micros
  FROM campaign
  ORDER BY campaign.name
`.trim();

const authError = (event) => {
  const s = (process.env.MCC_API_SECRET || "").trim();
  if (!s) return json(500, { ok: false, error: "Server not configured: MCC_API_SECRET is not set" });
  const p = ((event && event.headers && (event.headers["x-mcc-token"] || event.headers["X-Mcc-Token"])) || "").trim();
  if (p.length !== s.length || p !== s) return json(401, { ok: false, error: "Unauthorized: missing or invalid x-mcc-token header" });
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
    const loginCid     = digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
    const version      = (process.env.GOOGLE_ADS_API_VERSION || "v22").trim();

    const customerId = digits((event.queryStringParameters || {}).customerId);
    if (!customerId) return json(400, { ok: false, error: "Missing ?customerId=" });

    // 1) refresh token -> access token
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) return { statusCode: 502, headers: H, body: JSON.stringify({ ok: false, step: "token_exchange", status: tokenRes.status, detail: tokenJson }) };

    // 2) list campaigns (read-only)
    const url = `https://googleads.googleapis.com/${version}/customers/${customerId}/googleAds:searchStream`;
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
    let adsJson; try { adsJson = JSON.parse(adsText); } catch { adsJson = adsText; }
    if (!adsRes.ok) return { statusCode: 502, headers: H, body: JSON.stringify({ ok: false, step: "search_campaigns", status: adsRes.status, detail: adsJson }) };

    const batches = Array.isArray(adsJson) ? adsJson : [];
    const campaigns = batches.flatMap((b) => b.results || []).map((r) => {
      const c = r.campaign || {};
      const b = r.campaignBudget || {};
      const tcpaMicros = c.targetCpa?.targetCpaMicros ?? c.maximizeConversions?.targetCpaMicros ?? null;
      const troas = c.targetRoas?.targetRoas ?? c.maximizeConversionValue?.targetRoas ?? null;
      return {
        campaign_id: c.id,
        name: c.name || null,
        status: c.status,
        channel: c.advertisingChannelType || null,
        bidding_strategy_type: c.biddingStrategyType || null,
        portfolio_strategy: c.biddingStrategy || null, // set = shared/portfolio strategy (edit on the strategy, not the campaign)
        target_cpa: tcpaMicros != null ? Number(tcpaMicros) / 1e6 : null,
        target_roas: troas != null ? Number(troas) : null,
        budget_id: b.id || null,
        daily_budget: b.amountMicros ? Number(b.amountMicros) / 1e6 : null,
      };
    });

    return json(200, { ok: true, version, customerId, count: campaigns.length, campaigns });
  } catch (e) {
    return json(502, { ok: false, error: String(e) });
  }
};
