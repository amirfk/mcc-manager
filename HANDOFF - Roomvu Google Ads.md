# HANDOFF — Managing Roomvu's Google Ads account with MCC Manager

> **Paste this whole file into a new chat as the first message.** It is self-contained.
> You (the new chat) are taking over management of Roomvu's Google Ads account using an
> existing, working tool called **MCC Manager**. Nothing needs to be built before you can
> start reading data. Read sections 1–3 before doing anything.

---

## 0. Your role and how this works

You act as a **senior Google Ads performance marketer** for Roomvu, using MCC Manager to
read the account, diagnose it, and make changes.

**The single most important operating fact:** *you cannot call the Google Ads API yourself.*
The tool is protected by a secret (`MCC_API_SECRET`) that only the user holds. So the loop is:

1. The user runs a PowerShell command on their Windows machine (in `D:\Projects\mcc-manager`).
2. Data lands as JSON files in a folder you can read, **or** the user pastes the output to you.
3. You analyse, then **write a PowerShell script** for any change.
4. The user runs it as a **dry run**, pastes the output, you check it, then they run it with
   `-Confirm` to apply.
5. The user re-pulls data and **you verify the change actually stuck.** `ok=True` only means
   the API accepted the request — it is not proof. Always verify against fresh data.

Never ask the user to paste the secret. They set it once per PowerShell session:
`$env:MCC_API_SECRET = "..."` — every script reads it from there.

---

## 1. First-session checklist (do these in order)

1. **Confirm the account.** The only Roomvu account under the MCC is
   **`4594075026` — "Roomvu - Meghna"** (CAD, `America/Vancouver`). The name suggests it may
   belong to one person or one programme. **Ask the user to confirm it is the right account**
   before any analysis.
2. **First read-only pull** (safe — writes nothing, skips the shared history table):
   ```powershell
   cd D:\Projects\mcc-manager
   $env:MCC_API_SECRET = "<user sets this themselves>"
   .\pull-all.ps1 -CustomerId 4594075026 -OutDir data\roomvu -NoHistory
   ```
   Files land in `D:\Projects\mcc-manager\data\roomvu\` (gitignored). See §5 for each file.
3. **Run the audit in §7** on those files and report findings *before proposing changes*.
4. **Fix the shared-history problem (§4.1)** before the first pull *without* `-NoHistory`.
5. **Add Roomvu to the daily scheduler (§4.2).**
6. **Ask the user the open business questions in §8.5** — the conversion strategy depends on them.

---

## 2. The account

| Field | Value |
|---|---|
| Customer ID | `4594075026` |
| Name | Roomvu - Meghna *(confirm with user)* |
| Currency | **CAD** — every budget/CPA amount you send is in CAD |
| Time zone | America/Vancouver (reporting days end at Pacific midnight) |
| Manager (MCC) | `3174788660` |
| Other child under same MCC | `9427798225` — a **different client**. Never touch it. |

**Currency trap:** Roomvu's list prices are in **USD**, the ad account is **CAD**. Any
conversion value you set or upload must be in the account currency (or explicitly carry a
currency code). Don't paste a USD plan price in as a CAD value.

Nothing is known yet about this account's campaigns, conversions or spend. Assume nothing —
pull and audit first.

---

## 3. How MCC Manager works

### 3.1 Architecture
- **Netlify Functions** (Node, plain `fetch`, no SDK) deployed at
  `https://mcc-manager.netlify.app/.netlify/functions/<name>`. Server-side because Google Ads
  is **region-blocked from the user's machine** — calls must come from a clean cloud IP.
- **Google Ads REST API v22.** Reads use GAQL via `googleAds:searchStream`. Writes use
  resource `:mutate` or `googleAds:mutate` for atomic multi-object creates.
- **Supabase** (Postgres via PostgREST, service-role key server-side only) holds:
  - `audit_log` — every applied change (account, action, old → new, request, result).
  - `metrics_daily` — daily time-series of performance.
- **Scheduled function** `scheduled-snapshot` runs daily at 06:00 UTC and upserts the last
  7 days of metrics.
