// adapters/ashby.mjs — Ashby Job Board Posting API adapter.
//
// API: https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
// Public boards live at jobs.ashbyhq.com/{slug}.

export const ATS = 'ashby';

const HOST_PATTERN = /jobs\.ashbyhq\.com\/([^/?#]+)/i;

function candidateUrls(company) {
  const urls = [];
  if (Array.isArray(company?.ats_links)) urls.push(...company.ats_links);
  if (company?.ats_url) urls.push(company.ats_url);
  if (company?.careers_url) urls.push(company.careers_url);
  if (company?.api) urls.push(company.api);
  return urls.filter(Boolean);
}

function matchSlug(url) {
  const m = url.match(HOST_PATTERN);
  return m ? decodeURIComponent(m[1]) : null;
}

export function detect(company) {
  for (const url of candidateUrls(company)) {
    const slug = matchSlug(url);
    if (slug) {
      return {
        slug,
        apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`,
      };
    }
  }
  return null;
}

function isRemote(title, location, workplaceType, isRemoteFlag) {
  if (isRemoteFlag === true) return true;
  const hay = `${title || ''} ${location || ''} ${workplaceType || ''}`.toLowerCase();
  return /\bremote\b|\banywhere\b|work from home/.test(hay);
}

export async function fetchJobs(handle, ctx) {
  if (!handle?.apiUrl) return [];
  try {
    const json = await ctx.fetchJson(handle.apiUrl);
    const jobs = json?.jobs || [];
    return jobs.map(j => {
      const title = j.title || '';
      const location = j.location || j.locationName || '';
      const detailUrl = j.jobUrl || j.applyUrl || '';
      return {
        title,
        detail_url: detailUrl,
        apply_url: detailUrl,
        location,
        remote: isRemote(title, location, j.workplaceType, j.isRemote),
        department: j.departmentName || j.teamName || '',
        posted_date: j.publishedAt || j.updatedAt || '',
        employment_type: j.employmentType || '',
        raw: j,
      };
    });
  } catch (err) {
    if (ctx?.logWarn) ctx.logWarn(`ashby ${handle.slug}: ${err.message}`);
    return [];
  }
}
