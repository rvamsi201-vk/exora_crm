const axios = require('axios');
const cheerio = require('cheerio');
const { emptyResult } = require('./base');
const { normalizeDomain } = require('../normalize');

/**
 * Website discovery: given a domain, fetch its homepage and pull out
 * lightweight public signals (title, contact email/phone if present on the
 * page). Deeper enrichment (crawling multiple pages, tech detection,
 * confidence scoring) is Phase 3 scope — this stays intentionally small.
 */
function parseSignals(html, url) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || null;

  const bodyText = $('body').text();
  const emailMatch = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const phoneMatch = bodyText.match(/(\+?\d[\d\s\-().]{7,}\d)/);

  return {
    title,
    email: emailMatch ? emailMatch[0] : null,
    phone: phoneMatch ? phoneMatch[0].trim() : null,
    has_https: url.startsWith('https://'),
  };
}

async function collect({ domain } = {}) {
  const result = emptyResult();
  const normalized = normalizeDomain(domain);
  if (!normalized) {
    result.errors.push({ message: `invalid domain: ${domain}` });
    return result;
  }

  const url = `https://${normalized}`;
  try {
    const response = await axios.get(url, { timeout: 15000, maxRedirects: 5 });
    const signals = parseSignals(response.data, response.request?.res?.responseUrl || url);

    result.items.push({
      external_ref: normalized,
      company: { name: signals.title || normalized, domain: normalized },
      location: null,
      contact: (signals.email || signals.phone) ? { email: signals.email, phone: signals.phone } : null,
      raw: signals,
    });
  } catch (err) {
    result.errors.push({ external_ref: normalized, message: err.message });
  }

  return result;
}

module.exports = { collect, parseSignals };
