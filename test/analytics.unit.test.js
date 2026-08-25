const test = require('node:test');
const assert = require('node:assert/strict');
const { rate } = require('../lib/analytics/reports');

test('rate() computes a rounded ratio and guards divide-by-zero', () => {
  assert.equal(rate(1, 3), 0.333);
  assert.equal(rate(0, 0), null);
  assert.equal(rate(5, 0), null);
  assert.equal(rate(0, 10), 0);
  assert.equal(rate(10, 10), 1);
});
