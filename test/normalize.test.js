const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDomain, normalizeEmail, normalizePhone, normalizeCompanyName, normalizeLocation, combineQueryWithLocation, locationMatches, locationTerms, parseLocationInput } = require('../lib/normalize');

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

test('locationMatches: area+city requires the city, and grades the area rather than rejecting on it', () => {
  assert.equal(
    locationMatches('80 Feet Rd, Koramangala 4th Block, Bengaluru, Karnataka 560034', { area: 'Koramangala', city: 'Bengaluru' }).matches,
    true
  );
  // A different neighbourhood in the right city is kept, not discarded —
  // it is still a usable lead — but flagged so a run can report it.
  const wrongArea = locationMatches('MG Road, Indiranagar, Bengaluru, Karnataka 560038', { area: 'Koramangala', city: 'Bengaluru' });
  assert.equal(wrongArea.matches, true);
  assert.equal(wrongArea.confidence, 'city');
  assert.match(wrongArea.note, /outside "Koramangala"/);

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

test('locationMatches: a whole location typed into the city box behaves like area + city', () => {
  // Real report from production: everything went into City as
  // "vasanth nagar bangalore", and all 20 Serper results were rejected —
  // the field was matched as one literal string, which can never appear in
  // an address written "Vasanth Nagar, Bengaluru".
  const loc = { city: 'vasanth nagar bangalore' };
  assert.equal(
    locationMatches('45, Millers Rd, Kaverappa Layout, Vasanth Nagar, Bengaluru, Karnataka 560001, India', loc).matches,
    true
  );
  assert.equal(
    locationMatches('3rd Cross Rd, Vasanth Nagar, Bengaluru, Karnataka 560001, India', loc).matches,
    true
  );
  // Still in Bengaluru, different neighbourhood: kept and flagged.
  const elsewhere = locationMatches('VP Deenadayalu Naidu Rd, Jayamahal Extension, Jayamahal, Bengaluru, Karnataka 560006, India', loc);
  assert.equal(elsewhere.matches, true);
  assert.equal(elsewhere.confidence, 'city');
  assert.match(elsewhere.note, /vasanth nagar/);
});

test('locationMatches: area terms grade on word boundaries, not substrings', () => {
  // "Vasantha Vallabha Nagar" is a different locality and must not be graded
  // as an exact hit for "Vasanth Nagar" — a bare substring test would.
  const r = locationMatches(
    '4th floor, Plot 22, 1st A Cross Rd, Vasantha Vallabha Nagar, Bikasipura, Bengaluru, Karnataka 560062, India',
    { area: 'Vasanth Nagar', city: 'Bengaluru' }
  );
  assert.equal(r.confidence, 'city');
  // ...while the real Vasanth Nagar does grade as exact.
  const real = locationMatches(
    '46, 8th Main Rd, Vasanth Nagar, Bengaluru, Karnataka 560001, India',
    { area: 'Vasanth Nagar', city: 'Bengaluru' }
  );
  assert.equal(real.confidence, 'exact');
});

test('locationMatches: city aliases still apply to a multi-word entry', () => {
  assert.equal(locationMatches('Koramangala, Bangalore, Karnataka', { city: 'koramangala bengaluru' }).matches, true);
  assert.equal(locationMatches('Bandra West, Mumbai, Maharashtra', { city: 'bandra bombay' }).matches, true);
});

test('locationMatches: a sparse address is not rejected for missing the neighbourhood', () => {
  // Google often omits the locality; the city is the hard requirement.
  assert.equal(locationMatches('Bengaluru', { city: 'vasanth nagar bangalore' }).matches, true);
  assert.equal(locationMatches('Bengaluru, India', { area: 'Koramangala', city: 'Bengaluru' }).matches, true);
});

test('locationMatches: an unknown city name still anchors the search', () => {
  // "hyderabad" is not in CITY_ALIASES, so the last term is taken as the city.
  const loc = { city: 'jubilee hills hyderabad' };
  assert.equal(locationMatches('Road No. 36, Jubilee Hills, Hyderabad, Telangana 500033', loc).matches, true);
  assert.equal(locationMatches('5th Ave, New York, NY 10001, USA', loc).matches, false);
});

test('locationTerms: splits on commas and spaces, drops noise', () => {
  assert.deepEqual(locationTerms('Vasanth Nagar, Bangalore'), ['vasanth', 'nagar', 'bangalore']);
  assert.deepEqual(locationTerms('  near  the  MG Road '), ['mg', 'road']);
  assert.deepEqual(locationTerms(''), []);
  assert.deepEqual(locationTerms(null), []);
});

test('parseLocationInput: a whole location in one box is split into area + city', () => {
  assert.deepEqual(
    parseLocationInput({ city: 'vasanth nagar bangalore' }),
    { area: 'vasanth nagar', city: 'bangalore', state: null, country: null }
  );
  assert.deepEqual(
    parseLocationInput({ area: 'koramangala bengaluru' }),
    { area: 'koramangala', city: 'bengaluru', state: null, country: null }
  );
  assert.deepEqual(
    parseLocationInput({ city: 'indiranagar, bangalore' }),
    { area: 'indiranagar', city: 'bangalore', state: null, country: null }
  );
});

test('parseLocationInput: correctly-filled boxes pass through untouched', () => {
  assert.deepEqual(
    parseLocationInput({ area: 'Vasanth Nagar', city: 'Bengaluru' }),
    { area: 'Vasanth Nagar', city: 'Bengaluru', state: null, country: null }
  );
  assert.deepEqual(
    parseLocationInput({ area: 'Jubilee Hills', city: 'Hyderabad' }),
    { area: 'Jubilee Hills', city: 'Hyderabad', state: null, country: null }
  );
});

test('parseLocationInput: an unrecognised city falls back to the last term', () => {
  // Narrowest-first is how addresses are written everywhere.
  assert.deepEqual(
    parseLocationInput({ city: 'salt lake sector five kolkata' }).city, 'kolkata'
  );
  assert.deepEqual(parseLocationInput({ city: 'Somborough' }).city, 'Somborough');
  assert.deepEqual(parseLocationInput({}), { area: null, city: null, state: null, country: null });
});

test('locationMatches: a right-city / wrong-neighbourhood result is kept and flagged, not rejected', () => {
  const loc = parseLocationInput({ city: 'vasanth nagar bangalore' });
  const near = locationMatches('Seshadripuram, Bengaluru, Karnataka 560003, India', loc);
  assert.equal(near.matches, true, 'a nearby lead must not be discarded');
  assert.equal(near.confidence, 'city');
  assert.match(near.note, /outside/);

  const exact = locationMatches('46, 8th Main Rd, Vasanth Nagar, Bengaluru, Karnataka 560001, India', loc);
  assert.equal(exact.matches, true);
  assert.equal(exact.confidence, 'exact');
});

test('locationMatches: the wrong-city gate still rejects', () => {
  const loc = parseLocationInput({ city: 'vasanth nagar bangalore' });
  assert.equal(locationMatches('5th Ave, New York, NY 10001, USA', loc).matches, false);
  assert.equal(locationMatches('221B Baker St, London NW1 6XE, UK', loc).matches, false);
  assert.equal(locationMatches('Jubilee Hills, Hyderabad, Telangana 500033', loc).matches, false);
});

test('the reported production failure now saves every result', () => {
  // The 05:47 run: 20 Serper results, all rejected. All are in Bengaluru,
  // so none should be discarded; 10 are outside Vasanth Nagar itself.
  const loc = parseLocationInput({ city: 'vasanth nagar bangalore' });
  const addresses = [
    '45, Millers Rd, Kaverappa Layout, Vasanth Nagar, Bengaluru, Karnataka 560001, India',
    '1/1, KSFC Building, Millers Tank Bund Rd, Vasanth Nagar, Bengaluru, Karnataka 560052, India',
    '5th Level, HTC Aspire 19, Ali Asker Rd, Vasanth Nagar, Bengaluru, Karnataka 560052, India',
    '46, 8th Main Rd, Vasanth Nagar, Bengaluru, Karnataka 560001, India',
    'VP Deenadayalu Naidu Rd, Jayamahal Extension, Jayamahal, Bengaluru, Karnataka 560006, India',
    'Seshadripuram, Bengaluru, Karnataka 560003, India',
    '73 & 74, Abmgp building, 17th Cross Rd, Malleshwaram, Bengaluru, Karnataka 560055, India',
    'Cruz Manor, 9, Mosque Rd, Cleveland Town, Fraser Town, Bengaluru, Karnataka 560005, India',
  ];
  const graded = addresses.map((a) => locationMatches(a, loc));
  assert.equal(graded.filter((r) => !r.matches).length, 0, 'nothing in the right city may be rejected');
  assert.equal(graded.filter((r) => r.confidence === 'exact').length, 4);
  assert.equal(graded.filter((r) => r.confidence === 'city').length, 4);
});