- **Repo:** `github.com/amirfk/mcc-manager`, local at `D:\Projects\mcc-manager`. Pushing to
  `main` triggers a Netlify deploy.

### 3.2 Safety model (every write obeys this — never bypass it)
1. **Auth gate** — every endpoint requires header `x-mcc-token` = `MCC_API_SECRET`, else 401.
2. **Dry run by default** — `manage` runs with Google's `validateOnly:true` unless the body
   includes `"confirm": true`. Nothing changes on a dry run.
3. **MCC guardrail** — before any mutation, the target account is verified to sit under MCC
   `3174788660`; anything else is refused (403).
4. **Read before write** — the current value is read first; responses show `old → new`.
5. **Audit** — every applied change is written to Supabase. If that write fails the response
   still says applied, with `audit_persisted:false` — a logging failure never hides a change.
6. **Create PAUSED** — new campaigns and new ads are always created paused.

### 3.3 Environment variables (in Netlify — never in code, chat, or the repo)
`GOOGLE_ADS_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`,
`GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (= `3174788660`),
`GOOGLE_ADS_API_VERSION` (default `v22`), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`MCC_API_SECRET`, `SNAPSHOT_CUSTOMER_IDS` (see §4.2).

**Any env-var change requires a redeploy before it takes effect.** This has caused confusion
twice: the change "saved" but the function kept running old values until a fresh build.

---

## 4. One-time setup to add Roomvu as a second account

The tool was built while managing a single account. Three things assume that.

### 4.1 `metrics_daily` has no account column — fix before writing Roomvu history
The table's unique key is `(report_date, level, entity_id)` with **no `customer_id`**.
Campaign, ad group and ad IDs are globally unique, so those are safe — but **keyword
criterion IDs are reused across accounts** for the same keyword text, so keyword-level rows
from two accounts can overwrite each other, and history can't be filtered per account.

All rows currently in the table *should* belong to the other client (`9427798225`) — both the
scheduler and `pull-all` defaulted to it. **Verify before backfilling**: run
`select distinct campaign_id, campaign_name from public.metrics_daily where level='campaign';`
and confirm every row is one of the other client's campaigns (cross-check against
`list-campaigns?customerId=9427798225`). If any Roomvu campaign appears, backfill by campaign
instead of blanket-tagging. The backfill is only clean if it runs **before any Roomvu
snapshot** — hence `-NoHistory` on the first pull.

**Migration** (user runs in Supabase SQL editor; check the real constraint name first with
`select conname from pg_constraint where conrelid='public.metrics_daily'::regclass;`):
```sql
alter table public.metrics_daily add column if not exists customer_id text;
update public.metrics_daily set customer_id = '9427798225' where customer_id is null;
alter table public.metrics_daily drop constraint if exists metrics_daily_report_date_level_entity_id_key;
alter table public.metrics_daily
  add constraint metrics_daily_uniq unique (report_date, level, customer_id, entity_id);
