// adapters/personio.mjs — Personio public XML feed adapter.
//
// Feed: https://{slug}.jobs.personio.com/xml (or .de) — root <workzag-jobs>, children <position>.
// No JSON endpoint is public; we parse the XML with a tiny regex-based extractor.

export const ATS = 'personio';

const HOST_PATTERNS = [
  /([a-z0-9-]+)\.jobs\.personio\.(com|de)/i,
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

function matchHost(url) {
  for (const re of HOST_PATTERNS) {
    const m = url.match(re);
    if (m) return { slug: decodeURIComponent(m[1]), tld: m[2] };
  }
  return null;
}

export function detect(company) {
  for (const url of candidateUrls(company)) {
    const h = matchHost(url);
    if (h) {
      const base = `https://${h.slug}.jobs.personio.${h.tld}`;
      return {
        slug: h.slug,
        apiUrl: `${base}/xml`,
        boardUrl: `${base}/`,
      };
    }
  }
  return null;
}

// Decode common XML entities. CDATA is handled separately.
function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

// Extract the text inside the first <tag>...</tag>. Strips CDATA wrappers.
function childText(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) v = cdata[1];
  return decodeEntities(v);
}

function splitPositions(xml) {
  const out = [];
  const re = /<position[^>]*>([\s\S]*?)<\/position>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function isRemote(title, location, occupation) {
  const hay = `${title || ''} ${location || ''} ${occupation || ''}`.toLowerCase();
  return /\bremote\b|\banywhere\b|home office|work from home|work_at_home|remote_work/.test(hay);
}

async function fetchText(url, ctx) {
  if (ctx?.fetchText) return ctx.fetchText(url);
  const r = await fetch(url);
  return r.text();
}

export async function fetchJobs(handle, ctx) {
  if (!handle?.apiUrl) return [];
  try {
    const xml = await fetchText(handle.apiUrl, ctx);
    if (!xml || !/<workzag-jobs|<position/i.test(xml)) return [];
    const positions = splitPositions(xml);
    return positions.map(block => {
      const id = childText(block, 'id');
      const title = childText(block, 'name');
      const office = childText(block, 'office');
      const subcompany = childText(block, 'subcompany');
      const location = [office, subcompany].filter(Boolean).join(' / ');
      const department = childText(block, 'department') || childText(block, 'recruitingCategory');
      const employmentType = childText(block, 'employmentType') || childText(block, 'schedule');
      const occupation = childText(block, 'occupation');
      const createdAt = childText(block, 'createdAt');
      const detailUrl = id ? `${handle.boardUrl}job/${id}` : handle.boardUrl;
      return {
        title,
        detail_url: detailUrl,
        apply_url: detailUrl,
        location,
        remote: isRemote(title, location, occupation),
        department,
        posted_date: createdAt,
        employment_type: employmentType,
        raw: { id, office, subcompany, department, employmentType, occupation, createdAt },
      };
    }).filter(j => j.title);
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`personio ${handle.slug}: ${err.message}`);
    return [];
  }
}
