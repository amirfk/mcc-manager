# mcc-manager

Server-side tooling to read (and eventually manage) Google Ads accounts under a
Manager Account (MCC). Runs as **Netlify Functions** so calls originate from a
clean server IP — the Google Ads API is region-blocked from some local machines.

Everything shipped so far is **read-only** except `manage`. Nothing but `manage`
can spend money, change budgets/bids, or create/pause campaigns.

**All endpoints require auth:** every call must send an `x-mcc-token` header
matching `MCC_API_SECRET`, or it returns 401. GET endpoints can no longer be
tested from a browser address bar — use a client that sends the header.

## Endpoints

| Function | Method | What it does |
|----------|--------|--------------|
| `/.netlify/functions/list-accounts` | GET | Health check. Refreshes the OAuth token and calls `customers:listAccessibleCustomers`. Proves the OAuth + developer-token + clean-IP path works. Returns bare customer IDs only. |
| `/.netlify/functions/list-clients` | GET | Enumerates the child accounts under the MCC via a `customer_client` GAQL query (`googleAds:searchStream`). Returns id, name, currency, timezone, manager flag, level, and status. |
| `/.netlify/functions/list-campaigns` | GET | Lists every campaign in an account (`?customerId=`) with status, budget id, and daily budget. Source of ids for `manage`. |
| `/.netlify/functions/list-adgroups` | GET | Lists ad groups and asset groups in an account (`?customerId=`) with status and parent campaign. Source of ad/asset group ids for `manage`. |
| `/.netlify/functions/list-keywords` | GET | Lists all keywords in an account (`?customerId=`, optional `&campaignId=`) with match type, status, and criterion id. Source of ids for keyword mutations. |
| `/.netlify/functions/list-search-terms` | GET | The actual search queries that triggered ads (`?customerId=`, optional `&campaignId=`, `&days=7\|14\|30`, `&limit=`) with clicks, cost, conversions. Discovery view for optimization. |
| `/.netlify/functions/list-ads` | GET | The ad creatives in an account (`?customerId=`, optional `&campaignId=`) — for responsive search ads, their headlines, descriptions, final URLs, status, and type. |
| `/.netlify/functions/list-negatives` | GET | Existing campaign-level negative keywords (`?customerId=`, optional `&campaignId=`). |
| `/.netlify/functions/report` | GET | Performance metrics + derived CPA/ROAS at `?level=campaign\|ad_group\|keyword\|ad` (`&days=7\|14\|30`, optional `&campaignId=`). The core optimization input. |
| `/.netlify/functions/list-conversion-actions` | GET | Conversion actions and their value settings (`?customerId=`). Explains near-zero conversion value / ROAS. |
| `/.netlify/functions/list-campaign-goals` | GET | Which conversion-goal categories each campaign bids toward (`?customerId=`), plus account defaults. Cross-reference with conversion actions to see the event behind each campaign. |
| `/.netlify/functions/list-demographics` | GET | Age-range and gender criteria per ad group (`?customerId=`, optional `&campaignId=`) — targeted/excluded and bid modifier. |
| `/.netlify/functions/list-audiences` | GET | Audience/interest criteria per ad group (`?customerId=`, optional `&campaignId=`) — in-market/affinity, remarketing lists, custom/combined audiences. |
| `/.netlify/functions/list-locations` | GET | Location targets/exclusions per campaign with readable names (`?customerId=`, optional `&campaignId=`). |
| `/.netlify/functions/search-geo` | GET | Resolve a place name to geoTargetConstant id(s) (`?q=`, `&country=`, `&locale=`) for `add_location`. |
| `/.netlify/functions/manage` | POST | **Write.** The check-then-do management loop. Defaults to a dry run; only mutates when `confirm:true`. Logs every applied change to Supabase. See below. |
| `/.netlify/functions/get-audit` | GET | Read the audit history of applied changes (`?limit=`, `?customerId=`). |
| `/.netlify/functions/snapshot-metrics` | GET | Pulls DAILY (date-segmented) metrics and upserts them into Supabase `metrics_daily` so history accumulates (`?level=`, `?days=`). Run each pull. |
| `/.netlify/functions/get-metrics-history` | GET | Reads the accumulated daily time-series (`?level=`, `?entityId=`, `?from=`, `?to=`). For trend analysis. |

## Management engine (`manage`) — the check-then-do loop

`manage` is the one endpoint that changes things. It is **locked**: every call
must include an `x-mcc-token` header matching `MCC_API_SECRET`, or it returns
401 before doing anything. It is also built so a change is never silent:

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
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Netlify. For metrics history,
also run `supabase/metrics_daily.sql` once.

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

// Pause / enable an ad group (Search, Display, Demand Gen)
POST /.netlify/functions/manage
{ "action": "set_ad_group_status", "customerId": "9427798225",
  "adGroupId": "1234567890", "status": "PAUSED" }

// Pause / enable an asset group (Performance Max)
POST /.netlify/functions/manage
{ "action": "set_asset_group_status", "customerId": "9427798225",
  "assetGroupId": "1234567890", "status": "PAUSED" }

