// Read-only: the "where is the money going / what are we missing" splits.
//
//   impression_share  — how much of the available auction you're winning, and
//                       whether you lose the rest to BUDGET or to RANK (bid/quality).
//   device            — mobile / desktop / tablet performance.
//   network           — Google Search vs Search Partners vs Display/YouTube (PMax = MIXED).
//   geo               — where clicks actually came from, split by physical presence
//                       vs. interest. The tool for catching out-of-area spend.
//   auction_insights  — competitor overlap. Google restricts these metrics to
//                       allowlisted developer tokens; when refused, this returns
//                       available:false + the UI workaround instead of failing.
//
// GET /.netlify/functions/report-splits?customerId=4594075026
//     &type=all|impression_share|device|network|geo|auction_insights   (default all)
//     &days=7|14|30  OR  &from=YYYY-MM-DD&to=YYYY-MM-DD                 (default 30)
//     &campaignId=...                       (optional filter, every type)
//     &level=campaign|ad_group|keyword      (impression_share only; default campaign)
//     &geo=country|region|city              (geo only; default region)
//     &limit=100                            (geo only; top N locations by cost)
//   x-mcc-token required.
//
// Each type runs independently: with type=all, one failing split returns
// { ok:false, error } inside its own key and never blocks the others.
// Impression-share fields are fractions 0..1. Google reports "<10%" as 0.0999
// and caps the top end at 0.9; treat those as "<10%" / ">90%".

const digits = (v) => String(v || "").replace(/[^0-9]/g, "");
const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const r4 = (n) => (n == null || n === "" ? null : Math.round(Number(n) * 10000) / 10000);

const authError = (event) => {
  const s = (process.env.MCC_API_SECRET || "").trim();
  if (!s) return json(500, { ok: false, error: "Server not configured: MCC_API_SECRET is not set" });
  const p = ((event && event.headers && (event.headers["x-mcc-token"] || event.headers["X-Mcc-Token"])) || "").trim();
  if (p.length !== s.length || p !== s) return json(401, { ok: false, error: "Unauthorized: missing or invalid x-mcc-token header" });
  return null;
};

const RANGE = { "7": "LAST_7_DAYS", "14": "LAST_14_DAYS", "30": "LAST_30_DAYS" };
const TYPES = ["impression_share", "device", "network", "geo", "auction_insights"];

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

// Pull a readable message out of a Google Ads error (array or object form).
function errMsg(e) {
  const d = e && e.detail;
  const one = Array.isArray(d) ? d[0] : d;
  const g = one && one.error;
  const inner = g && g.details && g.details[0] && g.details[0].errors && g.details[0].errors[0];
  return (inner && inner.message) || (g && g.message) || (e && e.message) || String(e);
}
function errCode(e) {
  const d = e && e.detail; const one = Array.isArray(d) ? d[0] : d;
  const inner = one && one.error && one.error.details && one.error.details[0] && one.error.details[0].errors && one.error.details[0].errors[0];
  return inner && inner.errorCode ? JSON.stringify(inner.errorCode) : null;
}

// Shared metric block + aggregation helpers.
const BASE_METRICS = ["metrics.impressions", "metrics.clicks", "metrics.cost_micros", "metrics.conversions", "metrics.conversions_value"];
function perf(m = {}) {
  const cost = m.costMicros ? Number(m.costMicros) / 1e6 : 0;
  const conv = Number(m.conversions || 0);
  const clicks = Number(m.clicks || 0);
  const impr = Number(m.impressions || 0);
  return { impressions: impr, clicks, cost, conversions: conv, conv_value: Number(m.conversionsValue || 0) };
}
function finish(o, totalCost) {
  return {
    ...o,
    cost: r2(o.cost),
    conversions: r2(o.conversions),
    conv_value: r2(o.conv_value),
    ctr: o.impressions > 0 ? r4(o.clicks / o.impressions) : null,
    cpc: o.clicks > 0 ? r2(o.cost / o.clicks) : null,
    cost_per_conv: o.conversions > 0 ? r2(o.cost / o.conversions) : null,
    conv_rate: o.clicks > 0 ? r4(o.conversions / o.clicks) : null,
    share_of_cost: totalCost > 0 ? r4(o.cost / totalCost) : null,
  };
}
function addInto(acc, p) {
  acc.impressions += p.impressions; acc.clicks += p.clicks; acc.cost += p.cost;
  acc.conversions += p.conversions; acc.conv_value += p.conv_value; return acc;
}
const zero = () => ({ impressions: 0, clicks: 0, cost: 0, conversions: 0, conv_value: 0 });

