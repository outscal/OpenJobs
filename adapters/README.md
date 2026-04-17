# ATS Adapters

Each adapter is a plain ES module that exports two functions:

```js
// adapters/{ats}.mjs
export const ATS = 'greenhouse';  // short lowercase id — must match supported_ats in portals.yml

/**
 * detect(company) — inspect a company record from data/companies_v2.json
 * and decide whether this adapter can fetch jobs for it.
 *
 * @param  {object} company — a single record from companies_v2.json
 * @return {object|null}    — { slug, apiUrl, ...meta } if this adapter handles it, else null
 */
export function detect(company) { ... }

/**
 * fetchJobs(handle, { fetchJson }) — given the handle returned by detect(),
 * hit the public ATS API and return a normalized job list.
 *
 * @param  {object} handle        — whatever detect() returned
 * @param  {object} ctx           — { fetchJson, company } — helpers & original company record
 * @return {Promise<Job[]>}
 */
export async function fetchJobs(handle, ctx) { ... }
```

## Normalized Job shape (what fetchJobs must return)

```js
{
  title:        string,   // required
  detail_url:   string,   // required — URL to the job detail page
  apply_url:    string,   // same as detail_url for V1 (no second hop)
  location:     string,   // free-form; may be empty
  remote:       boolean,  // true if title/location/metadata signals remote
  department:   string,   // optional
  posted_date:  string,   // ISO 8601 if known, else ''
  employment_type: string, // optional: "Full-time" etc.
  raw:          object,   // optional: original upstream record for debugging
}
```

## Rules

1. Never throw — on any error, log via `ctx.logWarn` (if provided) and return `[]`.
2. Use `ctx.fetchJson(url)` rather than raw `fetch` — the shared helper has timeout + retry.
3. Do NOT apply title/location filters inside adapters. That happens in `harvest.mjs` so rules stay centralized.
4. If the ATS requires per-company discovery (e.g. Workday tenant URL), encode it in `detect()`.
5. Keep each adapter under ~150 lines. If bigger, split into helpers.

## Testing an adapter

```bash
node -e "
  import('./adapters/greenhouse.mjs').then(async m => {
    const company = { name: 'Discord', ats_links: ['https://job-boards.greenhouse.io/discord'] };
    const h = m.detect(company);
    const jobs = await m.fetchJobs(h, { fetchJson: url => fetch(url).then(r => r.json()) });
    console.log(jobs.slice(0, 3));
  });
"
```
