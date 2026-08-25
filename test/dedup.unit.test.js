const test = require('node:test');
const assert = require('node:assert/strict');
const { levenshtein, nameSimilarity } = require('../lib/dedup/similarity');
const { findCompanyCandidates, findContactCandidates } = require('../lib/dedup/candidates');
const { parseRobots, isPathAllowed } = require('../lib/enrichment/robots');
const { extractSignals } = require('../lib/enrichment/website');

test('levenshtein and nameSimilarity basics', () => {
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(nameSimilarity('acme', 'acme'), 1);
  assert.equal(nameSimilarity('', 'acme'), 0);
  assert.ok(nameSimilarity('sunrise school', 'sunrise public school') > 0.6);
  assert.ok(nameSimilarity('acme corp', 'totally different co') < 0.5);
});

test('findCompanyCandidates flags exact domain matches at high confidence', () => {
  const companies = [
    { id: 'a', name: 'Acme', normalized_name: 'acme', normalized_domain: 'acme.com', created_at: '2024-01-01' },
    { id: 'b', name: 'Acme Inc', normalized_name: 'acme inc', normalized_domain: 'acme.com', created_at: '2024-01-02' },
    { id: 'c', name: 'Totally Unrelated', normalized_name: 'totally unrelated', normalized_domain: 'other.com', created_at: '2024-01-03' },
  ];
  const candidates = findCompanyCandidates(companies);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].confidence, 0.97);
  assert.deepEqual([candidates[0].entity_id_a, candidates[0].entity_id_b].sort(), ['a', 'b']);
  assert.ok(candidates[0].reasons.includes('exact domain match'));
});

test('findCompanyCandidates flags fuzzy name matches at lower confidence, ignores unrelated names', () => {
  const companies = [
    { id: 'a', name: 'Sunrise School', normalized_name: 'sunrise school', normalized_domain: null, created_at: '2024-01-01' },
    { id: 'b', name: 'Sunrise Public School', normalized_name: 'sunrise public school', normalized_domain: null, created_at: '2024-01-02' },
    { id: 'c', name: 'Zenith Gym', normalized_name: 'zenith gym', normalized_domain: null, created_at: '2024-01-03' },
  ];
  const candidates = findCompanyCandidates(companies);
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0].confidence < 0.95);
  assert.ok(candidates[0].confidence > 0.5);
});

test('findContactCandidates flags exact email and phone matches', () => {
  const contacts = [
    { id: 'x', normalized_email: 'a@acme.com', normalized_phone: null, created_at: '2024-01-01' },
    { id: 'y', normalized_email: 'a@acme.com', normalized_phone: '+919876543210', created_at: '2024-01-02' },
    { id: 'z', normalized_email: 'unrelated@other.com', normalized_phone: '+919876543210', created_at: '2024-01-03' },
  ];
  const candidates = findContactCandidates(contacts);
  const key = (c) => [c.entity_id_a, c.entity_id_b].sort().join('|');
  const byPair = new Map(candidates.map((c) => [key(c), c]));
  assert.equal(byPair.get('x|y').confidence, 0.98);
  assert.ok(byPair.get('y|z').reasons.includes('exact phone match'));
});

test('robots.txt parser respects Disallow rules for the wildcard user-agent only', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /private\n\nUser-agent: OtherBot\nDisallow: /\n');
  assert.equal(isPathAllowed(rules, '/'), true);
  assert.equal(isPathAllowed(rules, '/private'), false);
  assert.equal(isPathAllowed(rules, '/private/sub'), false);
  assert.equal(isPathAllowed(rules, '/contact'), true);
});

test('robots.txt: Disallow: / blocks everything', () => {
  const rules = parseRobots('User-agent: *\nDisallow: /\n');
  assert.equal(isPathAllowed(rules, '/'), false);
});

test('extractSignals pulls title/description/emails/phones from HTML', () => {
  const html = `<html><head><title>Acme Corp</title><meta name="description" content="We sell widgets."></head>
    <body>Reach us at sales@acme.com or +91 98765 43210, also info@acme.com</body></html>`;
  const signals = extractSignals(html);
  assert.equal(signals.title, 'Acme Corp');
  assert.equal(signals.description, 'We sell widgets.');
  assert.deepEqual(signals.emails.sort(), ['info@acme.com', 'sales@acme.com']);
  assert.equal(signals.phones.length, 1);
});
