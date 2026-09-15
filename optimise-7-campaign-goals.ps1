# optimise-7-campaign-goals.ps1 — stop junk conversion CATEGORIES from driving bids.
#
# Why this exists: the four "Local actions - *" conversion actions are generated
# by the Google Business Profile and are READ-ONLY over the API
# (MUTATE_NOT_ALLOWED), so optimise-6 could not demote them. This does the same
# job from the other end - it switches their (category, origin) pair off for
# bidding on each active campaign. They stay recorded and reportable; they just
# stop shaping bids.
#
# Aug 2026 measurement: 197 "conversions" in a month with 5 booked patients.
#   Local actions - Other engagements  60   (ENGAGEMENT / GOOGLE_HOSTED)
#   Local actions - Directions         26   (GET_DIRECTIONS / GOOGLE_HOSTED)
#   Local actions - Website visits     22   (PAGE_VIEW / GOOGLE_HOSTED)
#
# NOTE: setting ANY campaign conversion goal switches that campaign from
# account-default goals to CAMPAIGN-SPECIFIC goals. That is intended - it is
# what gives us per-campaign control. Verify in the UI afterwards.
#
# DRY RUN unless -Confirm.
#   .\optimise-7-campaign-goals.ps1            # preview
#   .\optimise-7-campaign-goals.ps1 -Confirm   # apply

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

$campaigns = @(
  @{ id="22124766621"; nm="Patients-Leads-LP01" },
  @{ id="22896785921"; nm="Performance Max Kings Dental" },
  @{ id="24203222393"; nm="Tooth Replacement - 2026-09" }
)

# Junk pairs -> stop feeding bidding.
$off = @(
  @{ c="ENGAGEMENT";     o="GOOGLE_HOSTED" },   # Local actions - Other engagements (60)
  @{ c="GET_DIRECTIONS"; o="GOOGLE_HOSTED" },   # Local actions - Directions (26)
  @{ c="GET_DIRECTIONS"; o="WEBSITE" },         # Get directions
  @{ c="PAGE_VIEW";      o="GOOGLE_HOSTED" },   # Local actions - Website visits / Menu views (22)
  @{ c="CONTACT";        o="GOOGLE_HOSTED" },   # Clicks to call (GMB tap)
  @{ c="CONTACT";        o="WEBSITE" }          # Contact Us
)

# Real signal -> keep feeding bidding.
$on = @(
  @{ c="PURCHASE";        o="WEBSITE" },        # ad-pilot Booked Patient (real revenue)
  @{ c="SUBSCRIBE_PAID";  o="WEBSITE" },        # Book appointment new (GBP75 form-fill)
  @{ c="PHONE_CALL_LEAD"; o="CALL_FROM_ADS" },  # Calls from ads
  @{ c="SUBMIT_LEAD_FORM";o="WEBSITE" }
)

Write-Host ("=== MODE: {0} ===`n" -f $(if($apply){"APPLY"}else{"DRY RUN (nothing changes)"}))

foreach($cam in $campaigns){
  Write-Host ("-- {0} ({1}) --" -f $cam.nm, $cam.id)
  foreach($g in $off){
    $r = Send @{ action="set_campaign_conversion_goal"; campaignId=$cam.id; category=$g.c; origin=$g.o; biddable=$false }
    Write-Host ("   OFF {0,-16}/{1,-14} ok={2}" -f $g.c, $g.o, $r.ok)
    if(-not $r.ok){ $r | ConvertTo-Json -Depth 8 -Compress | Write-Host }
  }
  foreach($g in $on){
    $r = Send @{ action="set_campaign_conversion_goal"; campaignId=$cam.id; category=$g.c; origin=$g.o; biddable=$true }
    Write-Host ("   ON  {0,-16}/{1,-14} ok={2}" -f $g.c, $g.o, $r.ok)
    if(-not $r.ok){ $r | ConvertTo-Json -Depth 8 -Compress | Write-Host }
  }
  Write-Host ""
}

if(-not $apply){ Write-Host "DRY RUN. Re-run with -Confirm to apply." }
else {
  Write-Host "Done. Re-pull and check biddable_categories:"
  Write-Host "   .\pull-all.ps1    (then I'll read data\campaign-goals.json)"
  Write-Host "Expect reported conversions to DROP hard - that is the junk leaving the signal."
}
