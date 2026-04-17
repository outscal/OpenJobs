// adapters/breezy.mjs — Breezy HR public JSON adapter.
//
// API: https://{slug}.breezy.hr/json
// Returns an array of positions with _id, name, type, category, location, department, published_date, description, url.

export const ATS = 'breezy';

const HOST_PATTERNS = [
  /([a-z0-9-]+)\.breezy\.hr/i,
];

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
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

export function detect(company) {
  for (const url of candidateUrls(company)) {
    const slug = matchSlug(url);
    if (slug) {
      return {
        slug,
        apiUrl: `https://${slug}.breezy.hr/json`,
        boardUrl: `https://${slug}.breezy.hr/`,
      };
    }
  }
  return null;
}

function locationString(loc) {
  if (!loc) return '';
  if (typeof loc === 'string') return loc;
  if (loc.name) return loc.name;
  const city = loc.city?.name || loc.city;
  const country = loc.country?.name || loc.country;
  return [city, country].filter(Boolean).join(', ');
}

function isRemote(title, location, p) {
  if (p?.location?.is_remote === true) return true;
  const hay = `${title || ''} ${location || ''}`.toLowerCase();
  return /\bremote\b|\banywhere\b|home office|work from home/.test(hay);
}

function typeString(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  return t.name || t.id || '';
}

export async function fetchJobs(handle, ctx) {
  if (!handle?.apiUrl) return [];
  try {
    const json = await ctx.fetchJson(handle.apiUrl);
    const positions = Array.isArray(json) ? json : [];
    return positions.map(p => {
      const title = p.name || '';
      const location = locationString(p.location);
      const detailUrl = p.url
        || (p.friendly_id ? `${handle.boardUrl}p/${p.friendly_id}` : '')
        || (p._id ? `${handle.boardUrl}p/${p._id}` : '');
      const department = typeof p.department === 'string'
        ? p.department
        : (p.department?.name || '');
      return {
        title,
        detail_url: detailUrl,
        apply_url: detailUrl,
        location,
        remote: isRemote(title, location, p),
        department,
        posted_date: p.published_date || p.updated_date || '',
        employment_type: typeString(p.type),
        raw: p,
      };
    });
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`breezy ${handle.slug}: ${err.message}`);
    return [];
  }
}
