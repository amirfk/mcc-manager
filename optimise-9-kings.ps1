# optimise-9-kings.ps1 — Kings Dental (9427798225), October 2026 clean-up.
# Evidence: leads-sheet comments (Jan-Oct 2026), report-splits-sep.json, search-terms.json,
# negatives.json, keywords.json, audit.json.
#
#   A. Pause 8 of our OWN keywords that target NHS / free / cheap searchers.
#      They conflict with the "nhs" negative, which is why that negative was added 3 times
#      (Jul 11, Jul 12, Sep 1 - all "applied") and is no longer on the campaign.
#   B. Re-add "nhs" as a negative on Patients-Leads-LP01.
#   C. Patients: block King's College / research / trial confusion (6 leads, 0 booked).
#   D. Tooth Replacement had ZERO negatives. Its top search terms were funded-implant seekers
#      ("dental implants for disabled", "help with dental implants", "low cost", "eligibility").
#   E. Tooth Replacement: Search Partners OFF (98% of its September spend was on partner sites).
#   F. All 3 campaigns: location option PRESENCE (29% of Sept spend came from people outside
#      the target area, CPA GBP26.63 vs GBP16.12; 18 leads said "too far", 0 booked).
#
# E and F need the set_campaign_network / set_geo_target_type actions -> DEPLOY FIRST.
#
#   .\optimise-9-kings.ps1            # dry run (nothing changes)
#   .\optimise-9-kings.ps1 -Confirm   # apply

param(
  [string]$Token = $env:MCC_API_SECRET,
  [switch]$Confirm,
  [string]$CustomerId = "9427798225",
  [string]$Url = "https://mcc-manager.netlify.app/.netlify/functions/manage"
)
if (-not $Token) { Write-Error "Set `$env:MCC_API_SECRET first."; exit 1 }
$h = @{ "x-mcc-token" = $Token }
$apply = [bool]$Confirm
$fails = 0

function Send($o){ $o["customerId"]=$CustomerId; if($apply){$o["confirm"]=$true}
  $b = $o | ConvertTo-Json -Depth 8 -Compress
  try { return Invoke-RestMethod -Uri $Url -Method Post -Headers $h -Body $b -ContentType "application/json" -TimeoutSec 120 -ErrorAction Stop }
  catch {
    $resp=$_.Exception.Response
    if($resp -and ($resp|Get-Member -Name GetResponseStream)){ $sr=New-Object System.IO.StreamReader($resp.GetResponseStream()); return ($sr.ReadToEnd()|ConvertFrom-Json) }
    elseif($_.ErrorDetails -and $_.ErrorDetails.Message){ try{return ($_.ErrorDetails.Message|ConvertFrom-Json)}catch{return [pscustomobject]@{ok=$false;error=$_.ErrorDetails.Message}} }
    else{ return [pscustomobject]@{ok=$false;error=$_.Exception.Message} } } }
function Show($label, $r){
  Write-Host ("   {0,-46} ok={1}" -f $label, $r.ok)
  if(-not $r.ok){ $script:fails++; Write-Host ("      -> " + ($r | ConvertTo-Json -Depth 6 -Compress)) }
}

$PATIENTS = "22124766621"; $TOOTH = "24203222393"; $PMAX = "22896785921"

Write-Host ("=== MODE: {0} ===" -f $(if($apply){"APPLY"}else{"DRY RUN (nothing changes)"}))

Write-Host "`n-- A. Pause our own NHS/free/cheap keywords (they cancel the negatives) --"
$selfDefeating = @(
  @{ ag="172946086545"; crit="335801195945"; kw="free tooth pulling near me" },
  @{ ag="172777892319"; crit="303941465469"; kw="periodontist nhs" },
  @{ ag="172777892319"; crit="342062473194"; kw="gum specialist nhs" },
  @{ ag="172777892319"; crit="805049037299"; kw="nhs periodontist near me" },
  @{ ag="168727228690"; crit="25658081";     kw="cheap implants" },
  @{ ag="168727228690"; crit="295627064079"; kw="implants on nhs" },
  @{ ag="168727228690"; crit="295969627187"; kw="nhs bridge cost" },
  @{ ag="168727228690"; crit="318938829070"; kw="cheap implants near me" }
)
foreach($k in $selfDefeating){ Show ("pause '" + $k.kw + "'") (Send @{ action="set_keyword_status"; adGroupId=$k.ag; criterionId=$k.crit; status="PAUSED" }) }

Write-Host "`n-- B + C. Patients-Leads-LP01 negatives --"
foreach($n in @(
  @{t="nhs";m="BROAD"}, @{t="research";m="BROAD"}, @{t="trial";m="BROAD"}, @{t="trials";m="BROAD"},
  @{t="college";m="BROAD"}, @{t="dental institute";m="PHRASE"} )){
  Show ("[" + $n.m + "] " + $n.t) (Send @{ action="add_negative_keyword"; campaignId=$PATIENTS; text=$n.t; matchType=$n.m })
}

Write-Host "`n-- D. Tooth Replacement negatives (it had none) --"
$broad  = @("nhs","free","cheap","disabled","disability","grant","grants","government","funding","funded",
            "charity","eligibility","eligible","benefits","pensioner","research","trial","trials","study",
            "clinical","university","college","hospital","exempt","111","register")
$phrase = @("low cost","help with","how to","over 60","over 60s","dental school","dental hospital")
foreach($t in $broad){  Show ("[BROAD] "  + $t) (Send @{ action="add_negative_keyword"; campaignId=$TOOTH; text=$t; matchType="BROAD" }) }
foreach($t in $phrase){ Show ("[PHRASE] " + $t) (Send @{ action="add_negative_keyword"; campaignId=$TOOTH; text=$t; matchType="PHRASE" }) }

Write-Host "`n-- E. Tooth Replacement: Search Partners OFF --"
$r = Send @{ action="set_campaign_network"; campaignId=$TOOTH; searchPartners=$false }
Show "search partners off" $r
if($r.ok -and $r.preview){ Write-Host ("      " + ($r.preview.old | ConvertTo-Json -Compress) + " -> " + ($r.preview.new | ConvertTo-Json -Compress)) }

Write-Host "`n-- F. Location option: PRESENCE (people actually in the area) --"
foreach($c in @(@{id=$PATIENTS;nm="Patients-Leads-LP01"},@{id=$TOOTH;nm="Tooth Replacement"},@{id=$PMAX;nm="Performance Max"})){
  $r = Send @{ action="set_geo_target_type"; campaignId=$c.id; positive="PRESENCE" }
  Show ($c.nm + " -> PRESENCE") $r
  if($r.ok -and $r.preview){ Write-Host ("      " + $r.preview.old.positive + " -> " + $r.preview.new.positive) }
}

Write-Host ""
if($fails){ Write-Host ("{0} item(s) failed - paste the output. 'Unknown action' on E/F means the deploy hasn't finished." -f $fails) }
if(-not $apply){ Write-Host "DRY RUN. Re-run with -Confirm to apply." }
else { Write-Host "Applied. Re-pull: .\pull-all.ps1  - then check negatives.json (nhs on Patients) and campaigns.json (search_partners / location_option)." }