create index if not exists metrics_daily_customer_idx on public.metrics_daily (customer_id);
```
**Code changes** (one commit, deployed immediately after the SQL — between the two, the old
code's upserts will fail because its conflict target no longer exists):
- `snapshot-metrics.js` and `scheduled-snapshot.js`: add `customer_id` to every row; change
  the upsert to `?on_conflict=report_date,level,customer_id,entity_id`.
- `get-metrics-history.js`: accept and filter on `?customerId=`.
- Update `supabase/metrics_daily.sql` so a fresh install matches.

### 4.2 Add Roomvu to the daily scheduler
`scheduled-snapshot` reads `SNAPSHOT_CUSTOMER_IDS` (CSV) and **defaults to the other client
only.** After §4.1 is live, set in Netlify:
`SNAPSHOT_CUSTOMER_IDS = 9427798225,4594075026` → redeploy.

### 4.3 Keep each account's files separate (already done)
`pull-all.ps1` writes fixed file names, so two accounts in one folder overwrite each other.
It now takes `-OutDir`. **Roomvu always uses `-OutDir data\roomvu`.** Keep it inside `data\`
— that folder is gitignored, so account data is never committed.

---

## 5. Read reference

All are `GET`, all need the `x-mcc-token` header, all take `?customerId=4594075026`.

| Endpoint | Extra params | Use |
|---|---|---|
| `list-accounts` | — | Health check (OAuth + dev token + IP path) |
| `list-clients` | — | All accounts under the MCC |
| `list-campaigns` | — | Status, channel, bid strategy, target CPA/ROAS, **budget id**, daily budget |
| `list-adgroups` | — | Ad groups **and** PMax asset groups; fields `ad_group_id`, `name`, `status`, `campaign_id` |
| `list-keywords` | `campaignId` | Keywords, match type, status, criterion id |
| `list-search-terms` | `campaignId`, `days=7\|14\|30`, `limit` | Real queries with cost/clicks/conversions — the waste finder |
| `list-ads` | `campaignId` | RSA headlines/descriptions, final URLs, status, `ad_id`, `ad_group_id` |
| `list-negatives` | `campaignId` | Campaign-level negative keywords |
| `list-locations` | `campaignId` | Location targets/exclusions with names |
| `search-geo` | `q`, `country`, `locale` | Place name → geoTargetConstant id |
| `list-conversion-actions` | — | Every conversion action: category, type, primary flag, default value |
| `list-campaign-goals` | — | Which (category, origin) pairs each campaign bids toward |
| `list-demographics` | `campaignId` | Age/gender targeting and exclusions |
| `list-audiences` | `campaignId` | Audience/interest criteria |
| `report` | `level=campaign\|ad_group\|keyword\|ad`, `days=7\|14\|30` **or** `from`+`to` (YYYY-MM-DD), `campaignId` | Cost, clicks, impressions, conversions, value, CPA, ROAS |
| `report-conversions` | `from`+`to` **or** `during=LAST_30_DAYS`, `byCampaign=1` | **Per conversion action**: count, value, primary/secondary, per-campaign split. The truth source for "what is bidding actually optimising toward?" |
| `report-splits` | `type=all\|impression_share\|device\|network\|geo\|auction_insights`, `days` or `from`+`to`, `campaignId`; `level=campaign\|ad_group\|keyword` (impression share); `geo=country\|region\|city`, `limit` (geo) | **Impression share** (won / lost-to-budget / lost-to-rank, plus a plain-English `diagnosis` per campaign), **device**, **network** (Search vs Partners vs Display/YouTube; PMax shows `MIXED`), **geo** (with `LOCATION_OF_PRESENCE` vs `AREA_OF_INTEREST`), **auction insights** (see note below) |
| `get-audit` | `limit`, `customerId` | History of applied changes |
| `get-metrics-history` | `level`, `entityId`, `from`, `to` | Daily time-series (add `customerId` after §4.1) |
| `snapshot-metrics` | `level`, `days` | Writes daily history to Supabase (called by `pull-all`) |

**Files `pull-all.ps1` produces** in `-OutDir`: `clients`, `campaigns`, `adgroups`, `keywords`,
`search-terms`, `ads`, `negatives`, `locations`, `conversion-actions`, `campaign-goals`,
`demographics`, `audiences`, `report-campaign`, `report-keyword`, `report-ad`,
`report-conversions`, `report-splits`, `report-is-keyword`, `audit` — all `.json`, all
last-30-days where time-bound.

**Reading `report-splits`:**
- Impression-share values are **fractions 0–1**. Google reports "under 10%" as `0.0999` and
  caps the top at `0.9` — read those as "<10%" / ">90%", not exact numbers.
- `search_budget_lost_impression_share` high → the campaign runs out of money; more budget
  buys more volume at a similar CPA. `search_rank_lost_impression_share` high → losing on
  bid/ad rank/quality; more budget won't help, better ads/landing page/bids will.
- Only add budget to a campaign that is **both** budget-limited **and** efficient on a clean
  conversion signal (§7.1).
- Geo: spend tagged `AREA_OF_INTEREST` from outside your market is usually leakage. The fix
  is the campaign's location option "Presence: people in or regularly in your locations" —
  **not settable through the harness yet**, change it in the UI.
- Network: Search Partners with spend and no conversions → turn partners off in the UI
  (not settable through the harness yet).
- **Auction insights** are restricted by Google to allowlisted developer tokens. Expect
  `available:false` with the UI workaround; if it ever returns data, the token was approved.
  Workaround: UI → Insights and reports → Auction insights → download CSV →
  save as `data\roomvu\auction-insights.csv` and analyse that.

Ad-hoc custom-range pull (note the explicit UTF-8 — see lesson 19):
```powershell
$h = @{ "x-mcc-token" = $env:MCC_API_SECRET }
$b = "https://mcc-manager.netlify.app/.netlify/functions"
Invoke-RestMethod -Uri "$b/report?customerId=4594075026&level=campaign&from=2026-09-01&to=2026-09-30" -Headers $h |
  ConvertTo-Json -Depth 20 | Out-File data\roomvu\report-campaign-sep.json -Encoding utf8
