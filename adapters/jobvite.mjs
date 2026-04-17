// adapters/jobvite.mjs — Jobvite adapter (Tier 1 SKIP stub).
//
// Jobvite does not expose a public REST/JSON/RSS job feed for a given company:
//   - https://jobs.jobvite.com/{slug}/jobs   → AngularJS SPA, rendered client-side.
//   - https://jobs.jobvite.com/{slug}.rss    → redirects to generic support page.
//   - https://app.jobvite.com/CompanyJobs/Xml.aspx?c={id} → requires legacy numeric id
//     and returns empty <result /> for modern tenants.
//
// V1 is Tier-1 only. detect() returns a handle with { skipped:true, reason:'no-public-api' }
// so the harvester can log "Jobvite: no public API — use Playwright tier" and move on.
// fetchJobs() always returns [].

export const ATS = 'jobvite';

const HOST_PATTERNS = [
  /jobs\.jobvite\.com\/([^/?#]+)/i,
  /([^/?#.]+)\.jobs\.jobvite\.com/i,
  /app\.jobvite\.com\/CompanyJobs\/[^?]*\?[^#]*\bc=([^&#]+)/i,
];

const EXCLUDE_SEGMENTS = new Set(['careers', 'jobs', 'www', 'app']);

function candidateUrls(company) {
  const urls = [];
  if (Array.isArray(company?.ats_links)) urls.push(...company.ats_links);
  if (company?.ats_url) urls.push(company.ats_url);
  if (company?.careers_url) urls.push(company.careers_url);
  if (company?.listUrl) urls.push(company.listUrl);
  if (company?.api) urls.push(company.api);
  return urls.filter(Boolean);
}

function matchSlug(url) {
  for (const re of HOST_PATTERNS) {
    const m = url.match(re);
    if (m && m[1]) {
      const slug = decodeURIComponent(m[1]);
      if (!EXCLUDE_SEGMENTS.has(slug.toLowerCase())) return slug;
    }
  }
  return null;
}

export function detect(company) {
  for (const url of candidateUrls(company)) {
    const slug = matchSlug(url);
    if (slug) {
      return {
        slug,
        boardUrl: `https://jobs.jobvite.com/${encodeURIComponent(slug)}/jobs`,
        skipped: true,
        reason: 'no-public-api',
      };
    }
  }
  return null;
}

export async function fetchJobs(handle, ctx) {
  if (!handle) return [];
  if (ctx?.logWarn) {
    ctx.logWarn(`jobvite ${handle.slug}: no public API — use Playwright tier`);
  }
  return [];
}
