const crypto = require('crypto');
const { isSuppressed } = require('./suppression');
const { recordActivity } = require('../crm/activity');
const email = require('./email');
const whatsapp = require('./whatsapp');

const ADAPTERS = { email, whatsapp };

/**
 * Suppression is checked before any adapter runs — a suppressed contact
 * never reaches send(), regardless of channel or environment.
 */
async function sendOutreach(pool, { org_id, contact_id, channel, subject = null, body, opportunity_id = null, sent_by = null }) {
  if (!ADAPTERS[channel]) throw new Error(`Unsupported channel: ${channel}`);
  if (!body) throw new Error('body is required');

  const { rows: contactRows } = await pool.query(`SELECT * FROM contacts WHERE id=$1 AND org_id=$2`, [contact_id, org_id]);
  const contact = contactRows[0];
  if (!contact) throw new Error('contact not found in this org');

  const insertMessage = async (fields) => {
    const { rows } = await pool.query(
      `INSERT INTO outreach_messages (id, org_id, contact_id, company_id, opportunity_id, channel, subject, body, status, provider, provider_message_id, error, sent_by, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        crypto.randomUUID(), org_id, contact_id, contact.company_id, opportunity_id, channel, subject, body,
        fields.status, fields.provider || null, fields.provider_message_id || null, fields.error || null, sent_by,
        ['sent', 'simulated', 'delivered'].includes(fields.status) ? new Date() : null,
      ]
    );
    return rows[0];
  };

  const suppression = await isSuppressed(pool, { contact_id, channel });
  if (suppression.suppressed) {
    const message = await insertMessage({ status: 'suppressed', error: suppression.reason });
    await recordActivity(pool, { org_id, actor_user_id: sent_by, type: `outreach_${channel}_suppressed`, company_id: contact.company_id, contact_id, opportunity_id, payload: { message_id: message.id, reason: suppression.reason } });
    return message;
  }

  const target = channel === 'email' ? contact.email : contact.phone;
  if (!target) {
    const message = await insertMessage({ status: 'failed', error: `contact has no ${channel === 'email' ? 'email' : 'phone'} on file` });
    return message;
  }

  let result;
  try {
    result = await ADAPTERS[channel].send(channel === 'email' ? { to: target, subject, body } : { to: target, body });
  } catch (err) {
    const message = await insertMessage({ status: 'failed', error: err.message });
    await recordActivity(pool, { org_id, actor_user_id: sent_by, type: `outreach_${channel}_failed`, company_id: contact.company_id, contact_id, opportunity_id, payload: { message_id: message.id, error: err.message } });
    return message;
  }

  const message = await insertMessage(result);
  await recordActivity(pool, { org_id, actor_user_id: sent_by, type: `outreach_${channel}_${result.status}`, company_id: contact.company_id, contact_id, opportunity_id, payload: { message_id: message.id } });
  return message;
}

module.exports = { sendOutreach, ADAPTERS };
