const crypto = require('crypto');
const { emptyResult } = require('./base');

/**
 * Manual entry: a single record supplied directly through the API,
 * wrapped in the same shape as every other collector so it goes through
 * the same provenance/company-matching pipeline.
 */
async function collect({ name, domain, address, email, phone } = {}) {
  const result = emptyResult();
  if (!name || !name.trim()) {
    result.errors.push({ message: 'name is required' });
    return result;
  }

  result.items.push({
    external_ref: `manual_${crypto.randomUUID()}`,
    company: { name: name.trim(), domain: domain || null },
    location: address ? { address_line: address } : null,
    contact: (email || phone) ? { email: email || null, phone: phone || null } : null,
    raw: { name, domain, address, email, phone },
  });

  return result;
}

module.exports = { collect };
