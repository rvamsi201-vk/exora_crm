const axios = require('axios');

function isConfigured() {
  return !!(process.env.EMAIL_PROVIDER && process.env.EMAIL_API_KEY && process.env.EMAIL_FROM);
}

async function sendViaSendgrid({ to, subject, body }) {
  const response = await axios.post(
    'https://api.sendgrid.com/v3/mail/send',
    {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: process.env.EMAIL_FROM },
      subject,
      content: [{ type: 'text/plain', value: body }],
    },
    { headers: { Authorization: `Bearer ${process.env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 }
  );
  return { provider: 'sendgrid', provider_message_id: response.headers['x-message-id'] || null };
}

/**
 * Never sends outside production — a stray API key in dev/test must never
 * cause a real send. In production, sends only when a provider is
 * actually configured; otherwise still returns 'simulated' rather than
 * throwing, so outreach flows keep working without email set up.
 */
async function send({ to, subject, body }) {
  if (process.env.NODE_ENV !== 'production' || !isConfigured()) {
    return { status: 'simulated', provider: null, provider_message_id: null };
  }
  const provider = process.env.EMAIL_PROVIDER;
  if (provider === 'sendgrid') {
    const result = await sendViaSendgrid({ to, subject, body });
    return { status: 'sent', ...result };
  }
  throw new Error(`Unsupported EMAIL_PROVIDER: ${provider}`);
}

module.exports = { isConfigured, send };
