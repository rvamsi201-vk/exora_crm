const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, collect: csvCollect } = require('../lib/collectors/csv');
const { collect: manualCollect } = require('../lib/collectors/manual');
const { parseSignals } = require('../lib/collectors/website');

test('parseCsv handles quoted fields, embedded commas, and escaped quotes', () => {
  const text = 'name,address\n"Acme, Inc.","123 Main St, Suite ""A"""\nBeta,456 Oak Ave';
  const rows = parseCsv(text);
  assert.deepEqual(rows, [
    ['name', 'address'],
    ['Acme, Inc.', '123 Main St, Suite "A"'],
    ['Beta', '456 Oak Ave'],
  ]);
});

test('csv collector maps aliased headers to items, skipping rows without a name', async () => {
  const csv_text = 'Company Name,Website,Phone\nSunrise School,sunrise.example,9876543210\n,noname.example,111\nBeta School,,';
  const { items, errors } = await csvCollect({ csv_text });
  assert.equal(items.length, 2);
  assert.equal(items[0].company.name, 'Sunrise School');
  assert.equal(items[0].company.domain, 'sunrise.example');
  assert.equal(items[0].contact.phone, '9876543210');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /missing name/);
});

test('csv collector errors when no name column exists', async () => {
  const { items, errors } = await csvCollect({ csv_text: 'foo,bar\n1,2' });
  assert.equal(items.length, 0);
  assert.match(errors[0].message, /no name\/company column/);
});

test('manual collector validates required name', async () => {
  const missing = await manualCollect({});
  assert.equal(missing.items.length, 0);
  assert.match(missing.errors[0].message, /name is required/);

  const ok = await manualCollect({ name: 'Acme', email: 'a@acme.com' });
  assert.equal(ok.items.length, 1);
  assert.equal(ok.items[0].company.name, 'Acme');
  assert.equal(ok.items[0].contact.email, 'a@acme.com');
});

test('website collector parseSignals pulls title/email/phone/https', () => {
  const html = '<html><head><title>Acme Corp</title></head><body>Contact us: sales@acme.com or +91 98765 43210</body></html>';
  const signals = parseSignals(html, 'https://acme.example');
  assert.equal(signals.title, 'Acme Corp');
  assert.equal(signals.email, 'sales@acme.com');
  assert.equal(signals.has_https, true);
  assert.ok(signals.phone.includes('98765'));
});
