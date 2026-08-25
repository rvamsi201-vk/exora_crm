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

function addressContainsPart(normalizedAddress, part) {
  if (!part) return true; // nothing requested for this field -> not a constraint
  if (normalizedAddress.includes(part)) return true;
  const aliases = CITY_ALIASES[part] || [];
  return aliases.some((alias) => normalizedAddress.includes(alias));
}

// Validates a collected result's address against the requested location.
// city/state/country are hard requirements when supplied — each must
// appear (directly or via CITY_ALIASES) in the address text, which is what
// keeps unrelated-country results (a US or UK listing won't contain an
// Indian city name) out of the saved data. `area` is a softer signal: it's
// only checked when the address string has enough comma-separated detail
// (>=3 parts, e.g. "street, area, city, state pincode") to plausibly carry
// a neighborhood — many valid Google Maps addresses omit the locality name
// even for a correctly-located business, so a strict area match would
// reject good results.
function locationMatches(addressText, location = {}) {
  const { area, city, state, country } = location;
  if (!area && !city && !state && !country) return { matches: true };

  const raw = (addressText || '').trim();
  const normalizedAddress = normalizeLocationPart(raw) || '';
  if (!normalizedAddress) {
    return { matches: false, reason: 'missing address for a location-constrained search' };
  }

  const cityPart = normalizeLocationPart(city);
  if (cityPart && !addressContainsPart(normalizedAddress, cityPart)) {
    return { matches: false, reason: `city "${city}" not found in address "${raw}"` };
  }
  const statePart = normalizeLocationPart(state);
  if (statePart && !addressContainsPart(normalizedAddress, statePart)) {
    return { matches: false, reason: `state "${state}" not found in address "${raw}"` };
  }
  const countryPart = normalizeLocationPart(country);
  if (countryPart && !addressContainsPart(normalizedAddress, countryPart)) {
    return { matches: false, reason: `country "${country}" not found in address "${raw}"` };
  }

  const areaPart = normalizeLocationPart(area);
  if (areaPart) {
    const addressParts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (addressParts.length >= 3 && !addressContainsPart(normalizedAddress, areaPart)) {
      return { matches: false, reason: `area "${area}" not found in address "${raw}"` };
    }
  }

  return { matches: true };
}

module.exports = {
  normalizeDomain, normalizeEmail, normalizePhone, normalizeCompanyName,
  normalizeLocation, normalizeLocationPart, combineQueryWithLocation, locationMatches,
};
