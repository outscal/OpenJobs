# OpenJobs

> An open dataset of **12,144 gaming and tech companies** with the countries they hire in, plus a Node CLI that turns that dataset into a live feed of real job openings by querying each company's public ATS (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Workday, Teamtailor, Recruitee, Personio, Breezy, BambooHR, Jobvite, Join.com).

> **Fork notice.** This project is a fork of **[santifer/career-ops](https://github.com/santifer/career-ops)** maintained by [Outscal](https://outscal.com). MIT-licensed, all original attribution to Santiago Fernández preserved. Upstream remains the source of truth for the evaluation/CV/pipeline system; this fork adds the company dataset and the multi-ATS job harvester on top.

![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat&logo=node.js&logoColor=white)
![License MIT](https://img.shields.io/badge/License-MIT-blue.svg)

---

## The dataset — `data/companies_v2.json`

One JSON file, 12,144 records, one object per company:

```jsonc
{
  "name": "Virtusa",
  "website": "https://www.virtusa.com",
  "industry_category": "tech",      // "gaming" | "tech"
  "type": "tech",
  "game_genre": ["mobile", "pc-console-aaa"],
  "tech_stack": ["unity", "c#"],
  "ats_links":  ["https://careers.virtusa.com/..."],
  "list_urls":  ["https://careers.virtusa.com/..."],
  "countries":  ["Canada", "India", "Spain", "Sri Lanka",
                 "United Arab Emirates", "United Kingdom", "United States"]
}
```

**What's in it today**

| | |
|---|---|
| Companies total | **12,144** |
| With an `ats_links` entry | **7,007** |
| Routable to a working ATS adapter today | **~2,100** |
| With at least one known hiring country | **2,529** |
| Unique countries represented | **155** |
| Industry split | 8,350 gaming · 2,534 tech |

**Top countries** (by number of companies hiring there): United States (1,301), India (817), United Kingdom (670), Canada (493), Germany (373), Australia (291), France (254), Japan (248), Singapore (236), Spain (223), Poland (217), Mexico (211), Netherlands (209), Brazil (193), China (171).

The `countries` array is derived by joining each company's job postings against a geocoded `locations` table and taking the set of unique countries. See [Regenerating `countries`](#regenerating-the-countries-field) below.

---

## Searching the dataset

The dataset is plain JSON — you can query it with `jq`, a one-liner in Node, or whatever you prefer. A few recipes to get you started.

### 1. Companies hiring in a specific country

```bash
# Every gaming company currently hiring in Japan
jq '[.[] | select(.industry_category == "gaming" and (.countries // []) | index("Japan"))] | length' data/companies_v2.json

# List their names and websites
jq -r '.[] | select(.industry_category == "gaming" and (.countries // []) | index("Japan")) | "\(.name)\t\(.website)"' data/companies_v2.json
```

### 2. Companies with jobs in **multiple** countries (likely to sponsor relocation)

```bash
jq -r '.[] | select((.countries // []) | length >= 5) | "\(.name)\t\(.countries | length)\t\(.countries | join(", "))"' data/companies_v2.json | sort -t$'\t' -k2 -nr | head -20
```

### 3. Filter by tech stack

```bash
# Unity studios
jq -r '.[] | select((.tech_stack // []) | index("unity")) | .name' data/companies_v2.json

# Unreal + AAA console
jq -r '.[] | select((.tech_stack // []) | index("unreal")) | select((.game_genre // []) | index("pc-console-aaa")) | .name' data/companies_v2.json
```

### 4. Filter by ATS host (useful if you've memorized one vendor's form)

```bash
jq -r '.[] | select(.ats_links[]? | test("greenhouse.io")) | "\(.name)\t\(.ats_links[])"' data/companies_v2.json
```

### 5. In JavaScript

```js
import companies from './data/companies_v2.json' assert { type: 'json' };

const gamingInJapan = companies.filter(
  c => c.industry_category === 'gaming' && c.countries?.includes('Japan')
);
```

Use these to narrow down to a shortlist, then feed that shortlist to the harvester below to pull live openings.

---

## Harvesting live jobs — `harvest.mjs`

`harvest.mjs` reads `data/companies_v2.json`, routes each company through the ATS adapter registry, calls the public API for that ATS, applies your keyword and location filters, and writes a CSV of current openings.

```bash
# 1. Install
npm install

# 2. (optional) Point the harvester at roles you actually want — edit portals.yml
cp templates/portals.example.yml portals.yml

# 3. Run it
node harvest.mjs                            # full sweep across all routable companies
node harvest.mjs --dry-run                  # count only, no CSV
node harvest.mjs --limit 50 --dry-run       # quick smoke test
```

### Filter flags

| Flag | Effect |
|---|---|
| `--industry gaming` \| `--industry tech` | Only companies whose `industry_category` matches |
| `--country india` (or `us`, `uk`, `eu`, `apac`, `remote`, `japan`, `germany`, `france`, `canada`, `australia`, `netherlands`, `singapore`, …) | Filters jobs by location keywords at harvest time. Unknown values are used literally, so `--country Portugal` works too |
| `--company "Riot Games"` | Single-company run (substring match) |
| `--ats greenhouse` | Only companies routed to one adapter — handy for debugging |
| `--limit 20` | Stop after N routable companies |
| `--no-filter` | Skip keyword/location filtering — dump everything |

### Output

- `output/jobs-YYYY-MM-DD.csv` — the matched openings: company, title, location, URL, tech stack.
- `output/jobs-manual-YYYY-MM-DD.csv` — companies whose `ats_links` point at LinkedIn/Wellfound/similar (no public API) — flagged for you to scrape manually.

### How to think about the two filter layers

The dataset's `countries` field tells you **where a company has historically posted jobs** — good for building a shortlist. The harvester's `--country` / `portals.yml` filters run against **the live feed**, matching on location keywords in each specific posting. Use the dataset to pick your targets, then let the harvester apply a second, per-posting filter.

---

## Expanding the dataset — `probe-ats.mjs`

Companies come and go on ATS platforms. `probe-ats.mjs` slug-probes every un-routed company in `data/companies_v2.json` against seven public ATS APIs (Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee, Breezy, BambooHR), discovers boards that were missed at ingest, and writes a candidate CSV you can merge back.

```bash
# 1. Discover
node probe-ats.mjs                                              # ~40 min, writes output/ats-probe-YYYY-MM-DD.csv

# 2. Review the CSV — sort by matched_ats, eyeball sample_title for slug collisions

# 3. Dry-run merge — see what would change
node merge-probe-hits.mjs --csv output/ats-probe-YYYY-MM-DD.csv

# 4. Apply (writes a backup first, idempotent)
node merge-probe-hits.mjs --csv output/ats-probe-YYYY-MM-DD.csv --write
```

Workable and Personio are skipped by default (aggressive IP rate-limits); flip them on in `probe-ats.mjs` if you want a slower separate pass.

---

## Regenerating the `countries` field

`enrich-companies-countries.mjs` rebuilds the `countries` array on every company in `companies_v2.json` by joining the internal jobs → locations tables. It's **Outscal-internal** — you need credentials to the production MongoDB to run it — but the script itself is included so the derivation logic is transparent.

```bash
MONGO_URI="mongodb+srv://<user>:<pw>@<cluster>/outscal" node enrich-companies-countries.mjs
```

The script writes a `.bak` sibling file before overwriting, and the aggregation it runs is the same one shown in the script header — easy to adapt if you have your own jobs dataset.

---

## Staying in sync with upstream career-ops

Two paths, not mutually exclusive.

### Path 1: `update-system.mjs` (zero setup)

```bash
node update-system.mjs check      # is a new upstream version published?
node update-system.mjs apply      # pull system-layer files only
node update-system.mjs rollback   # undo the last update
```

Pulls generic system files (modes, PDF scripts, dashboard, templates) from [santifer/career-ops](https://github.com/santifer/career-ops) — never touches `data/companies_v2.json`, `harvest.mjs`, `adapters/`, `probe-ats.mjs`, or your own `cv.md` / `config/profile.yml`. The upstream URL is hardcoded in the script, so clones get sync for free.

### Path 2: Git `upstream` remote (for visibility / cherry-picking)

```bash
git remote add upstream https://github.com/santifer/career-ops.git
git remote set-url --push upstream DISABLED
git fetch upstream
git log upstream/main --oneline
git cherry-pick <sha>
```

Direct `git merge upstream/main` is not recommended — this fork's history is a clean initial commit without shared history with upstream.

---

## What else is in this repo

The upstream career-ops system is still fully present and functional. You get it for free on top of the dataset and harvester:

- Paste a job URL → full A-G evaluation, tailored PDF CV, tracker entry
- Portal scanner, batch evaluation with parallel workers
- Terminal dashboard (`dashboard/`) for browsing your pipeline
- Interview prep / story bank, follow-up cadence, negotiation scripts
- Slash command — `/outscal-jobs` (alias `/career-ops`) — for Claude Code and OpenCode users

None of that is required. If you only want the dataset and the harvester, you can ignore `modes/`, `batch/`, `dashboard/`, `generate-pdf.mjs`, and the `.claude/` skills entirely.

---

## Project structure (the parts this README is about)

```
open-jobs/
├── data/
│   └── companies_v2.json             # The dataset. 12,144 companies.
├── adapters/                         # 13 ATS adapters (common detect/fetchJobs interface)
├── harvest.mjs                       # Main harvester — dataset → CSV of live jobs
├── probe-ats.mjs                     # Dataset expansion: slug-probe for new ATS boards
├── merge-probe-hits.mjs              # Apply probe output back to companies_v2.json
├── enrich-companies-countries.mjs    # Rebuild the `countries` field from the internal DB
├── portals.yml                       # Your title/location filters for harvest.mjs
└── output/                           # Harvest CSVs (gitignored)
```

---

## License and disclaimer

MIT. See [`LICENSE`](LICENSE) and [`LEGAL_DISCLAIMER.md`](LEGAL_DISCLAIMER.md).

Using the harvester means hitting third-party ATS APIs (Greenhouse, Lever, Ashby, etc.). You are responsible for complying with each ATS's terms of service. Don't use this tool to spam employers or overwhelm ATS systems — the harvester's concurrency (`CONCURRENCY = 10` in `harvest.mjs`) and the probe's rate-limit handling exist to keep you in the nice-citizen zone. Leave them that way.

No guarantees about data freshness. The `countries` field is a point-in-time snapshot of the internal jobs table; `ats_links` can go stale as companies migrate vendors. Re-run `probe-ats.mjs` and `enrich-companies-countries.mjs` periodically to keep the dataset current.
