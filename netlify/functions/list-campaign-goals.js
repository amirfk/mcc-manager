// Read-only: which conversion GOALS each campaign bids toward. In Google's
// model a campaign optimizes toward conversion-action *categories* whose goal is
// "biddable" — set at account level (customer_conversion_goal) or overridden per
// campaign (campaign_conversion_goal). Cross-reference the biddable categories
// with list-conversion-actions to see the actual events behind each campaign.
//
// GET /.netlify/functions/list-campaign-goals?customerId=9427798225   (x-mcc-token required)

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

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, refresh_token: env.refreshToken, grant_type: "refresh_token" }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) return json(502, { ok: false, step: "token_exchange", status: tokenRes.status, detail: tokenJson });
    const access = tokenJson.access_token;

    const [custRows, campRows] = await Promise.all([
      search(env, access, customerId,
        "SELECT customer_conversion_goal.category, customer_conversion_goal.origin, customer_conversion_goal.biddable FROM customer_conversion_goal"),
      search(env, access, customerId,
        "SELECT campaign.id, campaign.name, campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable FROM campaign_conversion_goal"),
    ]);

    const account_default_goals = custRows.map((r) => ({
      category: r.customerConversionGoal?.category,
      origin: r.customerConversionGoal?.origin,
      biddable: r.customerConversionGoal?.biddable ?? null,
    }));

    // Group per-campaign goals; keep only the biddable=true ones as the "what it bids toward".
    const byCampaign = {};
    for (const r of campRows) {
      const id = r.campaign?.id;
      if (!id) continue;
      if (!byCampaign[id]) byCampaign[id] = { campaign_id: id, campaign_name: r.campaign?.name || null, biddable_categories: [], all_goals: [] };
      const g = { category: r.campaignConversionGoal?.category, origin: r.campaignConversionGoal?.origin, biddable: r.campaignConversionGoal?.biddable ?? null };
      byCampaign[id].all_goals.push(g);
      if (g.biddable) byCampaign[id].biddable_categories.push(g.category);
    }

    return json(200, {
      ok: true, version: env.version, customerId,
      note: "Bidding counts conversion actions whose (category, origin) is biddable. Campaign goals override account defaults. Cross-reference biddable_categories with list-conversion-actions categories to see the actual events.",
      account_default_goals,
      campaigns: Object.values(byCampaign),
    });
  } catch (e) {
    const status = (e && e.status) || 502;
    return json(status >= 400 && status < 600 ? status : 502, { ok: false, ...(e && typeof e === "object" ? e : { error: String(e) }) });
  }
};
