/**
 * Calling foundation: a zero-cost click-to-dial link always works with no
 * configuration. A real telephony provider (Twilio Voice, etc.) is future
 * work — CALLING_PROVIDER is checked here so that work has a clear slot,
 * but nothing is implemented yet, matching "add optional ... calling
 * adapters" without pretending a paid integration exists when it doesn't.
 */
function isConfigured() {
  return !!(process.env.CALLING_PROVIDER && process.env.CALLING_API_KEY);
}

function getCallLink(phone) {
  if (!phone) return null;
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

async function initiateCall({ to }) {
  if (process.env.NODE_ENV !== 'production' || !isConfigured()) {
    return { status: 'simulated', provider: null, call_link: getCallLink(to) };
  }
  throw new Error(`Unsupported CALLING_PROVIDER: ${process.env.CALLING_PROVIDER} (no provider implemented yet)`);
}

module.exports = { isConfigured, getCallLink, initiateCall };
