# Mode: harvest — Outscal jobs harvester

When the user runs `/outscal-jobs harvest` (or asks to "run the harvester", "pull jobs", "refresh CSV"), execute the Tier 1 pipeline.

## What it does

Reads `data/companies_v2.json` (Outscal's 12,144-company dataset), routes each company to the right ATS adapter in `adapters/`, fetches live jobs via public APIs, applies the title + location filters from `portals.yml`, dedupes against `data/harvest-history.tsv`, and writes:

- `output/jobs-YYYY-MM-DD.csv` — filtered matches (main output)
- `output/jobs-manual-YYYY-MM-DD.csv` — companies on LinkedIn/Wellfound flagged for manual review

No LLM tokens used. Pure HTTP + JSON/XML/HTML parsing. Typical full run: ~4 minutes, ~300 matching roles.

## Supported ATSes (13)

Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Workday, Teamtailor, Recruitee, Personio, Breezy, BambooHR, Jobvite (skipped — no public API), Join.

See `adapters/README.md` for the interface and `adapters/_samples.json` for sample companies per ATS.

## How to run

### Full flag reference

| Flag | Purpose | Example |
|---|---|---|
| `--country <csv>` | Override location filter with country preset(s). Comma-separated. See presets below. | `--country india,remote` |
| `--location <csv>` | Literal location keywords (no expansion). | `--location "Bangalore,Mumbai"` |
| `--industry <name>` | Only companies where `industry_category` matches. | `--industry gaming` |
| `--ats <name>` | Only one ATS adapter (debug). | `--ats greenhouse` |
| `--company <substring>` | Only companies whose name contains this string. | `--company "Riot"` |
| `--limit <N>` | Cap to first N routable companies. | `--limit 100` |
| `--no-filter` | Skip title AND location filter — emit everything. | `--no-filter` |
| `--dry-run` | Count only, do not write CSV. | `--dry-run` |

### Country presets

| Alias | Expands to |
|---|---|
| `india` | India, Delhi, Gurgaon, Gurugram, Noida, Bangalore, Bengaluru, Mumbai, Hyderabad, Pune, Chennai, Kolkata, Ahmedabad |
| `remote`, `anywhere`, `global` | Remote, Anywhere, Global, Worldwide, Work from home, WFH, Distributed |
| `us`, `usa` | United States, USA, SF, NYC, LA, Seattle, Boston, Austin, Chicago, Denver, Remote-US |
| `uk` | United Kingdom, UK, London, Manchester, Edinburgh, Birmingham, Bristol |
| `canada` | Canada, Toronto, Vancouver, Montreal, Ottawa, Calgary |
| `eu`, `europe` | Germany/Berlin/Munich, France/Paris, Netherlands/Amsterdam, Spain/Madrid/Barcelona, Sweden/Stockholm, Poland/Warsaw, Ireland/Dublin, Portugal/Lisbon, Italy/Milan |
| `apac`, `asia` | Singapore, Tokyo, Japan, Seoul, Korea, Hong Kong, Taipei, Taiwan, Sydney, Melbourne, Australia |
| `germany`, `france`, `netherlands`, `singapore`, `japan`, `australia` | Single-country presets |

Unknown values (e.g. `--country poland`) are used as literal substrings against the job's location string.

### Examples

```bash
node harvest.mjs                                      # full run, portals.yml defaults (≈4 min)
node harvest.mjs --country india                      # India-only (override yml)
node harvest.mjs --country india,remote               # India + remote
node harvest.mjs --country us --industry gaming       # US gaming only
node harvest.mjs --ats greenhouse --limit 50          # debug: 50 Greenhouse companies
node harvest.mjs --company "Riot"                     # single company
node harvest.mjs --country eu --no-filter             # all EU roles regardless of title
node harvest.mjs --dry-run                            # count only, no CSV
```

Via npm: `npm run harvest -- --country india`.

### Natural-language translation (when invoked via `/outscal-jobs harvest`)

If the user gives a free-form request, translate to flags:

| User says | Run |
|---|---|
| "harvest India only" | `--country india` |
| "run quick test" / "smoke test" | `--limit 50 --dry-run` |
| "just gaming companies" | `--industry gaming` |
| "only Riot" | `--company Riot` |
| "US and UK" | `--country us,uk` |
| "India plus remote" | `--country india,remote` |
| "remote only" | `--country remote` |
| "show me everything in EU" | `--country eu --no-filter` |

## How the user tunes it

Edit `portals.yml`:

- `title_filter.positive` — keywords a job title must contain at least one of
- `title_filter.negative` — keywords that disqualify a title
- `locations.include` — cities/regions/remote signals to allow
- `locations.exclude` — regions to explicitly drop
- `industry_allowlist` — gaming / tech / both
- `ats_allowlist` — restrict to specific ATSes
- `manual_only` — hosts that get flagged to the manual CSV

After editing, re-run. Dedup is automatic — subsequent runs return only new jobs.

## When an adapter fails

Adapters never throw — they return `[]` on error. Run with `HARVEST_VERBOSE=1` to see per-company warnings:

```bash
HARVEST_VERBOSE=1 node harvest.mjs --limit 10
```

Common reasons a company returns 0 jobs:
1. The ATS board is genuinely empty (no open roles)
2. The slug in `companies_v2.json` is stale (company rebranded / moved ATS)
3. Bot protection (429 / Cloudflare challenge) — Tier 2 Playwright scraper needed
4. The company is on Jobvite (no public API) — check the manual CSV

## When to re-run

- Fresh data daily: schedule `node harvest.mjs` nightly (cron / Task Scheduler)
- After keyword tuning: re-run to see the effect
- Dedup history lives in `data/harvest-history.tsv`; delete it to force a full refetch

## Out of scope for V1

- Playwright scraping of the ~9,400 unroutable companies (Tier 2)
- LLM-based role-match beyond keywords
- A/B–G evaluation of individual jobs (use `/outscal-jobs oferta` for that)
- Apply link redirection (we trust the ATS detail URL as the apply URL)