// Set the (optional) target CPA on a Maximize-Conversions or Target-CPA
// campaign (amount in DOLLARS). Refuses portfolio/other strategies.
POST /.netlify/functions/manage
{ "action": "set_target_cpa", "customerId": "9427798225",
  "campaignId": "1234567890", "amount": 40.00 }

// Add a keyword to an ad group (matchType: EXACT | PHRASE | BROAD, default BROAD).
// Health/sensitive terms trip Google policy; add "exemptPolicyViolations": true
// to acknowledge and override EXEMPTIBLE violations (common for medical/dental).
POST /.netlify/functions/manage
{ "action": "add_keyword", "customerId": "9427798225",
  "adGroupId": "1234567890", "text": "dental implants kingston",
  "matchType": "PHRASE", "exemptPolicyViolations": true }

// Pause / enable / remove a keyword (by criterion id from list-keywords)
POST /.netlify/functions/manage
{ "action": "set_keyword_status", "customerId": "9427798225",
  "adGroupId": "1234567890", "criterionId": "1234567890", "status": "PAUSED" }

// Remove a keyword
POST /.netlify/functions/manage
{ "action": "remove_keyword", "customerId": "9427798225",
  "adGroupId": "1234567890", "criterionId": "1234567890" }

// Add a campaign-level negative keyword (block a term across the campaign)
POST /.netlify/functions/manage
{ "action": "add_negative_keyword", "customerId": "9427798225",
  "campaignId": "1234567890", "text": "nhs", "matchType": "BROAD" }

// Add a location target (or exclusion) to a campaign. Find the id via search-geo.
POST /.netlify/functions/manage
{ "action": "add_location", "customerId": "9427798225",
  "campaignId": "1234567890", "geoTargetConstantId": "1006886", "negative": false }

// Remove a location criterion (criterionId from list-locations)
POST /.netlify/functions/manage
{ "action": "remove_location", "customerId": "9427798225",
  "campaignId": "1234567890", "criterionId": "1234567890" }

// Switch a campaign to RADIUS (proximity) targeting, atomically removing the
// existing location criteria first (location + proximity can't coexist).
// removeCriterionIds = the LOCATION criterion ids from list-locations.
POST /.netlify/functions/manage
{ "action": "set_geo_radius", "customerId": "9427798225", "campaignId": "1234567890",
  "lat": 51.4129, "lng": -0.3007, "radius": 10, "radiusUnits": "MILES",
  "removeCriterionIds": ["1007203","1007246","9215348"] }

// Set the default (monetary) value of a conversion action — e.g. value a
// booking at your average case value so bidding can chase revenue, not taps.
POST /.netlify/functions/manage
{ "action": "set_conversion_value", "customerId": "9427798225",
  "conversionActionId": "7034758458", "value": 200 }

// Exclude an age range or gender from an ad group.
// kind="age" value: AGE_RANGE_18_24 | _25_34 | _35_44 | _45_54 | _55_64 | _65_UP | _UNDETERMINED
// kind="gender" value: MALE | FEMALE | UNDETERMINED
POST /.netlify/functions/manage
{ "action": "exclude_demographic", "customerId": "9427798225",
  "adGroupId": "1234567890", "kind": "age", "value": "AGE_RANGE_18_24" }

// Create a PAUSED Search campaign + its budget (atomic). Spends NOTHING until
// enabled via set_campaign_status. Uses Maximize Conversions.
POST /.netlify/functions/manage
{ "action": "create_campaign", "customerId": "9427798225",
  "name": "Implants - Kingston 2026", "dailyBudget": 20.00 }

// Create an ad group inside a campaign (status default ENABLED; it won't serve
// while the campaign is paused)
POST /.netlify/functions/manage
{ "action": "create_ad_group", "customerId": "9427798225",
  "campaignId": "1234567890", "name": "Implants" }

// Pause / enable / remove an ad (adId from list-ads). Use to de-duplicate ads.
POST /.netlify/functions/manage
{ "action": "set_ad_status", "customerId": "9427798225",
  "adGroupId": "1234567890", "adId": "1234567890", "status": "PAUSED" }

// Create a responsive search ad (created PAUSED). 3-15 headlines (<=30 chars),
// 2-4 descriptions (<=90 chars), one finalUrl. Add exemptPolicyViolations for
// health terms.
POST /.netlify/functions/manage
{ "action": "create_ad", "customerId": "9427798225", "adGroupId": "1234567890",
  "headlines": ["Dental Implants Kingston","Specialist Implant Clinic","Book a Consultation"],
  "descriptions": ["Permanent implants by specialists.","Finance available. Book today."],
  "finalUrl": "https://example.com/implants", "exemptPolicyViolations": true }

// Add "confirm": true to any of the above to actually apply it.
```

New campaigns are always created **PAUSED** — a created campaign cannot spend
until you explicitly enable it with `set_campaign_status`.

Planned next actions (same harness): create ad group, create responsive search
ad, then keywords via `add_keyword`.

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
| `MCC_API_SECRET` | Shared secret required to call **every** endpoint. Sent by the caller as an `x-mcc-token` header. Without a match, the endpoint returns 401. |

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
