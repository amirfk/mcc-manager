# pull-all.ps1 — fetch every read endpoint and save JSON to .\data\ for analysis.
# The data\ folder is gitignored (it holds account data). No secrets are stored
# in this file — the token is passed at runtime.
#
# Usage:
#   .\pull-all.ps1 -Token "your-secret"                       # defaults to Kings Dental
#   .\pull-all.ps1 -Token "your-secret" -CustomerId 4594075026
#   (or set $env:MCC_API_SECRET once, then just .\pull-all.ps1)

param(
  [string]$Token = $env:MCC_API_SECRET,
  [string]$CustomerId = "9427798225",
  [string]$Base = "https://mcc-manager.netlify.app/.netlify/functions"
)

if (-not $Token) { Write-Error "Provide -Token or set `$env:MCC_API_SECRET first."; exit 1 }

$h = @{ "x-mcc-token" = $Token }
$out = Join-Path $PSScriptRoot "data"
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
  @{ name = "report-campaign"; url = "$Base/report?customerId=$CustomerId&level=campaign&days=30" },
  @{ name = "report-keyword";  url = "$Base/report?customerId=$CustomerId&level=keyword&days=30" },
  @{ name = "report-ad";       url = "$Base/report?customerId=$CustomerId&level=ad&days=30" },
  @{ name = "audit";           url = "$Base/get-audit?limit=200" }
)

foreach ($r in $reads) {
  try {
    $resp = Invoke-RestMethod -Uri $r.url -Headers $h -ErrorAction Stop
    $path = Join-Path $out ("{0}.json" -f $r.name)
    $resp | ConvertTo-Json -Depth 20 | Out-File -FilePath $path -Encoding utf8
    Write-Host ("OK   {0,-13} -> data\{0}.json" -f $r.name)
  } catch {
    Write-Host ("FAIL {0,-13} : {1}" -f $r.name, $_.Exception.Message)
  }
}
Write-Host "Done. JSON files are in $out"
