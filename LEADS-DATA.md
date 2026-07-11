# Feeding lead / booking / revenue data for analysis

The Google Ads reads (`pull-all.ps1`) tell us cost and clicks. They **cannot**
tell us which leads became paying patients — that lives in your Google Sheet.
Drop that data here and the optimisation can finally aim at revenue, not taps.

## How to get it here — two options

**Option A (recommended for lead data — keeps personal data private):**
In Google Sheets: `File → Download → Comma-separated values (.csv)` for each tab,
and save the files into the `data\` folder of this project using the names below.
Nothing is published to the internet; the files stay on your machine (and `data\`
is gitignored, so they're never committed).

**Option B (only for non-personal tabs, e.g. monthly revenue totals):**
`File → Share → Publish to web → pick the tab → CSV`, then add a line to
`data\sheet-sources.txt`:

```
revenue,https://docs.google.com/spreadsheets/d/XXXX/pub?gid=0&single=true&output=csv
```

`pull-all.ps1` will then download it automatically. **Do not publish tabs that
contain patient names or contact details** — a published URL is public to anyone.

## Files and columns I need

Put these in `data\`. Column names can differ — I'll adapt — but the *concepts*
matter. The single most valuable column is an **attribution key** (`gclid`, or at
least the campaign/source) that ties a lead back to what drove it.

### `leads.csv`
| column | why it matters |
|--------|----------------|
| `date` | when the lead came in |
| `lead_id` / name | to join to bookings/feedback |
| `gclid` **or** `campaign` / `source` | **the linchpin** — ties the lead to a campaign/keyword |
| `treatment` / enquiry type | implant vs general — value differs hugely |
| `status` | new / contacted / qualified / junk |

### `bookings.csv`
| column | why it matters |
|--------|----------------|
| `date` | when they booked |
| `lead_id` / name | join back to the lead (and its gclid) |
| `treatment` | what they booked |
| `amount` / quoted or paid | the revenue number — the whole point |

### `feedback.csv` (optional)
| column | why it matters |
|--------|----------------|
| `lead_id` / name | join |
| `feedback` / score | quality signal beyond "booked or not" |

### `revenue.csv` (optional but useful)
| column | why it matters |
|--------|----------------|
| `month` | e.g. 2026-06 |
| `revenue` | total collected that month — sanity-check against ad spend |

## What it unlocks

With `leads.csv` carrying `gclid` + `treatment` + whether they booked and paid, I can:
- compute **true cost per paying patient** per campaign / keyword (not per form-fill),
- see which keywords produce implants vs. tyre-kickers,
- value your `Book appointment new` conversion at real average case value,
- and set up **offline conversion import** so Google bids toward revenue.
