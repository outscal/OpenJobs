// adapters/greenhouse.mjs — Greenhouse Job Board API adapter.
//
// API: https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
// Public boards are served on a few variants of the greenhouse.io domain.

export const ATS = 'greenhouse';

const HOST_PATTERNS = [
  /boards\.greenhouse\.io\/([^/?#]+)/i,
  /job-boards\.greenhouse\.io\/([^/?#]+)/i,
  /boards\.eu\.greenhouse\.io\/([^/?#]+)/i,
  /job-boards\.eu\.greenhouse\.io\/([^/?#]+)/i,
];

function candidateUrls(company) {
  const urls = [];
  if (Array.isArray(company?.ats_links)) urls.push(...company.ats_links);
  if (company?.ats_url) urls.push(company.ats_url);
  if (company?.careers_url) urls.push(company.careers_url);
  if (company?.api) urls.push(company.api);
  return urls.filter(Boolean);
}

function matchSlug(url) {
  for (const re of HOST_PATTERNS) {
    const m = url.match(re);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

export function detect(company) {
  // Explicit api field containing "greenhouse" — try to extract slug from it.
  if (typeof company?.api === 'string' && company.api.toLowerCase().includes('greenhouse')) {
    const m = company.api.match(/\/boards\/([^/?#]+)/i) || matchSlugFromAny([company.api]);
    const slug = m && (Array.isArray(m) ? m[0] : m[1] || m);
    if (slug) {
      return buildHandle(typeof slug === 'string' ? slug : slug[1]);
    }
  }

  for (const url of candidateUrls(company)) {
    const slug = matchSlug(url);
    if (slug) return buildHandle(slug);
  }
  return null;
}

function matchSlugFromAny(urls) {
  for (const u of urls) {
    const slug = matchSlug(u);
    if (slug) return slug;
  }
  return null;
}

function buildHandle(slug) {
  return {
    slug,
    apiUrl: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
    boardUrl: `https://job-boards.greenhouse.io/${encodeURIComponent(slug)}`,
  };
}

function isRemote(title, location) {
  const hay = `${title || ''} ${location || ''}`.toLowerCase();
  return /\bremote\b|\banywhere\b|work from home/.test(hay);
}

export async function fetchJobs(handle, ctx) {
  if (!handle?.apiUrl) return [];
  try {
    const json = await ctx.fetchJson(handle.apiUrl);
    const jobs = json?.jobs || [];
    return jobs.map(j => {
      const title = j.title || '';
      const location = j.location?.name || '';
      const detailUrl = j.absolute_url || '';
      return {
        title,
        detail_url: detailUrl,
        apply_url: detailUrl,
        location,
        remote: isRemote(title, location),
        department: j.departments?.[0]?.name || '',
        posted_date: j.updated_at || '',
        employment_type: '',
        raw: j,
      };
    });
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`greenhouse ${handle.slug}: ${err.message}`);
    return [];
  }
}