// ---------- impression share ----------
const IS_LEVELS = {
  campaign: {
    from: "campaign",
    id: ["campaign.id", "campaign.name", "campaign.advertising_channel_type"],
    label: (r) => ({ campaign_id: r.campaign?.id, name: r.campaign?.name, channel: r.campaign?.advertisingChannelType }),
    full: ["search_impression_share", "search_budget_lost_impression_share", "search_rank_lost_impression_share",
           "search_top_impression_share", "search_absolute_top_impression_share", "search_exact_match_impression_share",
           "search_budget_lost_top_impression_share", "search_rank_lost_top_impression_share",
           "content_impression_share", "content_budget_lost_impression_share", "content_rank_lost_impression_share"],
    min: ["search_impression_share", "search_budget_lost_impression_share", "search_rank_lost_impression_share"],
  },
  ad_group: {
    from: "ad_group",
    id: ["campaign.name", "ad_group.id", "ad_group.name"],
    label: (r) => ({ ad_group_id: r.adGroup?.id, name: r.adGroup?.name, campaign_name: r.campaign?.name }),
    full: ["search_impression_share", "search_rank_lost_impression_share", "search_top_impression_share",
           "search_absolute_top_impression_share", "search_exact_match_impression_share"],
    min: ["search_impression_share", "search_rank_lost_impression_share"],
  },
  keyword: {
    from: "keyword_view",
    id: ["campaign.name", "ad_group.name", "ad_group_criterion.criterion_id", "ad_group_criterion.keyword.text", "ad_group_criterion.keyword.match_type"],
    label: (r) => ({ criterion_id: r.adGroupCriterion?.criterionId, text: r.adGroupCriterion?.keyword?.text,
                     match_type: r.adGroupCriterion?.keyword?.matchType, ad_group_name: r.adGroup?.name, campaign_name: r.campaign?.name }),
    full: ["search_impression_share", "search_rank_lost_impression_share", "search_top_impression_share",
           "search_absolute_top_impression_share", "search_exact_match_impression_share"],
    min: ["search_impression_share", "search_rank_lost_impression_share"],
  },
};
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

async function impressionShare(ctx) {
  const L = IS_LEVELS[ctx.level];
  if (!L) return { ok: false, error: `level must be one of ${Object.keys(IS_LEVELS).join(", ")}` };
  const build = (set) => {
    let g = `SELECT ${[...L.id, ...BASE_METRICS, ...set.map((f) => "metrics." + f)].join(", ")} FROM ${L.from} WHERE ${ctx.range} AND metrics.impressions > 0`;
    if (ctx.level === "campaign") g += ` AND campaign.status != 'REMOVED'`;
    if (ctx.campaignId) g += ` AND campaign.id = ${ctx.campaignId}`;
    return g + " ORDER BY metrics.cost_micros DESC";
  };
  let set = L.full, rows, fellBack = null;
  try { rows = await search(ctx.env, ctx.access, ctx.customerId, build(set)); }
  catch (e) {
    // Some metric/resource combos are rejected on some accounts — retry with the core set.
    fellBack = errMsg(e); set = L.min;
    rows = await search(ctx.env, ctx.access, ctx.customerId, build(set));
  }
  const total = rows.reduce((t, r) => t + perf(r.metrics).cost, 0);
  const items = rows.map((r) => {
    const out = { ...L.label(r), ...finish(perf(r.metrics), total) };
    for (const f of set) out[f] = r4(r.metrics?.[camel(f)]);
    // Plain-English read of where the lost share went (campaign level only).
    if (ctx.level === "campaign" && out.search_impression_share != null) {
      const b = out.search_budget_lost_impression_share || 0, k = out.search_rank_lost_impression_share || 0;
      out.diagnosis = b > 0.1 && b >= k ? "losing mostly to BUDGET"
                    : k > 0.1 ? "losing mostly to RANK (bid / ad rank / quality)"
                    : "winning most eligible auctions";
    }
    return out;
  });
  return { ok: true, level: ctx.level, metrics: set, ...(fellBack ? { note: `full metric set refused, fell back to core set: ${fellBack}` } : {}), count: items.length, items };
}