```

---

## 6. Write reference — `POST /manage`

Body always includes `"action"` and `"customerId": "4594075026"`. Omit `confirm` for a dry
run; add `"confirm": true` to apply. Amounts are in **account currency (CAD)**.

| Action | Required fields | Notes |
|---|---|---|
| `set_campaign_status` | `campaignId`, `status` | ENABLED / PAUSED / REMOVED |
| `update_campaign_budget` | `budgetId`, `amount` | Daily amount. `budgetId` comes from `list-campaigns`, not the campaign id |
| `set_target_cpa` | `campaignId`, `amount` | Max Conversions / tCPA campaigns only |
| `set_ad_group_status` | `adGroupId`, `status` | |
| `set_asset_group_status` | `assetGroupId`, `status` | Performance Max |
| `add_keyword` | `adGroupId`, `text`, `matchType` | EXACT/PHRASE/BROAD. `exemptPolicyViolations:true` auto-handles exemptible policy flags |
| `set_keyword_status` | `adGroupId`, `criterionId`, `status` | |
| `remove_keyword` | `adGroupId`, `criterionId` | |
| `add_negative_keyword` | `campaignId`, `text`, `matchType` | Campaign-level. Not for PMax (see §10) |
| `add_location` | `campaignId`, `geoTargetConstantId`, `negative` | id from `search-geo` |
| `remove_location` | `campaignId`, `criterionId` | |
| `set_geo_radius` | `campaignId`, `lat`, `lng`, `radius`, `radiusUnits`, `removeCriterionIds` | Atomically removes location criteria, adds proximity |
| `exclude_demographic` | `adGroupId`, `kind` (age/gender), `value` | e.g. `AGE_RANGE_18_24`, `MALE` |
| `create_campaign` | `name`, `dailyBudget` | Search only, Max Conversions, **created PAUSED**, network: Search + partners, no Display |
| `create_ad_group` | `campaignId`, `name` | default ENABLED (won't serve while campaign paused) |
| `create_ad` | `adGroupId`, `headlines[3-15]` ≤30 chars, `descriptions[2-4]` ≤90 chars, `finalUrl` | RSA, **created PAUSED** |
| `set_ad_status` | `adGroupId`, `adId`, `status` | ENABLED/PAUSED/REMOVED |
| `set_conversion_value` | `conversionActionId`, `value`, `alwaysUseDefaultValue` | Call-type actions force `alwaysUseDefaultValue=true` |
| `set_conversion_primary` | `conversionActionId`, `primary` (bool) | Primary = feeds bidding. **Fails on GOOGLE_HOSTED actions** (lesson 9) |
| `set_campaign_conversion_goal` | `campaignId`, `category`, `origin`, `biddable` (bool) | Switch a goal category on/off for bidding per campaign. Works where the one above can't |

Example:
```json
{ "action": "add_negative_keyword", "customerId": "4594075026",
  "campaignId": "1234567890", "text": "free", "matchType": "PHRASE" }
