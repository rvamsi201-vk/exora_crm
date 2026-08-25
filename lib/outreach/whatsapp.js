const axios = require('axios');

function isConfigured() {
  return !!(process.env.WHATSAPP_PROVIDER && process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

async function sendViaMetaCloudApi({ to, body }) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const response = await axios.post(
    `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body } },
    { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` }, timeout: 20000 }
  );
  return { provider: 'meta_cloud_api', provider_message_id: response.data?.messages?.[0]?.id || null };
}

// Same production-only, never-throws-when-unconfigured behavior as
// lib/outreach/email.js — see its comment.
async function send({ to, body }) {
  if (process.env.NODE_ENV !== 'production' || !isConfigured()) {
    return { status: 'simulated', provider: null, provider_message_id: null };
  }
  const provider = process.env.WHATSAPP_PROVIDER;
  if (provider === 'meta_cloud_api') {
    const result = await sendViaMetaCloudApi({ to, body });
    return { status: 'sent', ...result };
  }
  throw new Error(`Unsupported WHATSAPP_PROVIDER: ${provider}`);
}

module.exports = { isConfigured, send };
