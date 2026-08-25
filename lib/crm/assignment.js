/**
 * Load-balanced round-robin: assigns to whoever on the team currently has
 * the fewest open opportunities, tie-broken by team.id for determinism.
 * Deliberately load-based rather than a last-assigned cursor — a cursor
 * gets skewed the moment someone reassigns an opportunity by hand, while
 * this stays fair no matter how opportunities got where they are.
 */
async function pickAssignee(pool, { territory } = {}) {
  const params = [];
  let q = `
    SELECT t.id, COUNT(o.id) AS open_count
    FROM team t
    LEFT JOIN opportunities o
      ON o.owner_team_id = t.id AND o.stage NOT IN ('won', 'lost') AND o.deleted_at IS NULL
    WHERE 1=1`;
  if (territory) { params.push(territory); q += ` AND t.territory = $${params.length}`; }
  q += ` GROUP BY t.id ORDER BY open_count ASC, t.id ASC LIMIT 1`;
  const { rows } = await pool.query(q, params);
  return rows[0]?.id ?? null;
}

async function assignOpportunity(pool, { org_id, opportunity_id, team_id }) {
  const { rows } = await pool.query(
    `UPDATE opportunities SET owner_team_id=$1, assigned_at=NOW(), updated_at=NOW() WHERE id=$2 AND org_id=$3 RETURNING *`,
    [team_id, opportunity_id, org_id]
  );
  if (!rows.length) throw new Error('opportunity not found in this org');
  return rows[0];
}

module.exports = { pickAssignee, assignOpportunity };
