// Read the accumulated daily metrics time-series from Supabase.
//
// GET /.netlify/functions/get-metrics-history?level=campaign
//     &entityId=...   (optional: one campaign/keyword/ad)
//     &from=YYYY-MM-DD &to=YYYY-MM-DD   (optional date window)
//     &limit=  (default 2000)
//     x-mcc-token required

const json = (statusCode, obj) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });

const authError = (event) => {
  const s = (process.env.MCC_API_SECRET || "").trim();
  if (!s) return json(500, { ok: false, error: "Server not configured: MCC_API_SECRET is not set" });
  const p = ((event && event.headers && (event.headers["x-mcc-token"] || event.headers["X-Mcc-Token"])) || "").trim();
  if (p.length !== s.length || p !== s) return json(401, { ok: false, error: "Unauthorized: missing or invalid x-mcc-token header" });
  return null;
};

exports.handler = async (event) => {
  const denied = authError(event);
  if (denied) return denied;

  const supabaseUrl = (process.env.SUPABASE_URL || "").trim().replace(/\/$/, "");
  const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!supabaseUrl || !supabaseKey) return json(500, { ok: false, error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" });

  const q = event.queryStringParameters || {};
  const params = new URLSearchParams({ select: "*", order: "report_date.asc" });
  if (q.level) params.set("level", `eq.${String(q.level).toLowerCase()}`);
  if (q.entityId) params.set("entity_id", `eq.${String(q.entityId).replace(/[^0-9]/g, "")}`);
  if (q.from) params.append("report_date", `gte.${q.from}`);
  if (q.to) params.append("report_date", `lte.${q.to}`);
  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 2000;
  if (limit > 10000) limit = 10000;
  params.set("limit", String(limit));

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/metrics_daily?${params.toString()}`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) return json(502, { ok: false, step: "supabase_read", status: res.status, detail: body });
    return json(200, { ok: true, count: Array.isArray(body) ? body.length : 0, series: body });
  } catch (e) {
    return json(502, { ok: false, error: String(e) });
  }
};
