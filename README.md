# mcc-manager

Server-side tooling to read (and eventually manage) Google Ads accounts under a
Manager Account (MCC). Runs as **Netlify Functions** so calls originate from a
clean server IP — the Google Ads API is region-blocked from some local machines.

Everything shipped so far is **read-only**. Nothing here can spend money, change
budgets/bids, or create/pause campaigns.

## Endpoints

| Function | Method | What it does |
|----------|--------|--------------|
| `/.netlify/functions/list-accounts` | GET | Health check. Refreshes the OAuth token and calls `customers:listAccessibleCustomers`. Proves the OAuth + developer-token + clean-IP path works. Returns bare customer IDs only. |
| `/.netlify/functions/list-clients` | GET | Enumerates the child accounts under the MCC via a `customer_client` GAQL query (`googleAds:searchStream`). Returns id, name, currency, timezone, manager flag, level, and status. |
| `/.netlify/functions/manage` | POST | **Write.** The check-then-do management loop. Defaults to a dry run; only mutates when `confirm:true`. Logs every applied change to Supabase. See below. |
| `/.netlify/functions/get-audit` | GET | Read the audit history of applied changes (`?limit=`, `?customerId=`). |

## Management engine (`manage`) — the check-then-do loop

`manage` is the one endpoint that changes things. It is built so a change is
never silent:

1. **Dry run by default.** Without `confirm:true`, every call runs with the
   Google Ads `validateOnly:true` flag — the API validates the change and
   returns a preview, but **nothing is modified**.
2. **MCC guardrail.** Before any mutation, the target `customerId` is verified
   to sit under MCC `3174788660` (via `customer_client`). An account outside the
   hierarchy is refused with a 403 — the tool physically cannot touch accounts
   that aren't yours.
3. **Old → new preview.** The current value is read first, so the dry-run
   response shows exactly what would change.
4. **Audit record** written to Supabase on every applied change, and returned
   in the response. If the Supabase write fails, the response still reports the
   change as applied and flags `audit_persisted:false` — a logging failure never
   hides a real change. Read the history back via `get-audit`.

**Setup:** run `supabase/audit_log.sql` once in your Supabase project, then set
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Netlify.

The intended flow: send without `confirm` → review the `preview` → resend the
identical body with `confirm:true` to apply.

### Actions

```jsonc
// Pause / enable a campaign
POST /.netlify/functions/manage
{ "action": "set_campaign_status", "customerId": "9427798225",
  "campaignId": "1234567890", "status": "PAUSED" }   // ENABLED | PAUSED | REMOVED

// Change a daily budget (amount in DOLLARS; converted to micros internally)
POST /.netlify/functions/manage
{ "action": "update_campaign_budget", "customerId": "9427798225",
  "budgetId": "1234567890", "amount": 50.00 }

// Add "confirm": true to any of the above to actually apply it.
```

Planned next actions (same harness): bid adjustments, ad group pause/enable,
campaign/ad creation.

Both return `{ ok: true, ... }` on success, or `{ ok: false, step, status, detail, debug }`
on failure. `debug` includes **masked** (never full) fingerprints of the developer
token and login customer id to diagnose auth issues without exposing secrets.

## Required environment variables (set in Netlify, never committed)

| Var | Notes |
|-----|-------|
| `GOOGLE_ADS_CLIENT_ID` | OAuth client id (`…apps.googleusercontent.com`). |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth client secret. |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | Refresh token with the `adwords` scope. |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads API developer token. |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | The MCC / manager customer id (digits; hyphens stripped automatically). |
| `GOOGLE_ADS_API_VERSION` | Optional. Defaults to `v22`. |
| `SUPABASE_URL` | Supabase project URL, for the audit log. |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key. **Server-side only** — bypasses row security; never expose to a browser. |

> The `adwords` OAuth scope already covers write access — no new scope is needed
> when management endpoints are added later. Any write tooling must be gated
> behind `validateOnly` dry-runs and explicit confirmation before it spends.

## Local structure

```
netlify/
  functions/
    list-accounts.js   # P0 read-only health check
    list-clients.js    # child-account enumeration (customer_client)
netlify.toml           # functions dir + esbuild bundler
```
