const test = require('node:test');
const assert = require('node:assert/strict');
const { parseModelResponse } = require('../lib/ai/research');

test('isConfigured is false with no AI_PROVIDER/AI_API_KEY set', () => {
  delete process.env.AI_PROVIDER;
  delete process.env.AI_API_KEY;
  const { isConfigured } = require('../lib/ai/provider');
  assert.equal(isConfigured(), false);
});

test('isConfigured requires both AI_PROVIDER and AI_API_KEY', () => {
  const provider = require('../lib/ai/provider');
  const origP = process.env.AI_PROVIDER, origK = process.env.AI_API_KEY;
  try {
    process.env.AI_PROVIDER = 'anthropic';
    delete process.env.AI_API_KEY;
    assert.equal(provider.isConfigured(), false);
    process.env.AI_API_KEY = 'test-key';
    assert.equal(provider.isConfigured(), true);
  } finally {
    if (origP === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = origP;
    if (origK === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = origK;
  }
});

test('generate() rejects an unconfigured provider without making a network call', async () => {
  delete process.env.AI_PROVIDER;
  delete process.env.AI_API_KEY;
  const provider = require('../lib/ai/provider');
  await assert.rejects(() => provider.generate({ system: 'x', prompt: 'y' }), /not configured/);
});

test('generate() rejects an unsupported provider name', async () => {
  const provider = require('../lib/ai/provider');
  const origP = process.env.AI_PROVIDER, origK = process.env.AI_API_KEY;
  process.env.AI_PROVIDER = 'made-up-provider';
  process.env.AI_API_KEY = 'test-key';
  try {
    await assert.rejects(() => provider.generate({ system: 'x', prompt: 'y' }), /Unsupported AI_PROVIDER/);
  } finally {
    if (origP === undefined) delete process.env.AI_PROVIDER; else process.env.AI_PROVIDER = origP;
    if (origK === undefined) delete process.env.AI_API_KEY; else process.env.AI_API_KEY = origK;
  }
});

test('parseModelResponse parses plain JSON and strips a markdown code fence', () => {
  const plain = parseModelResponse('{"summary":"ok","buying_signals":[]}');
  assert.equal(plain.summary, 'ok');
  const fenced = parseModelResponse('```json\n{"summary":"fenced"}\n```');
  assert.equal(fenced.summary, 'fenced');
});

test('parseModelResponse throws on non-JSON text (caller must handle, not swallow)', () => {
  assert.throws(() => parseModelResponse('this is not json'));
});
