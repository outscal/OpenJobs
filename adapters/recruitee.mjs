// adapters/recruitee.mjs — Recruitee public offers API adapter.
//
// API: https://{slug}.recruitee.com/api/offers/
// Returns { offers: [...] }. Detail URL is offer.careers_url or {slug}.recruitee.com/o/{offer.slug}.

export const ATS = 'recruitee';

const HOST_PATTERNS = [
  /([a-z0-9-]+)\.recruitee\.com/i,
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
        apiUrl: `https://${slug}.recruitee.com/api/offers/`,
        boardUrl: `https://${slug}.recruitee.com/`,
      };
    }
  }
  return null;
}

function isRemote(title, location, o) {
  if (o?.remote === true) return true;
  const hay = `${title || ''} ${location || ''}`.toLowerCase();
  return /\bremote\b|\banywhere\b|home office|work from home/.test(hay);
}

function firstLocationString(o) {
  if (Array.isArray(o?.locations) && o.locations.length) {
    const l = o.locations[0];
    if (typeof l === 'string') return l;
    return [l?.city, l?.country].filter(Boolean).join(', ') || l?.name || '';
  }
  if (o?.location) return o.location;
  if (o?.city && o?.country) return `${o.city}, ${o.country}`;
  return o?.city || o?.country || '';
}

export async function fetchJobs(handle, ctx) {
  if (!handle?.apiUrl) return [];
  try {
    const json = await ctx.fetchJson(handle.apiUrl);
    const offers = json?.offers || [];
    return offers.map(o => {
      const title = o.title || o.position || '';
      const location = firstLocationString(o);
      const detailUrl = o.careers_url || o.careers_apply_url
        || (o.slug ? `${handle.boardUrl}o/${o.slug}` : '');
      return {
        title,
        detail_url: detailUrl,
        apply_url: detailUrl,
        location,
        remote: isRemote(title, location, o),
        department: o.department || '',
        posted_date: o.published_at || o.created_at || '',
        employment_type: o.employment_type_code || o.employment_type || '',
        raw: o,
      };
    });
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`recruitee ${handle.slug}: ${err.message}`);
    return [];
  }
}
