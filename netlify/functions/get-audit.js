// Read-only: return the audit history of applied changes from Supabase.
// This is the "tell you what it did" half of the loop.
//
// GET /.netlify/functions/get-audit
//   ?limit=50            (default 50, max 200)
//   &customerId=9427...  (optional: filter to one sub-account)

const digits = (v) => String(v || "").replace(/[^0-9]/g, "");
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
  if (!supabaseUrl || !supabaseKey) {
    return json(500, { ok: false, error: "Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" });
  }

  const q = (event.queryStringParameters || {});
  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 200) limit = 200;
  const customerId = digits(q.customerId);

  const params = new URLSearchParams({ select: "*", order: "ts.desc", limit: String(limit) });
  if (customerId) params.set("customer_id", `eq.${customerId}`);

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/audit_log?${params.toString()}`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) return json(502, { ok: false, step: "supabase_read", status: res.status, detail: body });
    return json(200, { ok: true, count: Array.isArray(body) ? body.length : 0, entries: body });
  } catch (e) {
    return json(502, { ok: false, error: String(e) });
  }
};
