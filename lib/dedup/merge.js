const crypto = require('crypto');

class AlreadyMergedError extends Error {}

async function repointTagsAndDelete(client, { entity_type, winner_id, loser_id }) {
  const { rows: loserTags } = await client.query(
    `SELECT id, tag_id FROM entity_tags WHERE entity_type=$1 AND entity_id=$2`,
    [entity_type, loser_id]
  );
  for (const tag of loserTags) {
    const { rows: existing } = await client.query(
      `SELECT id FROM entity_tags WHERE entity_type=$1 AND entity_id=$2 AND tag_id=$3`,
      [entity_type, winner_id, tag.tag_id]
    );
    if (existing.length) {
      await client.query(`DELETE FROM entity_tags WHERE id=$1`, [tag.id]);
    } else {
      await client.query(`UPDATE entity_tags SET entity_id=$1 WHERE id=$2`, [winner_id, tag.id]);
    }
  }
}

async function mergeCompanies(pool, { org_id, winner_id, loser_id, confidence = null, reasons = [], merged_by = null, auto = false }) {
  if (winner_id === loser_id) throw new Error('winner_id and loser_id must differ');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM companies WHERE id = ANY($1::uuid[]) AND org_id=$2 FOR UPDATE`,
      [[winner_id, loser_id], org_id]
    );
    const winner = rows.find((r) => r.id === winner_id);
    const loser = rows.find((r) => r.id === loser_id);
    if (!winner || !loser) throw new Error('winner or loser company not found in this org');
    if (winner.deleted_at || winner.merged_into || loser.deleted_at || loser.merged_into) {
      throw new AlreadyMergedError('one of these companies has already been merged');
    }

    const merged = {
      domain: winner.domain || loser.domain,
      normalized_domain: winner.normalized_domain || loser.normalized_domain,
      industry: winner.industry || loser.industry,
      size_bucket: winner.size_bucket || loser.size_bucket,
      description: winner.description || loser.description,
      metadata: { ...(loser.metadata || {}), ...(winner.metadata || {}) },
    };
    await client.query(
      `UPDATE companies SET domain=$1, normalized_domain=$2, industry=$3, size_bucket=$4, description=$5, metadata=$6, updated_at=NOW() WHERE id=$7`,
      [merged.domain, merged.normalized_domain, merged.industry, merged.size_bucket, merged.description, JSON.stringify(merged.metadata), winner_id]
    );

    // Locations: drop exact-duplicate addresses, repoint the rest.
    const { rows: winnerLocations } = await client.query(
      `SELECT address_line FROM company_locations WHERE company_id=$1 AND deleted_at IS NULL`,
      [winner_id]
    );
    const winnerAddresses = new Set(winnerLocations.map((l) => l.address_line));
    const { rows: loserLocations } = await client.query(
      `SELECT id, address_line FROM company_locations WHERE company_id=$1 AND deleted_at IS NULL`,
      [loser_id]
    );
    for (const loc of loserLocations) {
      if (winnerAddresses.has(loc.address_line)) {
        await client.query(`UPDATE company_locations SET deleted_at=NOW() WHERE id=$1`, [loc.id]);
      } else {
        await client.query(`UPDATE company_locations SET company_id=$1, is_primary=false WHERE id=$2`, [winner_id, loc.id]);
      }
    }

    await client.query(`UPDATE contacts SET company_id=$1 WHERE company_id=$2`, [winner_id, loser_id]);
    await client.query(`UPDATE opportunities SET company_id=$1 WHERE company_id=$2`, [winner_id, loser_id]);
    await client.query(`UPDATE source_records SET company_id=$1 WHERE company_id=$2`, [winner_id, loser_id]);
    await client.query(`UPDATE activities SET company_id=$1 WHERE company_id=$2`, [winner_id, loser_id]);
    await repointTagsAndDelete(client, { entity_type: 'company', winner_id, loser_id });

    await client.query(`UPDATE companies SET deleted_at=NOW(), merged_into=$1 WHERE id=$2`, [winner_id, loser_id]);

    await client.query(
      `INSERT INTO entity_merges (id, org_id, entity_type, winner_id, loser_id, confidence, reasons, auto, merged_by)
       VALUES ($1,$2,'company',$3,$4,$5,$6,$7,$8)`,
      [crypto.randomUUID(), org_id, winner_id, loser_id, confidence, JSON.stringify(reasons), auto, merged_by]
    );

    await client.query('COMMIT');
    return { winner_id, loser_id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function mergeContacts(pool, { org_id, winner_id, loser_id, confidence = null, reasons = [], merged_by = null, auto = false }) {
  if (winner_id === loser_id) throw new Error('winner_id and loser_id must differ');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM contacts WHERE id = ANY($1::uuid[]) AND org_id=$2 FOR UPDATE`,
      [[winner_id, loser_id], org_id]
    );
    const winner = rows.find((r) => r.id === winner_id);
    const loser = rows.find((r) => r.id === loser_id);
    if (!winner || !loser) throw new Error('winner or loser contact not found in this org');
    if (winner.deleted_at || winner.merged_into || loser.deleted_at || loser.merged_into) {
      throw new AlreadyMergedError('one of these contacts has already been merged');
    }

    const merged = {
      name: winner.name || loser.name,
      title: winner.title || loser.title,
      email: winner.email || loser.email,
      normalized_email: winner.normalized_email || loser.normalized_email,
      phone: winner.phone || loser.phone,
      normalized_phone: winner.normalized_phone || loser.normalized_phone,
      email_verified: winner.email_verified || loser.email_verified,
      phone_verified: winner.phone_verified || loser.phone_verified,
      company_id: winner.company_id || loser.company_id,
      metadata: { ...(loser.metadata || {}), ...(winner.metadata || {}) },
    };
    await client.query(
      `UPDATE contacts SET name=$1, title=$2, email=$3, normalized_email=$4, phone=$5, normalized_phone=$6,
         email_verified=$7, phone_verified=$8, company_id=$9, metadata=$10, updated_at=NOW() WHERE id=$11`,
      [merged.name, merged.title, merged.email, merged.normalized_email, merged.phone, merged.normalized_phone,
        merged.email_verified, merged.phone_verified, merged.company_id, JSON.stringify(merged.metadata), winner_id]
    );

    await client.query(`UPDATE source_records SET contact_id=$1 WHERE contact_id=$2`, [winner_id, loser_id]);
    await client.query(`UPDATE activities SET contact_id=$1 WHERE contact_id=$2`, [winner_id, loser_id]);
    await repointTagsAndDelete(client, { entity_type: 'contact', winner_id, loser_id });

    await client.query(`UPDATE contacts SET deleted_at=NOW(), merged_into=$1 WHERE id=$2`, [winner_id, loser_id]);

    await client.query(
      `INSERT INTO entity_merges (id, org_id, entity_type, winner_id, loser_id, confidence, reasons, auto, merged_by)
       VALUES ($1,$2,'contact',$3,$4,$5,$6,$7,$8)`,
      [crypto.randomUUID(), org_id, winner_id, loser_id, confidence, JSON.stringify(reasons), auto, merged_by]
    );

    await client.query('COMMIT');
    return { winner_id, loser_id };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { mergeCompanies, mergeContacts, AlreadyMergedError };