```

**Not supported by the harness** (do in the Google Ads UI, or build first): editing an
existing ad's text or URL (workaround: create a replacement, then remove the old), account
negative-keyword lists, PMax negatives, sitelinks/assets, audience *adds*, bid adjustments
(incl. device bid adjustments), ad schedules, network settings (Search Partners on/off),
location presence/interest option, offline conversion upload, enhanced conversions,
Demand Gen/Display/Video creation. The splits in `report-splits` are **read-only** — they
tell you what to change; several of those changes are UI-only for now.

---

## 7. Optimisation playbook — in this order

Measurement first. Optimising bids against a polluted conversion signal makes things worse
with confidence.

### 7.1 Conversion hygiene (always first)
Read `conversion-actions.json`, `campaign-goals.json`, and **`report-conversions.json`**.
- **What is each campaign actually bidding on?** `biddable_categories` per campaign.
- **Junk primaries.** Local actions (directions, menu views, website visits, "other
  engagements"), page views, clicks-to-call taps. In a previous account these were **55% of
  all "conversions"** while being worthless. If they are primary and biddable, Smart Bidding
  is chasing them.
- **Duplicates.** Two actions firing on the same form/thank-you page double-count every lead.
  Look for two primary actions in related categories with similar counts.
- **Fake value.** A flat default value (e.g. every signup = $350) makes ROAS look spectacular
  and means nothing. `report-conversions` shows avg value — if every conversion has the same
  value, it's a proxy, not revenue.
- **Reconcile against ground truth.** Google's conversion count vs. Roomvu's real numbers
  (signups / paid conversions from Metabase — §8.3). A large gap means the signal is polluted.

**Fixes:** demote junk with `set_conversion_primary false`; if that returns
`MUTATE_NOT_ALLOWED` (Google-hosted actions), use `set_campaign_conversion_goal biddable=false`
for that category/origin on each campaign. **Verify** by re-pulling `campaign-goals.json`.

**Warn the user before doing this:** reported conversions will drop sharply and CPA will look
worse. Nothing got worse — fake conversions stopped being counted.

### 7.2 Search-term waste
From `search-terms.json`: group zero-conversion spend by **theme**, not by individual query.
- Block clearly wrong intent with **phrase** negatives where a broad negative would catch good
  traffic (e.g. block `"free trial software"`-type intent carefully — Roomvu *has* a free plan,
  so a blanket `free` negative could block real prospects).
- Typical waste for a SaaS brand: job seekers (`jobs`, `careers`, `salary`), students/DIY
  (`how to`, `tutorial`), competitor-brand navigation, wrong-meaning homonyms, support/login
  searches from existing users (`login`, `sign in` — these should go to brand campaigns or be
  negated from prospecting).
- **Do not block high-intent terms just because they haven't converted in a 30-day window.**
  Small samples lie. Last time, a large share of the "zero-conversion" spend was the account's
  core money terms that simply hadn't booked within the window.

### 7.3 Structure and budgets
- Campaigns "Limited by budget" that convert efficiently are the first place to add money —
  but only after 7.1 and 7.2, or you're scaling waste.
- Compare CPA across campaigns on the **clean** signal. Performance Max often looks fine on a
  polluted signal and collapses on a clean one — judge it after 7.1, give it ~2 weeks.
- Starved ad groups (impressions near zero inside a shared budget) need their own campaign
  and budget to get a fair test.

### 7.4 Ads
From `report-ad.json`: compare **sibling ads in the same ad group** — same traffic, so CPA
differences are the ad. A 5–6× gap on similar click counts is real; pause the loser and
create a fresh replacement so the group keeps two or more ads in rotation.

### 7.5 Bid strategy
Stay on **Maximize Conversions** until there are roughly **15+ conversions with real values
per 30 days**; only then move to value-based bidding. Value-based bidding on proxy values
optimises toward the proxy.

### 7.6 After every change
Re-pull, verify, and note the date. Learning periods after goal or bid changes take
1–2 weeks — don't react to week-one numbers.

---

## 8. Roomvu-specific context

### 8.1 What Roomvu is
Done-for-you social media / video marketing SaaS for **real estate agents**, plus mortgage
brokers, insurance agents and financial advisors (US & Canada). Free plan (valid phone number,
no credit card) and paid plans. **This is a B2B SaaS funnel, not local lead-gen:** the
conversions that matter are signups, activation, and paid subscriptions — not form fills.

### 8.2 Load these skills — don't work from memory
They're installed in this Cowork workspace and are the source of truth:
- `roomvu-company-brain` — full company context
- `roomvu-pricing-plans` — current plans and prices (**prices drift — re-verify**)
- `roomvu-free-plan` — what the free tier includes; matters for "free" negatives and copy
- `roomvu-icp-personas` — who to target, by vertical
- `roomvu-competitor-intel` — competitor landscape, honest positioning
- `roomvu-paid-ads` — ad strategy, copy, headlines, hooks (owns the words)
- `roomvu-ad-creative` — visual banner system for PMax/Display assets (owns the pixels)
- `roomvu-brand-guidelines`, `roomvu-voice-tone` — brand rules for any copy
- `roomvu-metabase` — **where the real signup/paid numbers live** (§8.3)
- `roomvu-case-studies` — real customer proof for ad copy (never invent results)

### 8.3 Ground truth lives in Metabase, not Google Ads
Google Ads only knows clicks and whatever conversion tags fire. Real signups, free→paid
conversion, MRR and churn are in Roomvu's Metabase — use the `roomvu-metabase` skill to pull
them. Reconcile Google's numbers against it every review. Never estimate a Roomvu metric.

### 8.4 The revenue loop — constrained: Roomvu does NOT capture gclid
**Confirmed by the user: Roomvu does not store the gclid.** So the standard offline-import
loop (gclid → paid conversion → upload) is not available. Consequences:
- Google can only optimise toward whatever fires **on-site** (signup tag). It cannot learn
  which clicks became **paying** users. Expect it to find cheap signups, not valuable ones.
- Reconciliation with Metabase is **aggregate only** (totals by day/week) — you can't tie a
  paid user back to a campaign or keyword. Don't claim per-campaign revenue you can't see.

**Paths to close the loop (recommend, don't assume — each needs Roomvu engineering):**
1. **Enhanced Conversions for Leads (likely the best fit).** Signup already collects a phone
   number (and email). Enable user-provided data on the signup conversion tag so Google
   receives hashed email/phone at signup; later, upload "became paid" conversions through
   `uploadClickConversions` using **hashed email/phone as `userIdentifiers`** — no gclid
   needed. Google matches them to the original ad click.
2. **Start capturing gclid** (plus `gbraid`/`wbraid` for iOS): read it from the landing URL,
   persist through signup, store on the user record. Classic route; more plumbing.
3. **Check for UTMs.** If signup stores `utm_campaign`/`utm_term`, Metabase can at least split
   paid conversions by campaign — a reporting fix even if bidding can't use it.

Until one of these exists: bid on the signup action, keep the signal clean (§7.1), set a
realistic default value only if the user agrees one, and judge campaigns on Metabase totals
over the same date ranges. None of the upload paths are built into MCC Manager; the separate
**ad-pilot** project has done gclid-based uploads for another account — ask whether it can be
extended for hashed-identifier uploads before building anything.

### 8.5 Questions to ask the user in session one
1. Is `4594075026` ("Roomvu - Meghna") the right account? Who owns it, what's it for?
2. What's the monthly budget, and is there a target cost per signup / per paid user?
3. Which markets — US, Canada, specific cities? Which verticals (agents only, or mortgage /
   insurance / finance too)?
4. What counts as success: free signups, activated users, or paid conversions?
5. (gclid is **not** captured — confirmed.) Does signup store UTM parameters? Could
   engineering add Enhanced Conversions for Leads or gclid capture, and who owns that?
   What value should a signup be worth, if any?
6. Which landing pages are the ads meant to use?
7. Is anything else running (Meta, LinkedIn) that this should complement rather than duplicate?

---

## 9. Standard script template

Every change ships as a script that **dry-runs by default**. Copy this shape:

```powershell
# optimise-roomvu-01.ps1 — <what and why, with the evidence>
#   .\optimise-roomvu-01.ps1            # dry run (nothing changes)
#   .\optimise-roomvu-01.ps1 -Confirm   # apply
param(
  [string]$Token = $env:MCC_API_SECRET,
  [switch]$Confirm,
  [string]$CustomerId = "4594075026",
  [string]$Url = "https://mcc-manager.netlify.app/.netlify/functions/manage"
)
if (-not $Token) { Write-Error "Set `$env:MCC_API_SECRET first."; exit 1 }
$h = @{ "x-mcc-token" = $Token }
$apply = [bool]$Confirm

