# pull-all.ps1 — fetch every read endpoint and save JSON to .\data\ for analysis.
# The data\ folder is gitignored (it holds account data). No secrets are stored
# in this file — the token is passed at runtime.
#
# Usage:
#   .\pull-all.ps1                                             # Kings Dental -> data\
#   .\pull-all.ps1 -CustomerId 4594075026 -OutDir data\roomvu  # Roomvu -> data\roomvu\
#   (set $env:MCC_API_SECRET once per PowerShell session; never pass it in chat)
#
# ALWAYS give each account its own -OutDir. The file names are fixed, so two
# accounts pulled into the same folder silently overwrite each other.
# Keep OutDir inside data\ - that folder is gitignored (account data never committed).

param(
  [string]$Token = $env:MCC_API_SECRET,
  [string]$CustomerId = "9427798225",
  [string]$OutDir = "data",
  [switch]$NoHistory,   # skip the Supabase metrics_daily snapshot (read-only pull)
  [string]$Base = "https://mcc-manager.netlify.app/.netlify/functions"
)

if (-not $Token) { Write-Error "Provide -Token or set `$env:MCC_API_SECRET first."; exit 1 }

$h = @{ "x-mcc-token" = $Token }
$out = Join-Path $PSScriptRoot $OutDir
Write-Host ("Account {0} -> {1}" -f $CustomerId, $out)
New-Item -ItemType Directory -Force -Path $out | Out-Null

$reads = @(
  @{ name = "clients";      url = "$Base/list-clients" },
  @{ name = "campaigns";    url = "$Base/list-campaigns?customerId=$CustomerId" },
  @{ name = "adgroups";     url = "$Base/list-adgroups?customerId=$CustomerId" },
  @{ name = "keywords";     url = "$Base/list-keywords?customerId=$CustomerId" },
  @{ name = "search-terms"; url = "$Base/list-search-terms?customerId=$CustomerId&limit=500" },
  @{ name = "ads";             url = "$Base/list-ads?customerId=$CustomerId" },
  @{ name = "negatives";       url = "$Base/list-negatives?customerId=$CustomerId" },
  @{ name = "locations";       url = "$Base/list-locations?customerId=$CustomerId" },
  @{ name = "conversion-actions"; url = "$Base/list-conversion-actions?customerId=$CustomerId" },
  @{ name = "campaign-goals";     url = "$Base/list-campaign-goals?customerId=$CustomerId" },
  @{ name = "demographics";       url = "$Base/list-demographics?customerId=$CustomerId" },
  @{ name = "audiences";          url = "$Base/list-audiences?customerId=$CustomerId" },
  @{ name = "report-campaign"; url = "$Base/report?customerId=$CustomerId&level=campaign&days=30" },
  @{ name = "report-keyword";  url = "$Base/report?customerId=$CustomerId&level=keyword&days=30" },
  @{ name = "report-ad";       url = "$Base/report?customerId=$CustomerId&level=ad&days=30" },
  # Per-conversion-action truth: what actually fired, at what real value, and
  # whether it is PRIMARY (feeding bidding). This is how we verify the ad-pilot
  # offline uploads landed and catch junk goals inflating the conversion count.
  @{ name = "report-conversions"; url = "$Base/report-conversions?customerId=$CustomerId&during=LAST_30_DAYS&byCampaign=1" },
  # Impression share (campaign) + device + network + geo + auction insights, one call.
  @{ name = "report-splits";      url = "$Base/report-splits?customerId=$CustomerId&type=all&days=30" },
  # Keyword-level impression share: which keywords lose auctions to rank.
  @{ name = "report-is-keyword";  url = "$Base/report-splits?customerId=$CustomerId&type=impression_share&level=keyword&days=30" },
  @{ name = "audit";           url = "$Base/get-audit?limit=200&customerId=$CustomerId" }
)

foreach ($r in $reads) {
  try {
    $resp = Invoke-RestMethod -Uri $r.url -Headers $h -ErrorAction Stop
    $path = Join-Path $out ("{0}.json" -f $r.name)
    $resp | ConvertTo-Json -Depth 20 | Out-File -FilePath $path -Encoding utf8
    Write-Host ("OK   {0,-13} -> {1}\{0}.json" -f $r.name, $OutDir)
  } catch {
    Write-Host ("FAIL {0,-13} : {1}" -f $r.name, $_.Exception.Message)
  }
}
# Accumulate DAILY performance history into Supabase (upsert; safe to re-run).
if ($NoHistory) { Write-Host "-- history snapshot skipped (-NoHistory) --" } else {
Write-Host "-- snapshotting daily metrics to history --"
foreach ($lvl in @("campaign", "ad_group", "keyword", "ad")) {
  try {
    $s = Invoke-RestMethod -Uri "$Base/snapshot-metrics?customerId=$CustomerId&level=$lvl&days=30" -Headers $h -ErrorAction Stop
    Write-Host ("OK   history {0,-9} -> {1} rows upserted" -f $lvl, $s.count)
  } catch { Write-Host ("FAIL history {0}: {1}" -f $lvl, $_.Exception.Message) }
}
}

# Optional: also download extra CSVs (e.g. published Google Sheet tabs) listed
# in data\sheet-sources.txt, one per line as:  name,https://...&output=csv
# (Use this only for NON-personal tabs, e.g. monthly revenue totals. Keep raw
#  lead/PII exports as manual CSV drops into data\ — see LEADS-DATA.md.)
$srcFile = Join-Path $out "sheet-sources.txt"
if (Test-Path $srcFile) {
  Get-Content $srcFile | Where-Object { $_ -match "," -and $_ -notmatch "^\s*#" } | ForEach-Object {
    $parts = $_ -split ",", 2
    $nm = $parts[0].Trim(); $u = $parts[1].Trim()
    try {
      Invoke-WebRequest -Uri $u -OutFile (Join-Path $out ("{0}.csv" -f $nm)) -UseBasicParsing -ErrorAction Stop
      Write-Host ("OK   sheet {0,-12} -> data\{0}.csv" -f $nm)
    } catch { Write-Host ("FAIL sheet {0}: {1}" -f $nm, $_.Exception.Message) }
  }
}

Write-Host "Done. Files are in $out"
