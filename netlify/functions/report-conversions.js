// Read-only: performance SEGMENTED BY CONVERSION ACTION.
//
// This is the blind spot the campaign/ad-group/keyword reports can't cover:
// "how many conversions did ad-pilot Booked Patient actually record, and what
// real value came with them?" It also shows, per action, whether it is still
// PRIMARY (i.e. feeding bidding) - which is how you catch junk local-action
// goals inflating the conversion count.
//
// GET /.netlify/functions/report-conversions?customerId=9427798225
//        [&from=2026-08-01&to=2026-08-31]   (custom range)
//        [&during=LAST_30_DAYS]             (default when from/to absent)
//        [&byCampaign=1]                    (add per-campaign breakdown)
//   (x-mcc-token required)
//
// NOTE: uses metrics.all_conversions / all_conversions_value on purpose.
// metrics.conversions only counts actions in the biddable goal set, so a
// SECONDARY action would read as zero and you'd never see it.

const digits = (v) => String(v || "").replace(/[^0-9]/g, "");
const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
const num = (v) => (v == null ? 0 : Number(v));
const money = (v) => Math.round(num(v) * 100) / 100;

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

  const from = (q.from || "").trim();
  const to = (q.to || "").trim();
  const during = (q.during || "LAST_30_DAYS").trim().toUpperCase();
  const byCampaign = q.byCampaign === "1" || q.byCampaign === "true";

  if ((from || to) && !(DATE_RE.test(from) && DATE_RE.test(to))) {
    return json(400, { ok: false, error: "from/to must both be YYYY-MM-DD" });
  }
  if (!/^[A-Z_0-9]+$/.test(during)) return json(400, { ok: false, error: "Invalid 'during' literal" });

  const useRange = DATE_RE.test(from) && DATE_RE.test(to);
  const rangeClause = useRange ? `segments.date BETWEEN '${from}' AND '${to}'` : `segments.date DURING ${during}`;
  const rangeLabel = useRange ? `${from}..${to}` : during;

  const metricsGaql = `
    SELECT campaign.id, campaign.name,
      segments.conversion_action_name, segments.conversion_action_category,
      metrics.all_conversions, metrics.all_conversions_value
    FROM campaign
    WHERE ${rangeClause}
  `.trim();

  const actionsGaql = `
    SELECT conversion_action.name, conversion_action.primary_for_goal,
      conversion_action.status, conversion_action.type,
      conversion_action.value_settings.default_value,
      conversion_action.value_settings.always_use_default_value
    FROM conversion_action
  `.trim();

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.clientId, client_secret: env.clientSecret, refresh_token: env.refreshToken, grant_type: "refresh_token" }),
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) return json(502, { ok: false, step: "token_exchange", status: tokenRes.status, detail: tokenJson });
    const access = tokenJson.access_token;

    const [rows, actionRows] = await Promise.all([
      search(env, access, customerId, metricsGaql),
      search(env, access, customerId, actionsGaql),
    ]);

    // name -> config (primary flag, default value, type)
    const cfg = {};
    for (const r of actionRows) {
      const c = r.conversionAction || {};
      const vs = c.valueSettings || {};
      if (!c.name) continue;
      cfg[c.name] = {
        primary_for_goal: c.primaryForGoal ?? null,
        status: c.status || null,
        type: c.type || null,
        default_value: vs.defaultValue != null ? Number(vs.defaultValue) : null,
        always_use_default_value: vs.alwaysUseDefaultValue ?? null,
      };
    }

    // aggregate by conversion action
    const agg = {};
    for (const r of rows) {
      const s = r.segments || {};
      const name = s.conversionActionName;
      if (!name) continue;
      const conv = num(r.metrics?.allConversions);
      const val = num(r.metrics?.allConversionsValue);
      if (!agg[name]) {
        agg[name] = { conversion_action: name, category: s.conversionActionCategory || null, conversions: 0, conv_value: 0, by_campaign: {} };
      }
      agg[name].conversions += conv;
      agg[name].conv_value += val;
      if (byCampaign) {
        const cn = r.campaign?.name || "(unknown)";
        if (!agg[name].by_campaign[cn]) agg[name].by_campaign[cn] = { conversions: 0, conv_value: 0 };
        agg[name].by_campaign[cn].conversions += conv;
        agg[name].by_campaign[cn].conv_value += val;
      }
    }

    const items = Object.values(agg).map((a) => {
      const c = cfg[a.conversion_action] || {};
      const conversions = Math.round(a.conversions * 100) / 100;
      const conv_value = money(a.conv_value);
      const out = {
        conversion_action: a.conversion_action,
        category: a.category,
        primary_for_goal: c.primary_for_goal ?? null,
        counts_toward_bidding: c.primary_for_goal === true,
        type: c.type ?? null,
        default_value: c.default_value ?? null,
        always_use_default_value: c.always_use_default_value ?? null,
        conversions,
        conv_value,
        avg_value: conversions > 0 ? money(conv_value / conversions) : null,
      };
      if (byCampaign) {
        out.by_campaign = Object.entries(a.by_campaign)
          .map(([name, v]) => ({ campaign: name, conversions: Math.round(v.conversions * 100) / 100, conv_value: money(v.conv_value) }))
          .sort((x, y) => y.conv_value - x.conv_value);
      }
      return out;
    }).sort((x, y) => y.conv_value - x.conv_value || y.conversions - x.conversions);

    const primary = items.filter((i) => i.counts_toward_bidding);
    const secondary = items.filter((i) => !i.counts_toward_bidding);
    const sum = (arr, k) => money(arr.reduce((t, i) => t + i[k], 0));

    return json(200, {
      ok: true,
      version: env.version,
      customerId,
      range: rangeLabel,
      note: "all_conversions / all_conversions_value (includes SECONDARY actions, which metrics.conversions hides). 'counts_toward_bidding' = action is PRIMARY.",
      totals: {
        conversions: sum(items, "conversions"),
        conv_value: sum(items, "conv_value"),
        primary_conversions: sum(primary, "conversions"),
        primary_conv_value: sum(primary, "conv_value"),
        secondary_conversions: sum(secondary, "conversions"),
        secondary_conv_value: sum(secondary, "conv_value"),
      },
      count: items.length,
      conversion_actions: items,
    });
  } catch (e) {
    const status = (e && e.status) || 502;
    return json(status >= 400 && status < 600 ? status : 502, { ok: false, ...(e && typeof e === "object" ? e : { error: String(e) }) });
  }
};
