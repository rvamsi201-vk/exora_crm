const crypto = require('crypto');

/**
 * A contact is suppressed for a channel if contacts.opted_out is true
 * (blocks everything) or a suppressions row exists for that channel or
 * for 'all'.
 */
async function isSuppressed(pool, { contact_id, channel }) {
  const { rows } = await pool.query(`SELECT opted_out FROM contacts WHERE id=$1`, [contact_id]);
  if (!rows.length) throw new Error('contact not found');
  if (rows[0].opted_out) return { suppressed: true, reason: 'contact opted out (all channels)' };

  const { rows: sup } = await pool.query(
    `SELECT * FROM suppressions WHERE contact_id=$1 AND channel IN ($2, 'all') LIMIT 1`,
    [contact_id, channel]
  );
  if (sup.length) return { suppressed: true, reason: sup[0].reason || `suppressed for ${sup[0].channel}` };
  return { suppressed: false, reason: null };
}

async function addSuppression(pool, { org_id, contact_id, channel, reason = null, source = 'manual', created_by = null }) {
  const { rows } = await pool.query(
    `INSERT INTO suppressions (id, org_id, contact_id, channel, reason, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (contact_id, channel) DO UPDATE SET reason=EXCLUDED.reason, source=EXCLUDED.source
     RETURNING *`,
    [crypto.randomUUID(), org_id, contact_id, channel, reason, source, created_by]
  );
  return rows[0];
}

async function removeSuppression(pool, { org_id, contact_id, channel }) {
  const { rows } = await pool.query(
    `DELETE FROM suppressions WHERE org_id=$1 AND contact_id=$2 AND channel=$3 RETURNING *`,
    [org_id, contact_id, channel]
  );
  return rows[0] || null;
}

module.exports = { isSuppressed, addSuppression, removeSuppression };
