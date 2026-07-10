// Read-only: performance metrics (cost, clicks, impressions, conversions,
// conv value) with derived CPA and ROAS, at a chosen level, over a date range.
// This is the core optimization input — "what is actually working / wasting".
//
// GET /.netlify/functions/report?customerId=9427798225
//     &level=campaign|ad_group|keyword|ad   (default campaign)
//     &days=7|14|30                         (default 30)
//     &campaignId=...                       (optional filter)
//     x-mcc-token required

const digits = (v) => String(v || "").replace(/[^0-9]/g, "");
const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const authError = (event) => {
  const s = (process.env.MCC_API_SECRET || "").trim();
  if (!s) return json(500, { ok: false, error: "Server not configured: MCC_API_SECRET is not set" });
  const p = ((event && event.headers && (event.headers["x-mcc-token"] || event.headers["X-Mcc-Token"])) || "").trim();
  if (p.length !== s.length || p !== s) return json(401, { ok: false, error: "Unauthorized: missing or invalid x-mcc-token header" });
  return null;
};

const RANGE = { "7": "LAST_7_DAYS", "14": "LAST_14_DAYS", "30": "LAST_30_DAYS" };

// Per-level: FROM resource + the identity fields to select/return.
const LEVELS = {
  campaign: {
    from: "campaign",
    fields: ["campaign.id", "campaign.name", "campaign.status"],
    label: (r) => ({ campaign_id: r.campaign?.id, name: r.campaign?.name, status: r.campaign?.status }),
  },
  ad_group: {
    from: "ad_group",
    fields: ["campaign.name", "ad_group.id", "ad_group.name", "ad_group.status"],
    label: (r) => ({ ad_group_id: r.adGroup?.id, name: r.adGroup?.name, status: r.adGroup?.status, campaign_name: r.campaign?.name }),
  },
  keyword: {
    from: "keyword_view",
    fields: ["campaign.name", "ad_group.name", "ad_group_criterion.criterion_id", "ad_group_criterion.keyword.text", "ad_group_criterion.keyword.match_type"],
    label: (r) => ({ criterion_id: r.adGroupCriterion?.criterionId, text: r.adGroupCriterion?.keyword?.text, match_type: r.adGroupCriterion?.keyword?.matchType, ad_group_name: r.adGroup?.name, campaign_name: r.campaign?.name }),
  },
  ad: {
    from: "ad_group_ad",
    fields: ["campaign.name", "ad_group.name", "ad_group_ad.ad.id", "ad_group_ad.status"],
    label: (r) => ({ ad_id: r.adGroupAd?.ad?.id, status: r.adGroupAd?.status, ad_group_name: r.adGroup?.name, campaign_name: r.campaign?.name }),
  },
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
  if (!customerId) return json(400, { ok: false, error: "Missing ?customerId=" });
  const levelKey = String(q.level || "campaign").toLowerCase();
  const level = LEVELS[levelKey];
  if (!level) return json(400, { ok: false, error: `level must be one of ${Object.keys(LEVELS).join(", ")}` });
  const during = RANGE[String(q.days || "30")] || "LAST_30_DAYS";
  const campaignId = digits(q.campaignId);

  const metrics = ["metrics.cost_micros", "metrics.impressions", "metrics.clicks", "metrics.conversions", "metrics.conversions_value"];
  let gaql = `SELECT ${[...level.fields, ...metrics].join(", ")} FROM ${level.from} WHERE segments.date DURING ${during}`;
  if (campaignId) gaql += ` AND campaign.id = ${campaignId}`;
  gaql += ` ORDER BY metrics.cost_micros DESC`;

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, refresh_token: env.refreshToken, grant_type: "refresh_token" }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) return json(502, { ok: false, step: "token_exchange", status: tokenRes.status, detail: tokenJson });

    const rows = await search(env, tokenJson.access_token, customerId, gaql);
    let totCost = 0, totConv = 0, totClicks = 0, totVal = 0;
    const items = rows.map((r) => {
      const m = r.metrics || {};
      const cost = m.costMicros ? Number(m.costMicros) / 1e6 : 0;
      const conv = Number(m.conversions || 0);
      const clicks = Number(m.clicks || 0);
      const val = Number(m.conversionsValue || 0);
      totCost += cost; totConv += conv; totClicks += clicks; totVal += val;
      return {
        ...level.label(r),
        cost: Math.round(cost * 100) / 100,
        impressions: Number(m.impressions || 0),
        clicks,
        conversions: Math.round(conv * 100) / 100,
        cost_per_conv: conv > 0 ? Math.round((cost / conv) * 100) / 100 : null,
        conv_value: Math.round(val * 100) / 100,
        roas: cost > 0 ? Math.round((val / cost) * 100) / 100 : null,
      };
    });

    return json(200, {
      ok: true, version: env.version, customerId, level: levelKey, range: during, count: items.length,
      totals: {
        cost: Math.round(totCost * 100) / 100, clicks: totClicks, conversions: Math.round(totConv * 100) / 100,
        cost_per_conv: totConv > 0 ? Math.round((totCost / totConv) * 100) / 100 : null,
        conv_value: Math.round(totVal * 100) / 100, roas: totCost > 0 ? Math.round((totVal / totCost) * 100) / 100 : null,
      },
      items,
    });
  } catch (e) {
    const status = (e && e.status) || 502;
    return json(status >= 400 && status < 600 ? status : 502, { ok: false, ...(e && typeof e === "object" ? e : { error: String(e) }) });
  }
};
