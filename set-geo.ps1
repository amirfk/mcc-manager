# set-geo.ps1 — switch the live Search campaign to a radius around Kingston.
# Reads the campaign's current location criteria, then atomically removes them
# and sets a proximity (radius) target. DRY RUN unless -Confirm.
#
#   $env:MCC_API_SECRET = "your-new-secret"
#   .\set-geo.ps1                 # preview
#   .\set-geo.ps1 -Confirm        # apply

param(
  [string]$Token = $env:MCC_API_SECRET,
  [switch]$Confirm,
  [string]$CustomerId = "9427798225",
  [string]$CampaignId = "22124766621",   # Patients-Leads-LP01 (live Search)
  [double]$Lat = 51.4129,                # Kingston upon Thames town centre
  [double]$Lng = -0.3007,
  [double]$Radius = 10,
  [string]$RadiusUnits = "MILES",
  [string]$Root = "https://mcc-manager.netlify.app/.netlify/functions"
)
if (-not $Token) { Write-Error "Set `$env:MCC_API_SECRET or pass -Token."; exit 1 }
$h = @{ "x-mcc-token" = $Token }
$apply = [bool]$Confirm

Write-Host ("=== MODE: {0} ===`n" -f $(if ($apply) { "APPLY" } else { "DRY RUN (nothing changes)" }))

# 1) current location criteria on this campaign
$loc = Invoke-RestMethod -Uri "$Root/list-locations?customerId=$CustomerId&campaignId=$CampaignId" -Headers $h
$ids = @($loc.locations | ForEach-Object { "$($_.criterion_id)" })
Write-Host ("Current location criteria to remove: {0}" -f $(if ($ids.Count) { $ids -join ", " } else { "(none)" }))
$loc.locations | ForEach-Object { Write-Host ("   - {0} {1}" -f $_.name, $(if ($_.excluded) { "[excluded]" } else { "[targeted]" })) }

# 2) atomic swap to radius
$body = @{
  action = "set_geo_radius"; customerId = $CustomerId; campaignId = $CampaignId
  lat = $Lat; lng = $Lng; radius = $Radius; radiusUnits = $RadiusUnits
  removeCriterionIds = $ids
}
if ($apply) { $body["confirm"] = $true }
$json = $body | ConvertTo-Json -Depth 8 -Compress
try { $r = Invoke-RestMethod -Uri "$Root/manage" -Method Post -Headers $h -Body $json -ContentType "application/json" -ErrorAction Stop }
catch { $s = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream()); $r = ($s.ReadToEnd() | ConvertFrom-Json) }

Write-Host ("`nset_geo_radius: ok={0} dry_run={1}" -f $r.ok, $r.dry_run)
if (-not $r.ok) { $r | ConvertTo-Json -Depth 8 | Write-Host }
elseif (-not $apply) { Write-Host ("Would set: {0} {1} radius around {2},{3}; remove {4} location criteria.`nRe-run with -Confirm to apply." -f $Radius, $RadiusUnits, $Lat, $Lng, $ids.Count) }
else { Write-Host ("Done. {0} now targets a {1}-{2} radius around Kingston." -f $CampaignId, $Radius, $RadiusUnits) }
