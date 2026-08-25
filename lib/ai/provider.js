/**
 * Provider-agnostic AI adapter, off by default. Nothing in this repo calls
 * an AI API unless AI_PROVIDER and AI_API_KEY are both set — see
 * .env.example. Add another provider by adding a branch to `generate`;
 * callers never need to know which one is configured.
 */
const axios = require('axios');

function isConfigured() {
  return !!(process.env.AI_PROVIDER && process.env.AI_API_KEY);
}

async function generateAnthropic({ system, prompt }) {
  const model = process.env.AI_MODEL || 'claude-3-5-haiku-latest';
  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model, max_tokens: 1500, system, messages: [{ role: 'user', content: prompt }] },
    {
      headers: {
        'x-api-key': process.env.AI_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30000,
    }
  );
  const text = (response.data?.content || []).map((c) => c.text || '').join('');
  return { text, model, provider: 'anthropic' };
}

async function generate({ system, prompt }) {
  if (!isConfigured()) throw new Error('AI provider not configured (set AI_PROVIDER and AI_API_KEY)');
  const provider = process.env.AI_PROVIDER;
  if (provider === 'anthropic') return generateAnthropic({ system, prompt });
  throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
}

module.exports = { isConfigured, generate };
