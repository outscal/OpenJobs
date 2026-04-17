// adapters/workable.mjs — Workable (apply.workable.com) adapter.
//
// API: POST https://apply.workable.com/api/v3/accounts/{slug}/jobs
//   body: {}  (pagination: { token: <nextPage from prev response> })
//   response: { total, results: [...], nextPage: "<base64 token>" | null }
// Public board URL: https://apply.workable.com/{slug}/

export const ATS = 'workable';

const HOST_PATTERNS = [
  /apply\.workable\.com\/api\/v3\/accounts\/([^/?#]+)/i,
  /apply\.workable\.com\/([^/?#]+)/i,
];

const EXCLUDE_SEGMENTS = new Set(['api', 'v3', 'accounts', 'j', 'jobs']);

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
    if (m && m[1] && !EXCLUDE_SEGMENTS.has(m[1].toLowerCase())) {
      return decodeURIComponent(m[1]);
    }
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
    apiUrl: `https://apply.workable.com/api/v3/accounts/${encodeURIComponent(slug)}/jobs`,
    boardUrl: `https://apply.workable.com/${encodeURIComponent(slug)}/`,
  };
}

function isRemote(title, location, flags) {
  if (flags?.remote === true) return true;
  if (flags?.workplace && /remote/i.test(flags.workplace)) return true;
  const hay = `${title || ''} ${location || ''}`.toLowerCase();
  return /\bremote\b|\banywhere\b|work from home|\bwfh\b/.test(hay);
}

function joinLocation(loc) {
  if (!loc || typeof loc !== 'object') return '';
  const parts = [loc.city, loc.region, loc.country].filter(Boolean);
  return parts.join(', ');
}

async function postJson(url, body, ctx) {
  if (ctx?.fetchJson && ctx.fetchJson.length >= 2) {
    try {
      return await ctx.fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (_) { /* fall through */ }
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function fetchJobs(handle, ctx) {
  if (!handle?.apiUrl) return [];
  const all = [];
  const hardCap = 500;
  try {
    let token = null;
    let guard = 0;
    while (all.length < hardCap && guard < 30) {
      guard++;
      const body = token ? { token } : {};
      const json = await postJson(handle.apiUrl, body, ctx);
      const results = json?.results || [];
      if (!Array.isArray(results) || results.length === 0) break;
      for (const j of results) {
        const title = j.title || '';
        const location = joinLocation(j.location);
        const shortcode = j.shortcode || j.id || '';
        const detailUrl = j.url || j.application_url
          || `${handle.boardUrl}j/${encodeURIComponent(shortcode)}/`;
        all.push({
          title,
          detail_url: detailUrl,
          apply_url: detailUrl,
          location,
          remote: isRemote(title, location, { remote: j.remote, workplace: j.workplace }),
          department: j.department || '',
          posted_date: j.published || j.created_at || '',
          employment_type: j.employment_type || j.type || '',
          raw: j,
        });
      }
      token = json?.nextPage || null;
      if (!token) break;
    }
    return all;
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`workable ${handle.slug}: ${err.message}`);
    return all;
  }
}
