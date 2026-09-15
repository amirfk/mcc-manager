# optimise-6-goals.ps1 — demote junk + duplicate conversion actions to SECONDARY.
#
# Measured from the Aug 2026 conversion-action report: Google counted 197
# "conversions" in a month the clinic booked 5 patients. 108 of those (55%) were
# Local-actions noise and 45 (23%) were a duplicate £0 booking action - so 78%
# of the Smart Bidding signal was junk. Demoting keeps them REPORTABLE but stops
# them driving bids.
#
# Requires the set_conversion_primary action (deploy manage.js first).
# DRY RUN unless -Confirm.
#
#   $env:MCC_API_SECRET = "your-secret"
#   .\optimise-6-goals.ps1            # preview
#   .\optimise-6-goals.ps1 -Confirm   # apply

param(
  [string]$Token = $env:MCC_API_SECRET,
  [switch]$Confirm,
  [string]$CustomerId = "9427798225",
  [string]$Url = "https://mcc-manager.netlify.app/.netlify/functions/manage"
)
if (-not $Token) { Write-Error "Set `$env:MCC_API_SECRET or pass -Token."; exit 1 }
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

# Aug 2026 volume in brackets - why each one goes Secondary.
$demote = @(
  @{ id="7508377323"; nm="Local actions - Other engagements"; why="60 conv, GBP1 each - pure noise" },
  @{ id="6687204633"; nm="Local actions - Directions";        why="26 conv, GBP1 each - map taps" },
  @{ id="7509273562"; nm="Local actions - Website visits";    why="22 conv, GBP1 each - visit pings" },
  @{ id="7568918079"; nm="Local actions - Menu views";        why="0 conv but still PRIMARY - pre-empt" },
  @{ id="7034758458"; nm="New patient book appointment";      why="45 conv at GBP0 - duplicates 'Book appointment new'" }
)

Write-Host ("=== MODE: {0} ===`n" -f $(if($apply){"APPLY"}else{"DRY RUN (nothing changes)"}))
Write-Host "-- Demote junk / duplicate actions to SECONDARY --"
foreach($d in $demote){
  $r = Send @{ action="set_conversion_primary"; conversionActionId=$d.id; primary=$false }
  Write-Host ("   {0,-36} ok={1}  {2} -> {3}" -f $d.nm, $r.ok, $r.preview.old, $r.preview.new)
  Write-Host ("      ({0})" -f $d.why)
  if(-not $r.ok){ Write-Host ("      -> {0}" -f $r.error) }
}

Write-Host "`n-- KEPT PRIMARY (the real signal) --"
Write-Host "   Book appointment new      (form-fill, GBP75)"
Write-Host "   ad-pilot Booked Patient   (real booked revenue, offline upload)"
Write-Host "   Calls from ads            (genuine ad call)"
Write-Host "   Clicks to call / Contact Us (low volume, real intent)"

if(-not $apply){ Write-Host "`nDRY RUN. Re-run with -Confirm to apply." }
else { Write-Host "`nDone. Expect the reported conversion count to DROP sharply - that is correct. Re-judge P-Max in ~2 weeks on the clean signal." }
