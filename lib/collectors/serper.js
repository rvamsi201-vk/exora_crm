const axios = require('axios');
const { emptyResult } = require('./base');
const { combineQueryWithLocation, locationMatches } = require('../normalize');

/**
 * Serper Maps discovery. Independent of the legacy lead-scraper.js pipeline
 * (which keeps writing straight into `leads` and must keep working as-is);
 * this collector only returns normalized items for the Phase 2 framework
 * to persist as companies/source_records.
 *
 * `location` (city/area/state/country) is optional and, when supplied, is
 * folded into the text actually sent to Serper — e.g. "gyms" + {area:
 * 'Koramangala', city: 'Bengaluru'} -> "gyms in Koramangala, Bengaluru".
 * `query` itself is untouched, so campaigns created before this feature
 * (or with no location set) search exactly as before.
 */
async function collect({ query, location, apiKey = process.env.SERPER_API_KEY, num = 20 } = {}) {
  if (!apiKey) throw new Error('SERPER_API_KEY not set');
  if (!query) throw new Error('query is required');

  const searchText = combineQueryWithLocation(query, location);
  const response = await axios.post(
    'https://google.serper.dev/maps',
    { q: searchText, num },
    { headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' }, timeout: 20000 }
  );

  const places = response.data?.places || [];
  const result = emptyResult();

  for (const place of places) {
    try {
      const name = place.title || place.name;
      if (!name) {
        result.errors.push({ message: 'place missing title/name', });
        continue;
      }

      const { matches, reason } = locationMatches(place.address, location);
      if (!matches) {
        result.errors.push({ external_ref: place.placeId || place.cid || name, message: `location mismatch: ${reason}` });
        continue;
      }

      result.items.push({
        external_ref: place.placeId || place.cid || name,
        company: { name, domain: place.website || null },
        location: place.address
          ? { address_line: place.address, city: location?.city || null, area: location?.area || null, state: location?.state || null, country: location?.country || null }
          : null,
        contact: (place.phoneNumber || place.phone) ? { phone: place.phoneNumber || place.phone } : null,
        raw: place,
      });
    } catch (err) {
      result.errors.push({ message: err.message });
    }
  }

  return result;
}

module.exports = { collect };
