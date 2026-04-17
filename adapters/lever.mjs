// adapters/lever.mjs — Lever Postings API adapter.
//
// API: https://api.lever.co/v0/postings/{slug}
// Public boards live at jobs.lever.co/{slug} or jobs.eu.lever.co/{slug}.

export const ATS = 'lever';

const HOST_PATTERNS = [
  /jobs\.lever\.co\/([^/?#]+)/i,
  /jobs\.eu\.lever\.co\/([^/?#]+)/i,
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
  for (const url of candidateUrls(company)) {
    const slug = matchSlug(url);
    if (slug) {
      return {
        slug,
        apiUrl: `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}`,
      };
    }
  }
  return null;
}

function isRemote(title, location, workplaceType) {
  const hay = `${title || ''} ${location || ''} ${workplaceType || ''}`.toLowerCase();
  return /\bremote\b|\banywhere\b|work from home/.test(hay);
}

function toIso(ms) {
  if (!ms && ms !== 0) return '';
  const d = new Date(typeof ms === 'number' ? ms : Number(ms));
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

export async function fetchJobs(handle, ctx) {
  if (!handle?.apiUrl) return [];
  try {
    const json = await ctx.fetchJson(handle.apiUrl);
    const postings = Array.isArray(json) ? json : [];
    return postings.map(j => {
      const title = j.text || '';
      const location = j.categories?.location || '';
      const detailUrl = j.hostedUrl || j.applyUrl || '';
      return {
        title,
        detail_url: detailUrl,
        apply_url: detailUrl,
        location,
        remote: isRemote(title, location, j.workplaceType),
        department: j.categories?.team || j.categories?.department || '',
        posted_date: toIso(j.createdAt),
        employment_type: j.categories?.commitment || '',
        raw: j,
      };
    });
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`lever ${handle.slug}: ${err.message}`);
    return [];
  }
}
