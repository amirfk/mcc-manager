# apply-prosthodontist.ps1
# Builds the Prosthodontist push in the EXISTING live Search campaign
# (Patients-Leads-LP01, 22124766621), pointed at the new /prosthodontist/ page.
#
# Safe by design: DRY RUN unless you pass -Confirm. Everything created is PAUSED,
# so nothing serves until you review it in Google Ads and enable it.
#
#   .\apply-prosthodontist.ps1 -Token "your-secret"            # dry run (preview)
#   .\apply-prosthodontist.ps1 -Token "your-secret" -Confirm   # actually build (paused)

param(
  [string]$Token = $env:MCC_API_SECRET,
  [switch]$Confirm,
  [string]$CustomerId = "9427798225",
  [string]$CampaignId = "22124766621",
  [string]$Url = "https://mcc-manager.netlify.app/.netlify/functions/manage",
  [string]$FinalUrl = "https://kingstonendodontist.com/prosthodontist/"
)
if (-not $Token) { Write-Error "Provide -Token or set `$env:MCC_API_SECRET first."; exit 1 }
$h = @{ "x-mcc-token" = $Token }
$apply = [bool]$Confirm

function Send($obj) {
  $obj["customerId"] = $CustomerId
  if ($apply) { $obj["confirm"] = $true }
  $body = $obj | ConvertTo-Json -Depth 8 -Compress
  try { return Invoke-RestMethod -Uri $Url -Method Post -Headers $h -Body $body -ContentType "application/json" -ErrorAction Stop }
  catch {
    $r = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    return ($r.ReadToEnd() | ConvertFrom-Json)
  }
}

$headlines = @(
  "Prosthodontist in Kingston","Kings Dental Specialists","Replace Missing Teeth",
  "Implants, Bridges & Dentures","Crowns, Veneers & Bridges","Full Mouth Rehabilitation",
  "Specialist Restorative Care","Private Specialist Clinic","Dr Praniith Selvaranjan",
  "Book a Consultation","0% Finance Available","Complex Cases Welcomed",
  "Eat & Smile Confidently","Natural-Looking Results","Nervous Patients Welcome"
)
$descriptions = @(
  "Specialist prosthodontist in Kingston. Implants, dentures, crowns & full-mouth care.",
  "Private specialist-led restorative dentistry. 0% finance. Book your consultation.",
  "Replace missing, worn or broken teeth with a plan built around you and your bite.",
  "Complex cases welcomed. Digital CBCT planning, natural-looking, comfortable results."
)
$keywords = @(
  "prosthodontist","prosthodontist near me","dental implants kingston",
  "full mouth dental implants","dentures kingston","private dentures",
  "dental bridge","replace missing teeth","full mouth rehabilitation"
)

Write-Host ("=== MODE: {0} ===`n" -f $(if ($apply) { "APPLY (creates real, PAUSED entities + live negatives)" } else { "DRY RUN (nothing changes)" }))

# 1) Leak-fix negatives on the live campaign
Write-Host "-- Negatives on Patients-Leads-LP01 --"
foreach ($n in @("nhs", "free")) {
  $r = Send @{ action = "add_negative_keyword"; campaignId = $CampaignId; text = $n; matchType = "BROAD" }
  Write-Host ("  negative '{0}': ok={1}" -f $n, $r.ok)
}

# 2) Create the Prosthodontist ad group (PAUSED)
Write-Host "`n-- Ad group 'Prosthodontist' (PAUSED) --"
$ag = Send @{ action = "create_ad_group"; campaignId = $CampaignId; name = "Prosthodontist"; status = "PAUSED" }
Write-Host ("  ok={0} dry_run={1}" -f $ag.ok, $ag.dry_run)

if (-not $apply) {
  Write-Host "`nDRY RUN complete. Planned build:"
  Write-Host "  Keywords (PHRASE):"; $keywords | ForEach-Object { Write-Host "    - $_" }
  Write-Host "  RSA headlines:";    $headlines | ForEach-Object { Write-Host "    - $_" }
  Write-Host "  RSA descriptions:"; $descriptions | ForEach-Object { Write-Host "    - $_" }
  Write-Host "`nRe-run with -Confirm to build it (ad group + ad created PAUSED; negatives go live)."
  exit 0
}

# --- APPLY path ---
$agId = ($ag.result.results[0].resourceName -split "/")[-1]
if (-not $agId) { Write-Error "Could not read new ad group id. Response:"; $ag | ConvertTo-Json -Depth 8; exit 1 }
Write-Host ("  new ad group id: {0}" -f $agId)

Write-Host "`n-- Keywords --"
foreach ($k in $keywords) {
  $r = Send @{ action = "add_keyword"; adGroupId = $agId; text = $k; matchType = "PHRASE"; exemptPolicyViolations = $true }
  Write-Host ("  '{0}': ok={1}" -f $k, $r.ok)
}

Write-Host "`n-- Responsive search ad (PAUSED) --"
$rsa = Send @{ action = "create_ad"; adGroupId = $agId; headlines = $headlines; descriptions = $descriptions; finalUrl = $FinalUrl; exemptPolicyViolations = $true }
Write-Host ("  ok={0}" -f $rsa.ok)
if (-not $rsa.ok) { $rsa | ConvertTo-Json -Depth 8 | Write-Host }

Write-Host "`nDone. The ad group and ad are PAUSED. Review in Google Ads, then enable the"
Write-Host "ad group + ad (set_ad_group_status / set_ad_status) when you're happy."
