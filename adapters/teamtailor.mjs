// adapters/teamtailor.mjs — Teamtailor adapter.
//
// There is no reliably public JSON endpoint for Teamtailor careers sites
// (the legacy /jobs.json now returns HTML, and api.teamtailor.com/v1 needs auth).
// We therefore fetch the public /jobs HTML page and extract each job card —
// every card is an <a href="https://{slug}.teamtailor.com/jobs/{id}-{slug}"> wrapping
// a <span ... title="Title">Title</span> plus department/location <span>s.

export const ATS = 'teamtailor';

const HOST_PATTERNS = [
  /([a-z0-9-]+)\.teamtailor\.com/i,
  /career\.teamtailor\.com\/([a-z0-9-]+)/i,
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
    if (slug && slug !== 'www' && slug !== 'career') {
      return {
        slug,
        boardUrl: `https://${slug}.teamtailor.com/`,
        jobsUrl: `https://${slug}.teamtailor.com/jobs`,
      };
    }
  }
  return null;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function isRemote(title, location) {
  const hay = `${title || ''} ${location || ''}`.toLowerCase();
  return /\bremote\b|\banywhere\b|home office|work from home/.test(hay);
}

async function fetchText(url, ctx) {
  if (ctx?.fetchText) return ctx.fetchText(url);
  const r = await fetch(url);
  return r.text();
}

// Pull a title out of a card's <a>…</a> inner HTML. Supports both:
//   * <span class="...company-link-style..." title="Title">Title</span>
//   * plain text inside <a> (newer list layout)
function extractTitle(inner) {
  const titleAttr = inner.match(/<span[^>]*company-link-style[^>]*title="([^"]+)"/i);
  if (titleAttr) return decodeEntities(titleAttr[1]);
  const spanTitled = inner.match(/<span[^>]*title="([^"]+)"[^>]*>/i);
  if (spanTitled) return decodeEntities(spanTitled[1]);
  const cls = inner.match(/<span[^>]*company-link-style[^>]*>([\s\S]*?)<\/span>/i);
  if (cls) return stripTags(cls[1]);
  // Plain text inside <a> — strip absolute-inset spans (decorative) first.
  const cleaned = inner.replace(/<span[^>]*absolute\s+inset-0[^>]*>[\s\S]*?<\/span>/gi, '');
  return stripTags(cleaned);
}

// Pull dept + location from a meta <div class="mt-1 text-md">…</div>.
function extractMeta(metaHtml) {
  const spans = [...metaHtml.matchAll(/<span(?![^>]*mx-\[2px\])[^>]*>([\s\S]*?)<\/span>/gi)]
    .map(m => stripTags(m[1])).filter(Boolean);
  if (spans.length >= 2) return { dept: spans[0], location: spans[1] };
  if (spans.length === 1) return { dept: '', location: spans[0] };
  return { dept: '', location: '' };
}

export async function fetchJobs(handle, ctx) {
  if (!handle?.jobsUrl) return [];
  try {
    const html = await fetchText(handle.jobsUrl, ctx);
    if (!html || html.length < 500) return [];
    // Find each <a> pointing at /jobs/{number}-... and try to associate a
    // sibling <div class="mt-1 text-md"> that immediately follows it.
    const re = /<a\b[^>]*href="(https?:\/\/[^"]*\/jobs\/\d+[^"]*)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,1200}?)(?=<a\b|<\/li>|<\/ul>)/gi;
    const seen = new Set();
    const out = [];
    let m;
    while ((m = re.exec(html)) !== null) {
      const [, href, inner, trailing] = m;
      if (seen.has(href)) continue;
      seen.add(href);
      const title = extractTitle(inner);
      if (!title) continue;
      // meta div may live inside <a> or right after it in the same card.
      const metaInner = inner.match(/<div[^>]*mt-1[^>]*text-md[^>]*>([\s\S]*?)<\/div>/i);
      const metaAfter = trailing.match(/<div[^>]*mt-1[^>]*text-md[^>]*>([\s\S]*?)<\/div>/i);
      const meta = extractMeta((metaInner || metaAfter || [, ''])[1]);
      out.push({
        title,
        detail_url: href,
        apply_url: href,
        location: meta.location,
        remote: isRemote(title, meta.location) || /fully remote/i.test(trailing),
        department: meta.dept,
        posted_date: '',
        employment_type: '',
        raw: { href, dept: meta.dept, location: meta.location },
      });
    }
    return out;
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`teamtailor ${handle.slug}: ${err.message}`);
    return [];
  }
}
