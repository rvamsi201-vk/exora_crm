const test = require('node:test');
const assert = require('node:assert/strict');

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  Object.assign(process.env, overrides);
  return Promise.resolve(fn()).finally(() => {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
}

test('email.send always simulates outside production, even when "configured"', async () => {
  await withEnv({ NODE_ENV: 'test', EMAIL_PROVIDER: 'sendgrid', EMAIL_API_KEY: 'fake', EMAIL_FROM: 'a@b.com' }, async () => {
    delete require.cache[require.resolve('../lib/outreach/email')];
    const email = require('../lib/outreach/email');
    assert.equal(email.isConfigured(), true);
    const result = await email.send({ to: 'x@y.com', subject: 'hi', body: 'hello' });
    assert.equal(result.status, 'simulated');
    assert.equal(result.provider, null);
  });
});

test('email.send simulates in production when unconfigured (never throws)', async () => {
  await withEnv({ NODE_ENV: 'production', EMAIL_PROVIDER: '', EMAIL_API_KEY: '', EMAIL_FROM: '' }, async () => {
    delete require.cache[require.resolve('../lib/outreach/email')];
    const email = require('../lib/outreach/email');
    assert.equal(email.isConfigured(), false);
    const result = await email.send({ to: 'x@y.com', subject: 'hi', body: 'hello' });
    assert.equal(result.status, 'simulated');
  });
});

test('email.send rejects an unsupported provider name (only when actually configured+production)', async () => {
  await withEnv({ NODE_ENV: 'production', EMAIL_PROVIDER: 'made-up', EMAIL_API_KEY: 'fake', EMAIL_FROM: 'a@b.com' }, async () => {
    delete require.cache[require.resolve('../lib/outreach/email')];
    const email = require('../lib/outreach/email');
    await assert.rejects(() => email.send({ to: 'x@y.com', subject: 'hi', body: 'hello' }), /Unsupported EMAIL_PROVIDER/);
  });
});

test('whatsapp.send always simulates outside production', async () => {
  await withEnv({ NODE_ENV: 'test', WHATSAPP_PROVIDER: 'meta_cloud_api', WHATSAPP_ACCESS_TOKEN: 'fake', WHATSAPP_PHONE_NUMBER_ID: '123' }, async () => {
    delete require.cache[require.resolve('../lib/outreach/whatsapp')];
    const whatsapp = require('../lib/outreach/whatsapp');
    assert.equal(whatsapp.isConfigured(), true);
    const result = await whatsapp.send({ to: '+919876543210', body: 'hi' });
    assert.equal(result.status, 'simulated');
  });
});

test('calling.getCallLink builds a tel: URI; initiateCall simulates outside production', async () => {
  const { getCallLink, initiateCall } = require('../lib/outreach/calling');
  assert.equal(getCallLink('+91 98765 43210'), 'tel:+919876543210');
  assert.equal(getCallLink(null), null);
  await withEnv({ NODE_ENV: 'test' }, async () => {
    const result = await initiateCall({ to: '+919876543210' });
    assert.equal(result.status, 'simulated');
    assert.equal(result.call_link, 'tel:+919876543210');
  });
});
