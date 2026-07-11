# go-live-prosthodontist.ps1
# Enables the Prosthodontist ad group + its ad so it starts serving.
# Finds the ad automatically. DRY RUN unless you pass -Confirm.
#
#   .\go-live-prosthodontist.ps1 -Token "your-secret"            # preview
#   .\go-live-prosthodontist.ps1 -Token "your-secret" -Confirm   # GO LIVE

param(
  [string]$Token = $env:MCC_API_SECRET,
  [switch]$Confirm,
  [string]$CustomerId = "9427798225",
  [string]$CampaignId = "22124766621",
  [string]$AdGroupId = "196978826574",
  [string]$Root = "https://mcc-manager.netlify.app/.netlify/functions"
)
if (-not $Token) { Write-Error "Provide -Token or set `$env:MCC_API_SECRET first."; exit 1 }
$h = @{ "x-mcc-token" = $Token }
$apply = [bool]$Confirm

function Manage($obj) {
  $obj["customerId"] = $CustomerId
  if ($apply) { $obj["confirm"] = $true }
  $body = $obj | ConvertTo-Json -Depth 8 -Compress
  try { return Invoke-RestMethod -Uri "$Root/manage" -Method Post -Headers $h -Body $body -ContentType "application/json" -ErrorAction Stop }
  catch { $r = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream()); return ($r.ReadToEnd() | ConvertFrom-Json) }
}

Write-Host ("=== MODE: {0} ===`n" -f $(if ($apply) { "GO LIVE" } else { "DRY RUN (nothing changes)" }))

# Find the ad in the new ad group
$ads = Invoke-RestMethod -Uri "$Root/list-ads?customerId=$CustomerId&campaignId=$CampaignId" -Headers $h
$ad = $ads.ads | Where-Object { "$($_.ad_group_id)" -eq $AdGroupId } | Select-Object -First 1
if (-not $ad) { Write-Error "No ad found in ad group $AdGroupId. Nothing to enable."; exit 1 }
Write-Host ("Found ad {0} in ad group {1} (current status: {2})" -f $ad.ad_id, $AdGroupId, $ad.status)

# 1) enable the ad group
$g = Manage @{ action = "set_ad_group_status"; adGroupId = $AdGroupId; status = "ENABLED" }
Write-Host ("ad group -> ENABLED: ok={0} dry_run={1}" -f $g.ok, $g.dry_run)

# 2) enable the ad
$a = Manage @{ action = "set_ad_status"; adGroupId = $AdGroupId; adId = "$($ad.ad_id)"; status = "ENABLED" }
Write-Host ("ad {0} -> ENABLED: ok={1} dry_run={2}" -f $ad.ad_id, $a.ok, $a.dry_run)

if (-not $apply) { Write-Host "`nDRY RUN. Re-run with -Confirm to go live." }
else { Write-Host "`nLIVE. The Prosthodontist ad group and ad are now serving against /prosthodontist/." }
