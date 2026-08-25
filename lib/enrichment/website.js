const axios = require('axios');
const cheerio = require('cheerio');
const { parseRobots, isPathAllowed } = require('./robots');

// Identifies the crawler and gives a way to reach us — standard courtesy
// for a bot that isn't the human visiting the site.
const USER_AGENT = 'ExoraLeadForgeBot/1.0 (+enrichment; contact discovery for CRM outreach)';
const CONTACT_PATHS = ['/contact', '/contact-us'];

function extractSignals(html) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || null;
  const description = $('meta[name="description"]').attr('content')?.trim() || null;
  const bodyText = $('body').text();
  const emails = [...new Set(bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])];
  const phones = [...new Set((bodyText.match(/(\+?\d[\d\s\-().]{7,}\d)/g) || []).map((s) => s.trim()))];
  return { title, description, emails, phones };
}

async function fetchPage(url) {
  const response = await axios.get(url, { timeout: 15000, maxRedirects: 5, headers: { 'User-Agent': USER_AGENT } });
  return response.data;
}

/**
 * Fetches a company homepage plus, at most, one contact page — checking
 * robots.txt first and skipping anything it disallows. Two requests per
 * crawl, one crawl per enrichment job, is the "responsible" budget here;
 * deeper multi-page crawling is out of scope for this phase.
 */
async function crawlWebsite({ domain, baseUrl }) {
  const root = (baseUrl || `https://${domain}`).replace(/\/$/, '');
  const pagesFetched = [];
  const errors = [];

  let rules = { disallow: [] };
  try {
    const robotsRes = await axios.get(`${root}/robots.txt`, {
      timeout: 8000, headers: { 'User-Agent': USER_AGENT }, validateStatus: () => true,
    });
    if (robotsRes.status === 200) rules = parseRobots(robotsRes.data);
  } catch {
    // No robots.txt or it's unreachable — proceed as allowed.
  }

  if (!isPathAllowed(rules, '/')) {
    return { title: null, description: null, emails: [], phones: [], has_https: root.startsWith('https://'), pages_fetched: [], errors: [], skipped_reason: 'disallowed by robots.txt', home_html: null };
  }

  let homeHtml = null;
  try {
    homeHtml = await fetchPage(root);
    pagesFetched.push(root);
  } catch (err) {
    errors.push({ url: root, message: err.message });
  }

  const combined = { title: null, description: null, emails: [], phones: [] };
  if (homeHtml) Object.assign(combined, extractSignals(homeHtml));

  for (const path of CONTACT_PATHS) {
    if (!isPathAllowed(rules, path)) continue;
    try {
      const html = await fetchPage(`${root}${path}`);
      pagesFetched.push(`${root}${path}`);
      const signals = extractSignals(html);
      combined.emails = [...new Set([...combined.emails, ...signals.emails])];
      combined.phones = [...new Set([...combined.phones, ...signals.phones])];
      combined.description = combined.description || signals.description;
      break; // one contact page is enough
    } catch {
      // best-effort only; a missing /contact page is not an error
    }
  }

  // home_html is returned for in-process callers (e.g. scoring's gap
  // detection) that need the raw markup — never persist it as-is, it's not
  // meant to bloat source_records provenance rows.
  return { ...combined, has_https: root.startsWith('https://'), pages_fetched: pagesFetched, errors, home_html: homeHtml };
}

module.exports = { crawlWebsite, extractSignals };