// ---------- device / network ----------
async function segmentSplit(ctx, segField, key) {
  let g = `SELECT campaign.id, campaign.name, campaign.advertising_channel_type, segments.${segField}, ${BASE_METRICS.join(", ")} FROM campaign WHERE ${ctx.range} AND metrics.impressions > 0`;
  if (ctx.campaignId) g += ` AND campaign.id = ${ctx.campaignId}`;
  const rows = await search(ctx.env, ctx.access, ctx.customerId, g);
  const segCamel = camel(segField);
  const byKey = {}, byCampaign = {};
  let total = 0;
  for (const r of rows) {
    const p = perf(r.metrics); total += p.cost;
    const k = r.segments?.[segCamel] || "UNKNOWN";
    addInto(byKey[k] || (byKey[k] = zero()), p);
    const cn = r.campaign?.name || r.campaign?.id;
    const c = byCampaign[cn] || (byCampaign[cn] = { campaign_id: r.campaign?.id, channel: r.campaign?.advertisingChannelType, splits: {} });
    addInto(c.splits[k] || (c.splits[k] = zero()), p);
  }
  const totals = Object.entries(byKey).map(([k, v]) => ({ [key]: k, ...finish(v, total) })).sort((a, b) => b.cost - a.cost);
  const campaigns = Object.entries(byCampaign).map(([name, c]) => {
    const ct = Object.values(c.splits).reduce((t, v) => t + v.cost, 0);
    return { campaign: name, campaign_id: c.campaign_id, channel: c.channel,
             splits: Object.entries(c.splits).map(([k, v]) => ({ [key]: k, ...finish(v, ct) })).sort((a, b) => b.cost - a.cost) };
  });
  return { ok: true, totals, by_campaign: campaigns };
}

// ---------- geo ----------
async function geo(ctx) {
  const gran = ["country", "region", "city"].includes(ctx.geo) ? ctx.geo : "region";
  const seg = gran === "region" ? "segments.geo_target_region" : gran === "city" ? "segments.geo_target_city" : null;
  let g = `SELECT geographic_view.country_criterion_id, geographic_view.location_type, ${seg ? seg + ", " : ""}${BASE_METRICS.join(", ")} FROM geographic_view WHERE ${ctx.range} AND metrics.impressions > 0`;
  if (ctx.campaignId) g += ` AND campaign.id = ${ctx.campaignId}`;
  const rows = await search(ctx.env, ctx.access, ctx.customerId, g);

  const agg = {}; let total = 0;
  for (const r of rows) {
    const p = perf(r.metrics); total += p.cost;
    const gv = r.geographicView || {};
    const locRes = seg ? (r.segments?.[gran === "region" ? "geoTargetRegion" : "geoTargetCity"] || "") : `geoTargetConstants/${gv.countryCriterionId}`;
    const locId = String(locRes).split("/")[1] || "unknown";
    const k = `${locId}|${gv.locationType || "UNKNOWN"}`;
    const a = agg[k] || (agg[k] = { geo_target_constant_id: locId, country_id: gv.countryCriterionId || null, location_type: gv.locationType || null, ...zero() });
    addInto(a, p);
  }
  let items = Object.values(agg).sort((a, b) => b.cost - a.cost);
  const truncated = items.length > ctx.limit; items = items.slice(0, ctx.limit);

  // Resolve readable names (same query pattern as list-locations).
  const ids = [...new Set(items.flatMap((i) => [i.geo_target_constant_id, i.country_id]).map(digits).filter(Boolean))];
  const names = {};
  if (ids.length) {
    try {
      const gc = await search(ctx.env, ctx.access, ctx.customerId,
        `SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.canonical_name, geo_target_constant.target_type FROM geo_target_constant WHERE geo_target_constant.id IN (${ids.join(",")})`);
      for (const x of gc) { const c = x.geoTargetConstant || {}; names[String(c.id)] = { name: c.name, canonical: c.canonicalName, type: c.targetType }; }
    } catch (_) { /* names are a nicety; never fail the split over them */ }
  }
  items = items.map((i) => ({
    location: names[i.geo_target_constant_id]?.canonical || names[i.geo_target_constant_id]?.name || i.geo_target_constant_id,
    location_kind: names[i.geo_target_constant_id]?.type || gran.toUpperCase(),
    country: names[String(i.country_id)]?.name || i.country_id,
    location_type: i.location_type,
    geo_target_constant_id: i.geo_target_constant_id,
    ...finish(i, total),
  }));
  return {
    ok: true, granularity: gran, count: items.length, truncated,
    note: "location_type LOCATION_OF_PRESENCE = user was physically there; AREA_OF_INTEREST = user searched about it from elsewhere. Spend under AREA_OF_INTEREST outside your market is the usual geo leak.",
    items,
  };
}

