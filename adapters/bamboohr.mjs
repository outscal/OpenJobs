// adapters/bamboohr.mjs — BambooHR public careers list adapter.
//
// API:  https://{slug}.bamboohr.com/careers/list  →  { result: [ { id, jobOpeningName, ... } ] }
// Board: https://{slug}.bamboohr.com/careers      (public HTML listing)
// Detail: https://{slug}.bamboohr.com/careers/{id}

export const ATS = 'bamboohr';

const HOST_PATTERN = /([^/?#.]+)\.bamboohr\.com/i;

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
  const m = url.match(HOST_PATTERN);
  if (m && m[1] && m[1].toLowerCase() !== 'www') return decodeURIComponent(m[1]);
  return null;
}

export function detect(company) {
  for (const url of candidateUrls(company)) {
    const slug = matchSlug(url);
    if (slug) {
      return {
        slug,
        apiUrl: `https://${slug}.bamboohr.com/careers/list`,
        boardUrl: `https://${slug}.bamboohr.com/careers`,
      };
    }
  }
  return null;
}

function joinLocation(loc, atsLoc) {
  const parts = [];
  if (loc && typeof loc === 'object') {
    if (loc.city) parts.push(loc.city);
    if (loc.state) parts.push(loc.state);
  }
  if (parts.length === 0 && atsLoc && typeof atsLoc === 'object') {
    if (atsLoc.city) parts.push(atsLoc.city);
    if (atsLoc.state || atsLoc.province) parts.push(atsLoc.state || atsLoc.province);
    if (atsLoc.country) parts.push(atsLoc.country);
  }
  return parts.filter(Boolean).join(', ');
}

function isRemote(title, location, isRemoteFlag, locationType) {
  if (isRemoteFlag === true || isRemoteFlag === 1 || isRemoteFlag === '1') return true;
  // locationType "1" in BambooHR = remote in many tenants
  if (locationType === '1' || locationType === 1) return true;
  const hay = `${title || ''} ${location || ''}`.toLowerCase();
  return /\bremote\b|\banywhere\b|work from home|\bwfh\b/.test(hay);
}

export async function fetchJobs(handle, ctx) {
  if (!handle?.apiUrl) return [];
  try {
    const json = await ctx.fetchJson(handle.apiUrl);
    const results = Array.isArray(json?.result) ? json.result
                  : Array.isArray(json?.results) ? json.results
                  : Array.isArray(json) ? json : [];
    return results.map(j => {
      const title = j.jobOpeningName || j.title || '';
      const location = joinLocation(j.location, j.atsLocation);
      const id = j.id || j.jobOpeningId || '';
      const detailUrl = id ? `${handle.boardUrl}/${encodeURIComponent(id)}` : handle.boardUrl;
      // Some tenants only list open jobs; skip explicitly closed if present.
      const status = j.jobOpeningStatus || j.status;
      if (status && String(status).toLowerCase() === 'closed') return null;
      return {
        title,
        detail_url: detailUrl,
        apply_url: detailUrl,
        location,
        remote: isRemote(title, location, j.isRemote, j.locationType),
        department: j.departmentLabel || j.department || '',
        posted_date: j.datePosted || j.dateAvailable || '',
        employment_type: j.employmentStatusLabel || j.employmentStatus || '',
        raw: j,
      };
    }).filter(Boolean);
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`bamboohr ${handle.slug}: ${err.message}`);
    return [];
  }
}
