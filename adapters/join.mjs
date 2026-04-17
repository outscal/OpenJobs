// adapters/join.mjs — Join.com adapter.
//
// join.com serves a Next.js-rendered board at https://join.com/companies/{slug}.
// There is no working public JSON endpoint (the api/public/companies/{slug}/jobs
// endpoint exists but returns {items:[]} for all tested tenants — likely gated).
//
// Fallback: fetch the public HTML page once and parse the embedded job links.
// Each visible job link matches /companies/{slug}/{id}-{slug-title} and we
// derive the title from the URL slug. Good enough for V1 harvesting.

export const ATS = 'join';

const HOST_PATTERNS = [
  /join\.com\/companies\/([^/?#]+)/i,
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
    if (m && m[1]) {
      // Strip trailing slash/segments like /jobs
      const raw = decodeURIComponent(m[1]).split('/')[0];
      if (raw) return raw;
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
        boardUrl: `https://join.com/companies/${encodeURIComponent(slug)}`,
      };
    }
  }
  return null;
}

function titleFromSlug(slug) {
  // "game-designer-us-market-f-m-d" -> "Game Designer Us Market F M D"
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
}

function isRemote(title, location) {
  const hay = `${title || ''} ${location || ''}`.toLowerCase();
  return /\bremote\b|\banywhere\b|work from home|\bwfh\b/.test(hay);
}

export async function fetchJobs(handle, ctx) {
  if (!handle?.boardUrl) return [];
  try {
    const fetchText = ctx?.fetchText;
    let html;
    if (typeof fetchText === 'function') {
      html = await fetchText(handle.boardUrl);
    } else {
      // Fallback to global fetch so the adapter still works standalone.
      const res = await fetch(handle.boardUrl);
      html = await res.text();
    }
    if (!html || typeof html !== 'string') return [];

    // Try JSON-LD JobPosting blocks first (richest data when present).
    const jsonLd = [];
    const ldRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    let ldm;
    while ((ldm = ldRe.exec(html))) {
      try {
        const parsed = JSON.parse(ldm[1]);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        for (const node of arr) {
          if (node && node['@type'] === 'JobPosting') jsonLd.push(node);
        }
      } catch (_) { /* skip malformed */ }
    }

    if (jsonLd.length) {
      return jsonLd.map(n => {
        const title = n.title || '';
        const loc = n.jobLocation;
        const address = Array.isArray(loc) ? loc[0]?.address : loc?.address;
        const location = [address?.addressLocality, address?.addressRegion, address?.addressCountry].filter(Boolean).join(', ');
        const detailUrl = n.url || handle.boardUrl;
        return {
          title,
          detail_url: detailUrl,
          apply_url: detailUrl,
          location,
          remote: isRemote(title, location) || n.jobLocationType === 'TELECOMMUTE',
          department: n.industry || '',
          posted_date: n.datePosted || '',
          employment_type: Array.isArray(n.employmentType) ? n.employmentType.join(', ') : (n.employmentType || ''),
          raw: n,
        };
      });
    }

    // Fallback: scrape anchor hrefs that match /companies/{slug}/{id}-{title}.
    const jobs = new Map(); // id -> { slug, title }
    const escSlug = handle.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`/companies/${escSlug}/(\\d+)-([a-z0-9-]+)`, 'gi');
    let m;
    while ((m = re.exec(html))) {
      if (!jobs.has(m[1])) jobs.set(m[1], m[2]);
    }
    return Array.from(jobs.entries()).map(([id, jslug]) => {
      const title = titleFromSlug(jslug);
      const detailUrl = `https://join.com/companies/${encodeURIComponent(handle.slug)}/${id}-${jslug}`;
      return {
        title,
        detail_url: detailUrl,
        apply_url: detailUrl,
        location: '',
        remote: isRemote(title, ''),
        department: '',
        posted_date: '',
        employment_type: '',
        raw: { id, slug: jslug, source: 'html' },
      };
    });
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`join ${handle.slug}: ${err.message}`);
    return [];
  }
}
