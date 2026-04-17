// adapters/smartrecruiters.mjs — SmartRecruiters public postings API.
//
// API: https://api.smartrecruiters.com/v1/companies/{companyId}/postings?limit=100&offset=N
// Careers URL: https://careers.smartrecruiters.com/{companyId}
// Jobs URL:    https://jobs.smartrecruiters.com/{companyId}

export const ATS = 'smartrecruiters';

const HOST_PATTERNS = [
  /careers\.smartrecruiters\.com\/([^/?#]+)/i,
  /jobs\.smartrecruiters\.com\/([^/?#]+)/i,
  /api\.smartrecruiters\.com\/v1\/companies\/([^/?#]+)/i,
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
    if (m && m[1]) return decodeURIComponent(m[1]);
  }
  return null;
}

export function detect(company) {
  for (const url of candidateUrls(company)) {
    const slug = matchSlug(url);
    if (slug) return buildHandle(slug);
  }
  return null;
}

function buildHandle(slug) {
  return {
    slug,
    apiBase: `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug)}/postings`,
    boardUrl: `https://careers.smartrecruiters.com/${encodeURIComponent(slug)}`,
  };
}

function isRemote(title, location, remoteFlag) {
  if (remoteFlag === true) return true;
  const hay = `${title || ''} ${location || ''}`.toLowerCase();
  return /\bremote\b|\banywhere\b|work from home|\bwfh\b/.test(hay);
}

function joinLocation(loc) {
  if (!loc || typeof loc !== 'object') return '';
  const parts = [loc.city, loc.region, loc.country].filter(Boolean);
  return parts.join(', ');
}

export async function fetchJobs(handle, ctx) {
  if (!handle?.apiBase) return [];
  const all = [];
  const limit = 100;
  const hardCap = 1000;
  try {
    let offset = 0;
    let total = Infinity;
    let guard = 0;
    while (offset < total && all.length < hardCap && guard < 20) {
      guard++;
      const url = `${handle.apiBase}?limit=${limit}&offset=${offset}`;
      const json = await ctx.fetchJson(url);
      const content = json?.content || [];
      if (typeof json?.totalFound === 'number') total = json.totalFound;
      if (!Array.isArray(content) || content.length === 0) break;
      for (const p of content) {
        const title = p.name || p.title || '';
        const location = joinLocation(p.location);
        const id = p.id || p.uuid || p.refNumber || '';
        // Public posting URL — the API `ref` field points back to the API,
        // so build the careers page URL instead.
        const detailUrl = id
          ? `${handle.boardUrl}/${encodeURIComponent(id)}`
          : handle.boardUrl;
        all.push({
          title,
          detail_url: detailUrl,
          apply_url: detailUrl,
          location,
          remote: isRemote(title, location, p.location?.remote),
          department: p.department?.label || p.function?.label || '',
          posted_date: p.releasedDate || p.createdOn || '',
          employment_type: p.typeOfEmployment?.label || '',
          raw: p,
        });
      }
      offset += content.length;
      if (content.length < limit) break;
    }
    return all;
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`smartrecruiters ${handle.slug}: ${err.message}`);
    return all;
  }
}
