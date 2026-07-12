# boost-endo.ps1 — reinforce the EXISTING Endo ad group (your best performer)
# with high-intent root-canal keywords + a sharper RSA. Does NOT create a new
# ad group. DRY RUN unless -Confirm. New ad is created PAUSED for review.
#
#   $env:MCC_API_SECRET = "your-secret"
#   .\boost-endo.ps1            # preview
#   .\boost-endo.ps1 -Confirm   # apply (keywords live; new ad PAUSED)

param(
  [string]$Token = $env:MCC_API_SECRET,
  [switch]$Confirm,
  [string]$CustomerId = "9427798225",
  [string]$AdGroupId = "173619569236",     # existing Endo ad group (Patients-Leads-LP01)
  [string]$FinalUrl = "https://kingstonendodontist.com/main-page/",
  [string]$Url = "https://mcc-manager.netlify.app/.netlify/functions/manage"
)
if (-not $Token) { Write-Error "Set `$env:MCC_API_SECRET or pass -Token."; exit 1 }
$h = @{ "x-mcc-token" = $Token }
$apply = [bool]$Confirm

function Send($obj) {
  $obj["customerId"] = $CustomerId
  if ($apply) { $obj["confirm"] = $true }
  $body = $obj | ConvertTo-Json -Depth 8 -Compress
  try { return Invoke-RestMethod -Uri $Url -Method Post -Headers $h -Body $body -ContentType "application/json" -ErrorAction Stop }
  catch { $r = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream()); return ($r.ReadToEnd() | ConvertFrom-Json) }
}

$keywords = @(
  "root canal treatment", "root canal near me", "root canal specialist",
  "emergency root canal", "root canal dentist", "root canal retreatment",
  "endodontist near me", "save my tooth"
)
$headlines = @(
  "Root Canal Specialists", "Kings Dental Specialists", "Save Your Natural Tooth",
  "Microscope Root Canals", "Specialist Endodontist", "Emergency Appointments",
  "Root Canal in Kingston", "Board-Certified Experts", "Pain-Free Root Canal",
  "Book a Consultation", "0% Finance Available", "Same-Day Emergency Care",
  "Retreatment Specialists", "Trusted by Local Dentists", "Nervous Patients Welcome"
)
$descriptions = @(
  "Specialist endodontist in Kingston. Microscopic root canal to save your tooth.",
  "In pain? Same-day emergency root canal by board-certified experts. Book today.",
  "Save your natural tooth with precise, pain-free root canal treatment. 0% finance.",
  "Complex & failed root canals retreated. Trusted referral clinic in Kingston."
)

Write-Host ("=== MODE: {0} ===`n" -f $(if ($apply) { "APPLY" } else { "DRY RUN (nothing changes)" }))

Write-Host "-- Keywords into existing Endo ad group $AdGroupId (PHRASE) --"
foreach ($k in $keywords) {
  $r = Send @{ action = "add_keyword"; adGroupId = $AdGroupId; text = $k; matchType = "PHRASE"; exemptPolicyViolations = $true }
  Write-Host ("  '{0}': ok={1} dry_run={2}" -f $k, $r.ok, $r.dry_run)
  if (-not $r.ok) { Write-Host ("     -> {0}" -f $r.error) }
}

Write-Host "`n-- New responsive search ad (PAUSED) --"
$rsa = Send @{ action = "create_ad"; adGroupId = $AdGroupId; headlines = $headlines; descriptions = $descriptions; finalUrl = $FinalUrl; exemptPolicyViolations = $true }
Write-Host ("  ok={0} dry_run={1}" -f $rsa.ok, $rsa.dry_run)
if (-not $rsa.ok) { $rsa | ConvertTo-Json -Depth 8 | Write-Host }

if (-not $apply) { Write-Host "`nDRY RUN. Re-run with -Confirm (keywords go live; the new ad is created PAUSED for you to review/enable)." }
else { Write-Host "`nDone. New endo keywords are live; the new RSA is PAUSED - review it, then enable with set_ad_status." }
