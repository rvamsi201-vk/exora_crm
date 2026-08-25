const test = require('node:test');
const assert = require('node:assert/strict');
const { detectGaps, GAP_DEFINITIONS, MAX_BOOST } = require('../lib/scoring/gaps');
const {
  computeCompleteness, computeFit, computeOpportunity, computeIntent, computeEngagement, computeOverall, WEIGHTS,
} = require('../lib/scoring/company');

test('detectGaps: missing website flags every gap', () => {
  const gaps = detectGaps(null, 'missing', false);
  assert.equal(gaps.length, GAP_DEFINITIONS.length);
});

test('detectGaps: live site with recognized tech signatures clears those gaps', () => {
  const html = `<html><body>
    <script src="https://js.hubspot.com/forms.js"></script>
    <a href="https://razorpay.com/checkout">Pay</a>
  </body></html>`;
  const gaps = detectGaps(html, 'live', true);
  const keys = gaps.map((g) => g.key);
  assert.ok(!keys.includes('crm'), 'hubspot script should clear the crm gap');
  assert.ok(!keys.includes('payment'), 'razorpay link should clear the payment gap');
  assert.ok(!keys.includes('ssl'), 'https should clear the ssl gap');
  assert.ok(keys.includes('lms'), 'no lms signal present, should remain a gap');
});

test('detectGaps: live site over http (no https) flags ssl', () => {
  const gaps = detectGaps('<html><body>hi</body></html>', 'live', false);
  assert.ok(gaps.map((g) => g.key).includes('ssl'));
});

test('computeCompleteness sums present factors and caps at 100', () => {
  const full = computeCompleteness({ hasDomain: true, hasLocation: true, hasVerifiedContact: true, hasDescription: true, hasIndustryOrSize: true });
  assert.equal(full.value, 100);
  const empty = computeCompleteness({});
  assert.equal(empty.value, 0);
  const partial = computeCompleteness({ hasDomain: true, hasVerifiedContact: true });
  assert.equal(partial.value, 50);
});

test('computeFit falls back to neutral 50 when no legacy rating data exists', () => {
  const noData = computeFit({ rating: null, reviews: null });
  assert.equal(noData.value, 50);
  assert.equal(noData.source, 'no_rating_data');
});

test('computeFit scales legacy rating/review points to 0-100', () => {
  const best = computeFit({ rating: 4.8, reviews: 300 });
  assert.equal(best.value, 100); // 25+20=45 of 45 max
  const none = computeFit({ rating: 0, reviews: 0 });
  assert.equal(none.value, 0);
});

test('computeOpportunity scales gap boost sum against MAX_BOOST', () => {
  const noGaps = computeOpportunity([], 'live');
  assert.equal(noGaps.value, 0);
  const allGaps = computeOpportunity(GAP_DEFINITIONS, 'missing');
  assert.equal(allGaps.value, 100);
  assert.equal(GAP_DEFINITIONS.reduce((s, g) => s + g.boost, 0), MAX_BOOST);
});

test('computeIntent reads opportunity stage, defaults low when no opportunity exists', () => {
  assert.equal(computeIntent(null).value, 10);
  assert.equal(computeIntent('qualified').value, 70);
  assert.equal(computeIntent('won').value, 100);
  assert.equal(computeIntent('lost').value, 0);
});

test('computeEngagement scales with interaction count and verified-contact bonus', () => {
  assert.equal(computeEngagement(0, false).value, 0);
  assert.equal(computeEngagement(1, false).value, 30);
  assert.equal(computeEngagement(6, false).value, 90);
  assert.equal(computeEngagement(6, true).value, 100);
});

test('computeOverall applies the documented weights', () => {
  const components = {
    fit: { value: 100 }, intent: { value: 0 }, completeness: { value: 0 }, engagement: { value: 0 }, opportunity: { value: 0 },
  };
  assert.equal(computeOverall(components), Math.round(100 * WEIGHTS.fit));
});
