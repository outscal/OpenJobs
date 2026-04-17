---
name: outscal-jobs
description: Harvest growth-marketing and tech jobs from 2,000+ gaming/tech companies via ATS APIs into CSV; also supports CV evaluation, PDF generation, and the full career-ops workflow
user_invocable: true
args: mode
argument-hint: "[harvest [--country X] [--industry gaming|tech] [--limit N] [--ats NAME] [--company NAME] | scan | deep | pdf | oferta | ofertas | apply | batch | tracker | pipeline | contacto | training | project | interview-prep | patterns | followup | update]"
---

# outscal-jobs -- Router

Fork of career-ops specialized for the Outscal jobs use case: pull fresh job listings from 2,000+ gaming/tech companies (via public ATS APIs), filter against the user's CV, and emit CSV.

All previous career-ops modes are retained. The new mode is `harvest`.

## Mode Routing

Determine the mode from `{{mode}}`. The first token decides the mode; any remaining tokens are treated as flags/args for that mode.

| First token | Mode |
|-------|------|
| (empty / no args) | `discovery` -- Show command menu |
| `harvest` (with or without flags) | **`harvest`** -- Pull jobs from all ATSes into CSV. Flags pass through to `node harvest.mjs`. |
| JD text or URL (no sub-command) | `auto-pipeline` |
| `oferta` | `oferta` |
| `ofertas` | `ofertas` |
| `contacto` | `contacto` |
| `deep` | `deep` |
| `pdf` | `pdf` |
| `training` | `training` |
| `project` | `project` |
| `tracker` | `tracker` |
| `pipeline` | `pipeline` |
| `apply` | `apply` |
| `scan` | `scan` |
| `batch` | `batch` |
| `patterns` | `patterns` |
| `followup` | `followup` |

**Auto-pipeline detection:** If `{{mode}}` is not a known sub-command AND contains JD text (keywords: "responsibilities", "requirements", "qualifications", "about the role", "we're looking for", company name + role) or a URL to a JD, execute `auto-pipeline`.

If `{{mode}}` is not a sub-command AND doesn't look like a JD, show discovery.

---

## Discovery Mode (no arguments)

Show this menu:

```
outscal-jobs -- Command Center

PRIMARY (this fork):
  /outscal-jobs harvest                          → Full harvest, all ATSes, uses portals.yml filters
  /outscal-jobs harvest --country india          → Only India-based roles (override location filter)
  /outscal-jobs harvest --country india,remote   → India + remote (comma-separated)
  /outscal-jobs harvest --country us             → US-based (expands to SF/NYC/LA/Seattle/…)
  /outscal-jobs harvest --country uk             → UK / London / Manchester / Edinburgh
  /outscal-jobs harvest --country eu             → European hubs (Berlin/Paris/Amsterdam/…)
  /outscal-jobs harvest --limit 50               → First 50 routable companies (quick test)
  /outscal-jobs harvest --industry gaming        → Gaming companies only
  /outscal-jobs harvest --industry tech          → Tech companies only
  /outscal-jobs harvest --ats greenhouse         → Only Greenhouse-hosted companies
  /outscal-jobs harvest --company "Voodoo"       → Single company by name (substring)
  /outscal-jobs harvest --location "Bangalore,Mumbai"   → Literal location keywords
  /outscal-jobs harvest --dry-run                → Count only, no CSV written
  /outscal-jobs harvest --no-filter              → Emit every job (skip title/location filter)

LEGACY career-ops commands (still work):
  /outscal-jobs {JD}      → AUTO-PIPELINE: evaluate + report + PDF + tracker
  /outscal-jobs pipeline  → Process pending URLs from inbox (data/pipeline.md)
  /outscal-jobs oferta    → Evaluation only A-F (no auto PDF)
  /outscal-jobs ofertas   → Compare and rank multiple offers
  /outscal-jobs contacto  → LinkedIn power move: find contacts + draft message
  /outscal-jobs deep      → Deep research prompt about company
  /outscal-jobs pdf       → PDF only, ATS-optimized CV
  /outscal-jobs training  → Evaluate course/cert against North Star
  /outscal-jobs project   → Evaluate portfolio project idea
  /outscal-jobs tracker   → Application status overview
  /outscal-jobs apply     → Live application assistant (reads form + generates answers)
  /outscal-jobs scan      → Scan portals (portals.yml only, legacy)
  /outscal-jobs batch     → Batch processing with parallel workers
  /outscal-jobs patterns  → Analyze rejection patterns and improve targeting
  /outscal-jobs followup  → Follow-up cadence tracker: flag overdue, generate drafts

Harvest input:  data/companies_v2.json (12k companies, V1 uses 2k with known ATS)
Harvest output: output/jobs-YYYY-MM-DD.csv
```

---

## Context Loading by Mode

After determining the mode, load the necessary files before executing:

### `harvest` (NEW — Outscal fork)
Read `modes/harvest.md`. If the user passed flags after `harvest` (e.g. `--country india --limit 50`), pass them through verbatim to `node harvest.mjs`. If the user described intent in natural language ("harvest India only", "just gaming", "run a quick test"), translate to the appropriate flags — see the flag table in `modes/harvest.md`.

### Modes that require `_shared.md` + their mode file:
Read `modes/_shared.md` + `modes/{mode}.md`

Applies to: `auto-pipeline`, `oferta`, `ofertas`, `pdf`, `contacto`, `apply`, `pipeline`, `scan`, `batch`

### Standalone modes (only their mode file):
Read `modes/{mode}.md`

Applies to: `tracker`, `deep`, `training`, `project`, `patterns`, `followup`

### Modes delegated to subagent:
For `scan`, `apply` (with Playwright), `pipeline` (3+ URLs), and `harvest` (batched runs): launch as Agent with the content of `_shared.md` + `modes/{mode}.md` injected into the subagent prompt.

```
Agent(
  subagent_type="general-purpose",
  prompt="[content of modes/_shared.md]\n\n[content of modes/{mode}.md]\n\n[invocation-specific data]",
  description="outscal-jobs {mode}"
)
```

Execute the instructions from the loaded mode file.