// ---------- auction insights (usually restricted) ----------
async function auctionInsights(ctx) {
  const fields = ["auction_insight_search_impression_share", "auction_insight_search_overlap_rate", "auction_insight_search_outranking_share",
                  "auction_insight_search_position_above_rate", "auction_insight_search_top_impression_percentage",
                  "auction_insight_search_absolute_top_impression_percentage"];
  let g = `SELECT segments.auction_insight_domain, ${fields.map((f) => "metrics." + f).join(", ")} FROM campaign WHERE ${ctx.range}`;
  if (ctx.campaignId) g += ` AND campaign.id = ${ctx.campaignId}`;
  try {
    const rows = await search(ctx.env, ctx.access, ctx.customerId, g);
    const items = rows.map((r) => {
      const o = { domain: r.segments?.auctionInsightDomain || null };
      for (const f of fields) o[f.replace("auction_insight_search_", "")] = r4(r.metrics?.[camel(f)]);
      return o;
    });
    return { ok: true, available: true, count: items.length, items };
  } catch (e) {
    return {
      ok: true, available: false,
      reason: "Google Ads API refused auction-insight metrics. They are restricted to allowlisted developer tokens.",
      google_error: errMsg(e), google_error_code: errCode(e),
      workaround: "Google Ads UI -> Campaigns -> Insights and reports -> Auction insights -> Download CSV, then save it as data\\<account>\\auction-insights.csv for analysis.",
    };
  }
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

  const type = String(q.type || "all").toLowerCase();
  const wanted = type === "all" ? TYPES : [type];
  if (!wanted.every((t) => TYPES.includes(t))) return json(400, { ok: false, error: `type must be all or one of ${TYPES.join(", ")}` });

  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
  const from = isDate(q.from) ? q.from : null, to = isDate(q.to) ? q.to : null;
  const during = RANGE[String(q.days || "30")] || "LAST_30_DAYS";
  const range = from && to ? `segments.date BETWEEN '${from}' AND '${to}'` : `segments.date DURING ${during}`;

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, refresh_token: env.refreshToken, grant_type: "refresh_token" }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) return json(502, { ok: false, step: "token_exchange", status: tokenRes.status, detail: tokenJson });

    const ctx = {
      env, access: tokenJson.access_token, customerId, range,
      campaignId: digits(q.campaignId),
      level: String(q.level || "campaign").toLowerCase(),
      geo: String(q.geo || "region").toLowerCase(),
      limit: Math.max(1, Math.min(500, Number(q.limit) || 100)),
    };
    const run = {
      impression_share: () => impressionShare(ctx),
      device: () => segmentSplit(ctx, "device", "device"),
      network: () => segmentSplit(ctx, "ad_network_type", "network"),
      geo: () => geo(ctx),
      auction_insights: () => auctionInsights(ctx),
    };

    const out = {};
    for (const t of wanted) {
      try { out[t] = await run[t](); }
      catch (e) { out[t] = { ok: false, error: errMsg(e), error_code: errCode(e), status: e && e.status }; }
    }
    return json(200, { ok: true, version: env.version, customerId, range: from && to ? `${from}..${to}` : during, ...out });
  } catch (e) {
    const status = (e && e.status) || 502;
    return json(status >= 400 && status < 600 ? status : 502, { ok: false, ...(e && typeof e === "object" ? e : { error: String(e) }) });
  }
};
