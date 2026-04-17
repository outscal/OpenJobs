// adapters/workday.mjs — Workday myworkdayjobs.com adapter.
//
// Careers URL: https://{tenant}.wd{N}.myworkdayjobs.com/{siteId}
//   (may include locale prefix like /en-US/)
// API (POST):  https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{siteId}/jobs
//   body: { appliedFacets: {}, limit: 20, offset: 0, searchText: '' }

export const ATS = 'workday';

// Matches: https://{tenant}.wd{N}.myworkdayjobs.com/(?:{locale}/)?{siteId}
const HOST_RE = /^https?:\/\/([^/.]+)\.wd(\d+)\.myworkdayjobs\.com\/([^?#]*)/i;
const LOCALE_RE = /^[a-z]{2}(?:-[A-Z]{2})?$/;

function candidateUrls(company) {
  const urls = [];
  if (Array.isArray(company?.ats_links)) urls.push(...company.ats_links);
  if (company?.ats_url) urls.push(company.ats_url);
  if (company?.careers_url) urls.push(company.careers_url);
  if (company?.api) urls.push(company.api);
  return urls.filter(Boolean);
}

function parseWorkdayUrl(url) {
  const m = url.match(HOST_RE);
  if (!m) return null;
  const tenant = m[1];
  const wdN = m[2];
  const tail = (m[3] || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!tail) return null;
  const segments = tail.split('/').filter(Boolean);
  // Strip optional locale prefix (en-US, en, etc.)
  let siteId = segments[0];
  if (LOCALE_RE.test(segments[0]) && segments[1]) {
    siteId = segments[1];
  }
  if (!siteId) return null;
  return { tenant, wdN, siteId };
}

export function detect(company) {
  for (const url of candidateUrls(company)) {
    const parsed = parseWorkdayUrl(url);
    if (parsed) return buildHandle(parsed);
  }
  return null;
}

function buildHandle({ tenant, wdN, siteId }) {
  const host = `${tenant}.wd${wdN}.myworkdayjobs.com`;
  return {
    tenant,
    wdN,
    siteId,
    host,
    apiUrl: `https://${host}/wday/cxs/${tenant}/${siteId}/jobs`,
    boardUrl: `https://${host}/${siteId}`,
  };
}

function isRemote(title, location) {
  const hay = `${title || ''} ${location || ''}`.toLowerCase();
  return /\bremote\b|\banywhere\b|work from home|\bwfh\b/.test(hay);
}

async function postJson(url, body, ctx) {
  // Prefer helper if it supports POST; else fall back to direct fetch.
  if (ctx?.fetchJson && ctx.fetchJson.length >= 2) {
    try {
      return await ctx.fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (_) { /* fall through to direct fetch */ }
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
  const pageSize = 20;
  const hardCap = 500;
  try {
    let offset = 0;
    let total = Infinity;
    let guard = 0;
    while (offset < total && all.length < hardCap && guard < 30) {
      guard++;
      const body = { appliedFacets: {}, limit: pageSize, offset, searchText: '' };
      const json = await postJson(handle.apiUrl, body, ctx);
      const postings = json?.jobPostings || [];
      if (typeof json?.total === 'number') total = json.total;
      if (!Array.isArray(postings) || postings.length === 0) break;
      for (const p of postings) {
        const title = p.title || '';
        const location = p.locationsText || '';
        const extPath = p.externalPath || '';
        const detailUrl = extPath
          ? `https://${handle.host}${extPath.startsWith('/') ? extPath : '/' + extPath}`
          : handle.boardUrl;
        all.push({
          title,
          detail_url: detailUrl,
          apply_url: detailUrl,
          location,
          remote: isRemote(title, location),
          department: '',
          posted_date: p.postedOn || '',
          employment_type: Array.isArray(p.bulletFields) ? (p.bulletFields[0] || '') : '',
          raw: p,
        });
      }
      offset += postings.length;
      if (postings.length < pageSize) break;
    }
    return all;
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`workday ${handle.tenant}/${handle.siteId}: ${err.message}`);
    return all;
  }
}
