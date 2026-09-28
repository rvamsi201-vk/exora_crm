/**
 * Shared normalization helpers used by the Phase 1 backfill and later
 * enrichment/dedup phases. Pure functions, no I/O.
 */

function normalizeDomain(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let host;
  try {
    host = new URL(s).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, '');
  return host || null;
}

function normalizeEmail(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^[']+/, '').trim();
  if (/^(undefined|null|none|nan|#error!|#n\/a|#value!|#ref!|#name\?|#div\/0!|#null!)$/i.test(s)) return null;

  const hasPlus = s.startsWith('+');
  let digits = s.replace(/\D/g, '');
  if (!digits) return null;

  if (hasPlus) {
    // Already has an explicit country code.
  } else if (digits.length === 10) {
    digits = `91${digits}`;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    digits = `91${digits.slice(1)}`;
  } else if (digits.length === 12 && digits.startsWith('91')) {
    // already has country code
  }

  if (digits.length < 8) return null;
  return `+${digits}`;
}

function normalizeCompanyName(raw) {
  if (!raw) return null;
  const s = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[.,'"()&]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s || null;
}

function normalizeLocationPart(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  return s || null;
}

// Combined, matchable location string — e.g. {area:'Koramangala', city:'Bengaluru'}
// -> 'koramangala, bengaluru'. Used to populate normalized_location columns.
function normalizeLocation({ area, city, state, country } = {}) {
  const parts = [area, city, state, country].map(normalizeLocationPart).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// Builds the actual search string sent to a discovery source (Serper,
// n8n, ...): "gyms in Koramangala, Bengaluru". Returns `query` unchanged
// when no location is supplied, so existing searches keep working exactly
// as before.
function combineQueryWithLocation(query, { area, city, state, country } = {}) {
  const q = (query || '').trim();
  const locationPart = [area, city, state, country].map((v) => (v || '').trim()).filter(Boolean).join(', ');
  if (!locationPart) return q;
  return q ? `${q} in ${locationPart}` : locationPart;
}

// Pre/post-rename Indian city names — Serper/Google Maps results sometimes
// use the older name even when the requested location uses the current
// one (or vice versa). Each entry lists the *other* accepted spellings.
const CITY_ALIASES = {
  bengaluru: ['bangalore'],
  bangalore: ['bengaluru'],
  mumbai: ['bombay'],
  bombay: ['mumbai'],
  chennai: ['madras'],
  madras: ['chennai'],
  kolkata: ['calcutta'],
  calcutta: ['kolkata'],
  puducherry: ['pondicherry'],
  pondicherry: ['puducherry'],
};

// Words that carry no locational meaning on their own; dropped before
// matching so "in", "near" or a stray "the" never becomes a requirement.
const LOCATION_STOPWORDS = new Set(['in', 'at', 'near', 'the', 'and', 'of']);

/**
 * Splits a user-supplied location field into individual matchable terms.
 *
 * People do not fill these boxes the way the labels imply: "Vasanth Nagar
 * Bangalore" gets typed straight into City. Treating that as one literal
 * string can never match a real address, which reads "Vasanth Nagar,
 * Bengaluru" — different separator, different spelling of the city.
 */
function locationTerms(raw) {
  const normalized = normalizeLocationPart(raw);
  if (!normalized) return [];
  return normalized
    .split(/[\s,]+/)
    .map((t) => t.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter((t) => t.length > 1 && !LOCATION_STOPWORDS.has(t));
}

/**
 * Does one term appear in the address, allowing for renamed cities?
 *
 * Matched on word boundaries rather than as a bare substring: "vasanth"
 * must not be satisfied by "Vasantha Vallabha Nagar", which is a different
 * neighbourhood on the other side of the city.
 */
function termMatchesAddress(normalizedAddress, term) {
  if (!term) return true;
  const candidates = [term, ...(CITY_ALIASES[term] || [])];
  return candidates.some((c) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(normalizedAddress));
}

// Kept for callers that match a whole field at once.
function addressContainsPart(normalizedAddress, part) {
  if (!part) return true; // nothing requested for this field -> not a constraint
  return locationTerms(part).every((term) => termMatchesAddress(normalizedAddress, term));
}

/**
 * Splits the terms of a location field into the one that identifies the
 * city (a hard requirement) and the rest, which are treated like `area`
 * (a soft signal — see locationMatches).
 *
 * A term is taken as the city when it is a known renamed-city name;
 * failing that, the last term is used, which matches how addresses are
 * written everywhere: narrowest first, widest last.
 */
function splitCityTerms(terms) {
  if (!terms.length) return { city: null, rest: [] };
  const knownIndex = terms.findIndex((t) => Object.prototype.hasOwnProperty.call(CITY_ALIASES, t));
  const cityIndex = knownIndex === -1 ? terms.length - 1 : knownIndex;
  return { city: terms[cityIndex], rest: terms.filter((_, i) => i !== cityIndex) };
}

// Cities people actually search in this product, plus every alias above.
// Used only to work out which word in a messy entry is the city — an
// unlisted city still works, it just falls back to the positional rule.
const KNOWN_CITIES = new Set([
  ...Object.keys(CITY_ALIASES),
  'delhi', 'gurgaon', 'gurugram', 'noida', 'ghaziabad', 'faridabad',
  'hyderabad', 'secunderabad', 'pune', 'ahmedabad', 'surat', 'jaipur',
  'lucknow', 'kanpur', 'nagpur', 'indore', 'bhopal', 'patna', 'vadodara',
  'coimbatore', 'madurai', 'kochi', 'cochin', 'ernakulam', 'thiruvananthapuram',
  'trivandrum', 'mysore', 'mysuru', 'mangalore', 'mangaluru', 'hubli',
  'belgaum', 'visakhapatnam', 'vizag', 'vijayawada', 'guwahati', 'bhubaneswar',
  'ranchi', 'raipur', 'chandigarh', 'ludhiana', 'amritsar', 'dehradun',
  'goa', 'panaji', 'nashik', 'thane', 'navi', 'aurangabad', 'rajkot',
]);

/**
 * Turns whatever a person typed into a structured location.
 *
 * The Area and City boxes are a suggestion, not a contract: "Vasanth Nagar
 * Bangalore" gets typed straight into City, "Bengaluru" into Area, the whole
 * thing into either one. Rather than treat a full-location string as a city
 * name (which then matches nothing), work out which word is the city and
 * treat everything else as the area.
 *
 * The city is the first term that is a recognised city name; failing that,
 * the last term, since addresses run narrowest-first: "Koramangala, Bengaluru".
 *
 * Returns the same shape it was given, so a correctly-filled pair of boxes
 * passes through untouched.
 */
function parseLocationInput({ area, city, state, country } = {}) {
  const keep = (raw) => (raw == null ? null : String(raw).trim() || null);
  const tokensOf = (raw) =>
    (keep(raw) || '').split(/[\s,]+/).filter(Boolean)
      .filter((t) => {
        const n = normalizeLocationPart(t);
        return n && n.length > 1 && !LOCATION_STOPWORDS.has(n);
      });

  const areaTokens = tokensOf(area);
  const cityTokens = tokensOf(city);

  // Everything the person typed for "where", narrowest first.
  const all = [...areaTokens, ...cityTokens];
  if (!all.length) {
    return { area: keep(area), city: keep(city), state: keep(state), country: keep(country) };
  }

  const isCity = (t) => KNOWN_CITIES.has(normalizeLocationPart(t));
  let cityIndex = all.findIndex(isCity);
  if (cityIndex === -1) {
    // No recognised city name. If the person used both boxes, trust them and
    // treat the city box as the city. Otherwise the last term is the city.
    cityIndex = cityTokens.length ? all.length - cityTokens.length : all.length - 1;
    if (cityTokens.length > 1) cityIndex = all.length - 1;
  }

  const cityOut = all[cityIndex] || null;
  const areaOut = all.filter((_, i) => i !== cityIndex).join(' ') || null;

  return {
    area: areaOut,
    city: cityOut,
    state: keep(state),
    country: keep(country),
  };
}

// Grades a collected result's address against the requested location.
//
//   confidence 'exact' — the neighbourhood matched too
//   confidence 'city'  — right city, different (or unstated) neighbourhood
//   matches: false     — wrong city/state/country
//
// Only the last of those is a rejection. The city/state/country terms are a
// hard gate because they are what keeps a US or UK listing out of an Indian
// search. A neighbourhood mismatch is NOT a rejection: the discovery source
// already judged the result relevant to the search, many valid addresses
// simply omit the locality, and throwing those away leaves a salesperson
// with nothing to show for a search that genuinely worked. They are kept
// and flagged so the caller can report how many fell outside the exact area.
function locationMatches(addressText, location = {}) {
  const { area, city, state, country } = location;
  if (!area && !city && !state && !country) return { matches: true, confidence: 'exact' };

  const raw = (addressText || '').trim();
  const normalizedAddress = normalizeLocationPart(raw) || '';
  if (!normalizedAddress) {
    return { matches: false, confidence: null, reason: 'missing address for a location-constrained search' };
  }

  const { city: cityTerm, rest: cityExtras } = splitCityTerms(locationTerms(city));
  if (cityTerm && !termMatchesAddress(normalizedAddress, cityTerm)) {
    return { matches: false, confidence: null, reason: `city "${city}" not found in address "${raw}"` };
  }
  for (const term of locationTerms(state)) {
    if (!termMatchesAddress(normalizedAddress, term)) {
      return { matches: false, confidence: null, reason: `state "${state}" not found in address "${raw}"` };
    }
  }
  for (const term of locationTerms(country)) {
    if (!termMatchesAddress(normalizedAddress, term)) {
      return { matches: false, confidence: null, reason: `country "${country}" not found in address "${raw}"` };
    }
  }

  const areaTerms = [...locationTerms(area), ...cityExtras];
  if (areaTerms.length) {
    const missing = areaTerms.filter((t) => !termMatchesAddress(normalizedAddress, t));
    if (missing.length) {
      const label = area || missing.join(' ');
      return {
        matches: true,
        confidence: 'city',
        note: `outside "${label}" but within ${cityTerm || 'the requested area'}`,
      };
    }
  }

  return { matches: true, confidence: 'exact' };
}

module.exports = {
  normalizeDomain, normalizeEmail, normalizePhone, normalizeCompanyName,
  normalizeLocation, normalizeLocationPart, combineQueryWithLocation, locationMatches,
  locationTerms, termMatchesAddress, parseLocationInput,
};