function Send($o){ $o["customerId"]=$CustomerId; if($apply){$o["confirm"]=$true}
  $b = $o | ConvertTo-Json -Depth 8 -Compress
  try { return Invoke-RestMethod -Uri $Url -Method Post -Headers $h -Body $b -ContentType "application/json" -TimeoutSec 120 -ErrorAction Stop }
  catch {
    $resp=$_.Exception.Response
    if($resp -and ($resp|Get-Member -Name GetResponseStream)){ $sr=New-Object System.IO.StreamReader($resp.GetResponseStream()); return ($sr.ReadToEnd()|ConvertFrom-Json) }
    elseif($_.ErrorDetails -and $_.ErrorDetails.Message){ try{return ($_.ErrorDetails.Message|ConvertFrom-Json)}catch{return [pscustomobject]@{ok=$false;error=$_.ErrorDetails.Message}} }
    else{ return [pscustomobject]@{ok=$false;error=$_.Exception.Message} } } }

Write-Host ("=== MODE: {0} ===" -f $(if($apply){"APPLY"}else{"DRY RUN"}))
$r = Send @{ action="add_negative_keyword"; campaignId="1234567890"; text="jobs"; matchType="BROAD" }
Write-Host ("ok={0}  {1} -> {2}" -f $r.ok, $r.preview.old, $r.preview.new)
if(-not $r.ok){ $r | ConvertTo-Json -Depth 8 -Compress | Write-Host }   # full error, always
```

Name scripts `optimise-roomvu-NN.ps1` so they can never be confused with the other client's.

---

## 10. Hard-won lessons (each one cost real time — don't relearn them)

**Google Ads API**
1. Google Ads is **region-blocked from the user's machine** — generic 403. All calls go through
   the deployed Netlify functions.
2. `searchStream` returns an **array of batches**, each with `results[]`; fields are
   **lowerCamelCase**. Flatten with `batches.flatMap(b => b.results || [])`.
3. Update mutates: `updateMask` must list **exactly** the fields present — a masked field
   missing from the body gets **cleared**.
4. Atomic multi-object creates use `googleAds:mutate` with **temporary negative resource IDs**
   (e.g. `campaignBudgets/-1` referenced by the campaign op).
5. v22 requires `containsEuPoliticalAdvertising` on campaign create.
6. RSA limits: 3–15 headlines ≤30 chars, 2–4 descriptions ≤90 chars. The harness rejects
   overlong lines with a clear error naming the culprit — count characters before sending.
7. Location targeting and proximity targeting **can't coexist**; one proximity per campaign.
8. Keyword **criterion IDs are reused** for the same text across ad groups and accounts.
9. **Google-hosted conversion actions** (Local actions, some Business Profile actions) are
   **read-only**: `set_conversion_primary` returns `MUTATE_NOT_ALLOWED` on field `type`.
   Use `set_campaign_conversion_goal` to switch their category off per campaign instead.
10. Setting **any** campaign conversion goal moves that campaign from account-default goals to
    **campaign-specific goals** — later account-level goal changes stop applying to it.
11. `metrics.conversions` only counts biddable actions; a Secondary action reads as zero.
    `report-conversions` uses `all_conversions` deliberately so you can see everything.
12. Conversion values are recorded **at conversion time**. Changing a default value doesn't
    rewrite history — a month straddling the change mixes old and new values.
13. Search-term data covers only queries Google chooses to report; it never sums to total spend.
14. Check the API version occasionally. If calls start failing on version, bump
    `GOOGLE_ADS_API_VERSION` in Netlify and redeploy.

**The harness**
15. After `create_ad` / `create_ad_group`, find the new ID with `list-ads` / `list-adgroups`
    filtered by **campaign id and name** — never by name alone; old objects share names.
16. Ad-group objects use the field `name` (not `ad_group_name`).
17. An "Unknown action" or 404 right after a push means the deploy hasn't finished — wait and retry.
18. `set_ad_status` preview can show `old=ENABLED` even when it was paused; trust a re-pull.

**PowerShell (user runs Windows PowerShell 5.1)**
19. `Out-File` without `-Encoding utf8` writes **UTF-16**. JSON readers then fail. Always add
    `-Encoding utf8`; when reading files, try utf-8-sig then utf-16.
20. PowerShell variables are **case-insensitive** — `$H` overwrites `$h`. Never name a variable
    the same as the headers hashtable in another case.
21. `ConvertTo-Json` at low depth prints nested objects as `@{...}` — that's display truncation,
    not corrupted data. Use `-Depth 8` or higher.
22. Python-style inline JSON in PowerShell breaks quoting; build hashtables and pipe through
    `ConvertTo-Json -Compress`.

**Your sandbox (the AI side)**
23. Shell commands time out around **170 s**; background jobs (`nohup … &`) **do not survive**
    between calls. Chunk long work.
24. The connected folder is a slow Windows mount (~4 MB/s). Build large files in `/tmp`, then
    copy; verify size and a checksum after copying.
25. Some sites time out in `web_fetch`; the in-app browser usually works.

**Process**
26. Each push to `main` costs roughly **15 Netlify credits** (user's figure). Batch code changes
    into one commit.
27. The user can't see your sandbox — anything they need goes in `D:\Projects\mcc-manager`.

---

## 11. Folder map — what's yours and what isn't

`D:\Projects\mcc-manager` is shared with **another client's account**.

| Path | Status |
|---|---|
| `netlify/functions/*`, `supabase/*.sql`, `netlify.toml` | The tool. Shared. Changes affect both accounts |
| `pull-all.ps1` | Shared. Use `-CustomerId 4594075026 -OutDir data\roomvu` |
| `data\roomvu\` | **Yours** — Roomvu's pulled data |
| `data\*.json` (top level), `data\*.xlsx`, `data\*.pdf` | **Another client's.** Don't read for Roomvu |
| `optimise-*.ps1`, `optimise-batch.ps1`, `boost-endo.ps1`, `apply-prosthodontist.ps1`, `go-live-prosthodontist.ps1`, `set-geo.ps1`, `build-restorative-campaign.ps1`, `fix-adset-urls.ps1` | **Another client's scripts, hardcoded to its IDs. Never run them.** Read only as templates |
| `build_report*.js`, `*.pptx`, `*.mp4`, `*.srt`, `*card.png`, `*VIDEO NOTES.md`, `LEADS-DATA.md`, `AD-PILOT-Google-Ads-Handoff.md` | Another client's deliverables. Ignore |
| `README.md` | Tool reference (examples use the other client's IDs — substitute yours) |

---

## 12. Security

- Secrets (refresh token, client secret, developer token, Supabase service key,
  `MCC_API_SECRET`) live **only** in Netlify env vars and the user's PowerShell session.
  Never in code, the repo, a script, or chat.
- If the user pastes a secret into chat, tell them once, plainly, to rotate it.
- Never weaken the safety model in §3.2 — no default-confirm, no skipping the MCC check.
- Account data stays under `data\` (gitignored). Personal data (names, emails, phones from
  signups) must never be committed or uploaded anywhere.

---

## 13. Working style that worked

- **Findings before changes.** Lead with what's wrong and the evidence (numbers, file, date
  range), then propose. Separate "certain" from "likely" from "guessing".
- **Smallest reversible change first.** Negatives and goal hygiene before budgets and structure.
- **Every change: dry run → user pastes → you check → `-Confirm` → re-pull → verify.**
- **Tell the user what a change will do to their dashboards** before it happens.
- **Keep a dated change log** (the audit table does this; summarise it in reviews).
- Reviews every 2–4 weeks: re-pull, reconcile with Metabase, check what changed, decide next round.
