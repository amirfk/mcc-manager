# optimise-batch.ps1  — the two safe, high-confidence optimisations, dry-run first.
# Also reports Kingston geo candidates (read-only) so we can fix geo next.
#
#   $env:MCC_API_SECRET = "your-new-secret"     # set once, then:
#   .\optimise-batch.ps1                         # dry run (nothing changes)
#   .\optimise-batch.ps1 -Confirm                # apply

param(
  [string]$Token = $env:MCC_API_SECRET,
  [switch]$Confirm,
  [string]$CustomerId = "9427798225",
  [string]$Root = "https://mcc-manager.netlify.app/.netlify/functions",
  # #1 booking conversion action (SUBSCRIBE_PAID "Book appointment new") + value
  [string]$BookingActionId = "7307992712",
  [double]$BookingValue = 350,
  # #2 the money-pit keyword to pause
  [string]$PitAdGroupId = "172777892319",
  [string]$PitCriterionId = "297564532937"
)
if (-not $Token) { Write-Error "Set `$env:MCC_API_SECRET or pass -Token."; exit 1 }
$h = @{ "x-mcc-token" = $Token }
$apply = [bool]$Confirm

function Manage($obj) {
  $obj["customerId"] = $CustomerId
  if ($apply) { $obj["confirm"] = $true }
  $body = $obj | ConvertTo-Json -Depth 8 -Compress
  try { return Invoke-RestMethod -Uri "$Root/manage" -Method Post -Headers $h -Body $body -ContentType "application/json" -ErrorAction Stop }
  catch { $r = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream()); return ($r.ReadToEnd() | ConvertFrom-Json) }
}

Write-Host ("=== MODE: {0} ===`n" -f $(if ($apply) { "APPLY" } else { "DRY RUN (nothing changes)" }))

# 1) Value the booking conversion (always_use_default_value = true so every booking gets it)
Write-Host "-- 1. Value 'Book appointment new' at £$BookingValue --"
$v = Manage @{ action = "set_conversion_value"; conversionActionId = $BookingActionId; value = $BookingValue; alwaysUseDefaultValue = $true }
Write-Host ("   ok={0} dry_run={1}  {2} -> {3}" -f $v.ok, $v.dry_run, $v.preview.old, $v.preview.new)

# 2) Pause the money-pit keyword
Write-Host "`n-- 2. Pause 'periodontist near me' (£28.60 / 0 conv) --"
$k = Manage @{ action = "set_keyword_status"; adGroupId = $PitAdGroupId; criterionId = $PitCriterionId; status = "PAUSED" }
Write-Host ("   ok={0} dry_run={1}  {2}: {3} -> {4}" -f $k.ok, $k.dry_run, $k.preview.target, $k.preview.old, $k.preview.new)

# 3) (read-only) find the right Kingston geo target for the geo fix
Write-Host "`n-- 3. Kingston geo candidates (read-only, for the geo fix next) --"
foreach ($q in @("Kingston upon Thames", "Royal Borough of Kingston upon Thames", "Kingston, London")) {
  try {
    $g = Invoke-RestMethod -Uri "$Root/search-geo?q=$([uri]::EscapeDataString($q))&country=GB" -Headers $h
    Write-Host ("   '{0}':" -f $q)
    $g.geo_targets | ForEach-Object { Write-Host ("      id={0}  {1}  ({2}, reach {3})" -f $_.geo_target_constant_id, $_.canonical_name, $_.target_type, $_.reach) }
  } catch { Write-Host ("   '{0}': lookup failed" -f $q) }
}

if (-not $apply) { Write-Host "`nDRY RUN. Re-run with -Confirm to apply #1 and #2." }
else { Write-Host "`nApplied #1 and #2. Paste the geo candidates and we'll fix geo + de-dupe next." }
