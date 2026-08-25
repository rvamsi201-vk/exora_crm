const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDomain, normalizeEmail, normalizePhone, normalizeCompanyName, normalizeLocation, combineQueryWithLocation, locationMatches } = require('../lib/normalize');

test('normalizeDomain strips protocol, www, path', () => {
  assert.equal(normalizeDomain('https://www.Example.com/path'), 'example.com');
  assert.equal(normalizeDomain('example.com'), 'example.com');
  assert.equal(normalizeDomain(''), null);
  assert.equal(normalizeDomain(null), null);
  assert.equal(normalizeDomain('not a url'), null);
});

test('normalizeEmail lowercases and validates shape', () => {
  assert.equal(normalizeEmail('  Foo@Example.COM '), 'foo@example.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail(''), null);
});

test('normalizePhone infers +91 for 10-digit Indian numbers', () => {
  assert.equal(normalizePhone('9876543210'), '+919876543210');
  assert.equal(normalizePhone('09876543210'), '+919876543210');
  assert.equal(normalizePhone('+91 98765 43210'), '+919876543210');
  assert.equal(normalizePhone('undefined'), null);
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('123'), null);
});

test('normalizeCompanyName lowercases and strips punctuation', () => {
  assert.equal(normalizeCompanyName("St. Mary's  School"), 'st marys school');
  assert.equal(normalizeCompanyName(''), null);
});

test('normalizeLocation combines area/city/state/country, lowercased', () => {
  assert.equal(normalizeLocation({ area: 'Koramangala', city: 'Bengaluru' }), 'koramangala, bengaluru');
  assert.equal(normalizeLocation({ city: 'Hyderabad', country: 'India' }), 'hyderabad, india');
  assert.equal(normalizeLocation({}), null);
  assert.equal(normalizeLocation(), null);
});

test('combineQueryWithLocation folds location into the search text, preserving the query when no location is given', () => {
  assert.equal(combineQueryWithLocation('gyms', { area: 'Koramangala', city: 'Bengaluru' }), 'gyms in Koramangala, Bengaluru');
  assert.equal(combineQueryWithLocation('dentists', { city: 'Hyderabad' }), 'dentists in Hyderabad');
  assert.equal(combineQueryWithLocation('preschools in Bengaluru', {}), 'preschools in Bengaluru');
  assert.equal(combineQueryWithLocation('preschools in Bengaluru'), 'preschools in Bengaluru');
  assert.equal(combineQueryWithLocation('', { city: 'Pune' }), 'Pune');
});

test('locationMatches: no location requested always passes (search stays broad)', () => {
  assert.equal(locationMatches('123 Main St, Some City, USA', {}).matches, true);
  assert.equal(locationMatches(null, {}).matches, true);
  assert.equal(locationMatches('', undefined).matches, true);
});

test('locationMatches: city-only search requires the city in the address', () => {
  assert.equal(locationMatches('Road No. 36, Jubilee Hills, Hyderabad, Telangana 500033', { city: 'Hyderabad' }).matches, true);
  const bad = locationMatches('5th Ave, New York, NY 10001, USA', { city: 'Hyderabad' });
  assert.equal(bad.matches, false);
  assert.match(bad.reason, /city "Hyderabad" not found/);
});

test('locationMatches: area+city requires city match and, with enough address detail, area match too', () => {
  assert.equal(
    locationMatches('80 Feet Rd, Koramangala 4th Block, Bengaluru, Karnataka 560034', { area: 'Koramangala', city: 'Bengaluru' }).matches,
    true
  );
  const wrongArea = locationMatches('MG Road, Indiranagar, Bengaluru, Karnataka 560038', { area: 'Koramangala', city: 'Bengaluru' });
  assert.equal(wrongArea.matches, false);
  assert.match(wrongArea.reason, /area "Koramangala" not found/);

  // Sparse address (fewer than 3 comma-separated parts) — area is not
  // strictly enforced, city match alone is enough.
  assert.equal(locationMatches('Bengaluru', { area: 'Koramangala', city: 'Bengaluru' }).matches, true);
});

test('locationMatches: supports Bengaluru/Bangalore and Mumbai/Bombay aliases', () => {
  assert.equal(locationMatches('Koramangala, Bangalore, Karnataka', { area: 'Koramangala', city: 'Bengaluru' }).matches, true);
  assert.equal(locationMatches('Andheri, Bombay, Maharashtra', { area: 'Andheri', city: 'Mumbai' }).matches, true);
});

test('locationMatches: excludes unrelated USA/UK results', () => {
  const usa = locationMatches('221 Baker St, San Francisco, CA 94102, USA', { city: 'Bengaluru' });
  assert.equal(usa.matches, false);
  const uk = locationMatches('10 Downing St, London, UK', { area: 'Andheri', city: 'Mumbai' });
  assert.equal(uk.matches, false);
});

test('locationMatches: rejects missing/empty address when a location was requested', () => {
  assert.equal(locationMatches('', { city: 'Hyderabad' }).matches, false);
  assert.equal(locationMatches(null, { city: 'Hyderabad' }).matches, false);
  assert.match(locationMatches(undefined, { city: 'Hyderabad' }).reason, /missing address/);
});
