// Scheduled (daily) snapshot — runs on Netlify's cron, no client needed.
// Pulls the last 7 days of date-segmented metrics for each level and upserts
// into Supabase metrics_daily. Re-pulling recent days catches late-attributed
// conversions. Not auth-gated (cron-triggered, read-only + writes only metrics).
//
// Schedule is set in netlify.toml under [functions."scheduled-snapshot"].
// Accounts default to Kings Dental; override with SNAPSHOT_CUSTOMER_IDS (CSV).

const digits = (v) => String(v || "").replace(/[^0-9]/g, "");

const LEVELS = {
  campaign: { from: "campaign", idFields: "campaign.id, campaign.name",
    row: (r) => ({ entity_id: r.campaign?.id, entity_name: r.campaign?.name, campaign_id: r.campaign?.id, campaign_name: r.campaign?.name }) },
  ad_group: { from: "ad_group", idFields: "campaign.id, campaign.name, ad_group.id, ad_group.name",
    row: (r) => ({ entity_id: r.adGroup?.id, entity_name: r.adGroup?.name, campaign_id: r.campaign?.id, campaign_name: r.campaign?.name }) },
  keyword: { from: "keyword_view", idFields: "campaign.name, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text",
    row: (r) => ({ entity_id: r.adGroupCriterion?.criterionId, entity_name: r.adGroupCriterion?.keyword?.text, campaign_id: null, campaign_name: r.campaign?.name }) },
  ad: { from: "ad_group_ad", idFields: "campaign.name, ad_group.name, ad_group_ad.ad.id",
    row: (r) => ({ entity_id: r.adGroupAd?.ad?.id, entity_name: r.adGroup?.name, campaign_id: null, campaign_name: r.campaign?.name }) },
};

async function accessToken(env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, refresh_token: env.refreshToken, grant_type: "refresh_token" }),
  });
  const b = await res.json();
  if (!res.ok) throw new Error("token_exchange: " + JSON.stringify(b));
  return b.access_token;
}

async function search(env, access, customerId, query) {
  const res = await fetch(`https://googleads.googleapis.com/${env.version}/customers/${customerId}/googleAds:searchStream`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "developer-token": env.devToken, "login-customer-id": env.loginCid, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  let b; try { b = JSON.parse(text); } catch { b = text; }
  if (!res.ok) throw new Error("search: " + JSON.stringify(b));
  return (Array.isArray(b) ? b : []).flatMap((x) => x.results || []);
}

async function upsert(env, rows) {
  if (!rows.length) return 0;
  const res = await fetch(`${env.supabaseUrl}/rest/v1/metrics_daily?on_conflict=report_date,level,entity_id`, {
    method: "POST",
    headers: { apikey: env.supabaseKey, Authorization: `Bearer ${env.supabaseKey}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error("supabase upsert " + res.status + ": " + (await res.text()));
  return rows.length;
}

exports.handler = async () => {
  const env = {
    clientId: (process.env.GOOGLE_ADS_CLIENT_ID || "").trim(),
    clientSecret: (process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim(),
    refreshToken: (process.env.GOOGLE_OAUTH_REFRESH_TOKEN || "").trim(),
    devToken: (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim(),
    loginCid: digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
    version: (process.env.GOOGLE_ADS_API_VERSION || "v22").trim(),
    supabaseUrl: (process.env.SUPABASE_URL || "").trim().replace(/\/$/, ""),
    supabaseKey: (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim(),
  };
  const customerIds = (process.env.SNAPSHOT_CUSTOMER_IDS || "9427798225").split(",").map(digits).filter(Boolean);
  const summary = [];

  try {
    const access = await accessToken(env);
    for (const cid of customerIds) {
      for (const [levelKey, level] of Object.entries(LEVELS)) {
        try {
          const gaql = `SELECT ${level.idFields}, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM ${level.from} WHERE segments.date DURING LAST_7_DAYS`;
          const results = await search(env, access, cid, gaql);
          const rows = results.map((r) => {
            const m = r.metrics || {}; const base = level.row(r);
            return {
              report_date: r.segments?.date, level: levelKey, entity_id: String(base.entity_id ?? ""),
              entity_name: base.entity_name || null, campaign_id: base.campaign_id ? String(base.campaign_id) : null, campaign_name: base.campaign_name || null,
              cost: m.costMicros ? Number(m.costMicros) / 1e6 : 0, impressions: Number(m.impressions || 0), clicks: Number(m.clicks || 0),
              conversions: Number(m.conversions || 0), conv_value: Number(m.conversionsValue || 0),
            };
          }).filter((r) => r.report_date && r.entity_id);
          const n = await upsert(env, rows);
          summary.push(`${cid}/${levelKey}: ${n}`);
        } catch (e) { summary.push(`${cid}/${levelKey}: ERR ${e.message}`); }
      }
    }
    console.log("scheduled-snapshot:", summary.join(" | "));
    return { statusCode: 200, body: JSON.stringify({ ok: true, summary }) };
  } catch (e) {
    console.error("scheduled-snapshot failed:", e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(e) }) };
  }
};
