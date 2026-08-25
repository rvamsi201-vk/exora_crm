const crypto = require('crypto');
const { getCollector } = require('../collectors');
const { findOrCreateCompany, addLocationIfMissing, findOrCreateContact } = require('../companies');
const { claimNextJob, completeJob, failJob } = require('./queue');
const { enrichCompany } = require('../enrichment/company');
const { scanForDuplicates } = require('../dedup/scan');
const { computeCompanyScore } = require('../scoring/company');
const { researchCompany } = require('../ai/research');
const { sendOutreach } = require('../outreach/send');

// Job types that aren't collectors (no items/errors, no campaign_runs row).
const TASK_HANDLERS = {
  enrich_company: (pool, job) => enrichCompany(pool, { org_id: job.org_id, ...job.payload }),
  dedup_scan: (pool, job) => scanForDuplicates(pool, { org_id: job.org_id }),
  score_company: (pool, job) => computeCompanyScore(pool, { org_id: job.org_id, ...job.payload }),
  ai_research: (pool, job) => researchCompany(pool, { org_id: job.org_id, ...job.payload }),
  send_outreach: (pool, job) => sendOutreach(pool, { org_id: job.org_id, ...job.payload }),
};

// Each item is persisted in its own transaction so one bad DB write can't
// roll back the rest of the batch — a run that finds 20 items and fails to
// save 1 should still end with 19 saved, not 0.
async function processItems(pool, { org_id, campaign_id, run_id, source_type, items, errors }) {
  const stats = { found: items.length, saved: 0, companies_created: 0, companies_reused: 0, contacts_created: 0, errors: errors.length };

  for (const item of items) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { company, created } = await findOrCreateCompany(client, {
        org_id, name: item.company.name, domain: item.company.domain,
      });
      if (created) stats.companies_created += 1; else stats.companies_reused += 1;

      if (item.location?.address_line) {
        await addLocationIfMissing(client, { org_id, company_id: company.id, ...item.location });
      }

      let contact = null;
      if (item.contact?.email || item.contact?.phone) {
        contact = await findOrCreateContact(client, {
          org_id, company_id: company.id, name: item.contact.name, email: item.contact.email, phone: item.contact.phone,
        });
        if (contact) stats.contacts_created += 1;
      }

      await client.query(
        `INSERT INTO source_records (id, org_id, campaign_id, run_id, source_type, external_ref, raw_payload, company_id, contact_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'collected')`,
        [crypto.randomUUID(), org_id, campaign_id, run_id, source_type, item.external_ref, JSON.stringify(item.raw || {}), company.id, contact?.id || null]
      );

      await client.query('COMMIT');
      stats.saved += 1;
    } catch (err) {
      await client.query('ROLLBACK');
      stats.errors += 1;
      await client.query(
        `INSERT INTO source_records (id, org_id, campaign_id, run_id, source_type, external_ref, raw_payload, status, error)
         VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,'error',$7)`,
        [crypto.randomUUID(), org_id, campaign_id, run_id, source_type, item.external_ref || null, err.message]
      );
    } finally {
      client.release();
    }
  }

  for (const err of errors) {
    await pool.query(
      `INSERT INTO source_records (id, org_id, campaign_id, run_id, source_type, external_ref, raw_payload, status, error)
       VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb,'error',$7)`,
      [crypto.randomUUID(), org_id, campaign_id, run_id, source_type, err.external_ref || null, err.message]
    );
  }

  return stats;
}

async function runCollectorJob(pool, job) {
  try {
    const collector = getCollector(job.type);
    if (job.run_id) {
      await pool.query(
        `UPDATE campaign_runs SET status='running', started_at=COALESCE(started_at, NOW()) WHERE id=$1`,
        [job.run_id]
      );
    }

    const { items, errors } = await collector.collect(job.payload || {});

    const stats = await processItems(pool, {
      org_id: job.org_id, campaign_id: job.campaign_id, run_id: job.run_id,
      source_type: job.type, items, errors,
    });

    if (job.run_id) {
      const runStatus = stats.errors === 0 ? 'completed' : (stats.saved > 0 ? 'completed_with_errors' : 'failed');
      await pool.query(
        `UPDATE campaign_runs SET status=$2, stats=$3, finished_at=NOW() WHERE id=$1`,
        [job.run_id, runStatus, JSON.stringify(stats)]
      );
    }
    await completeJob(pool, job.id, stats);
  } catch (err) {
    if (job.run_id) {
      await pool.query(
        `UPDATE campaign_runs SET status='failed', error=$2, finished_at=NOW() WHERE id=$1`,
        [job.run_id, err.message]
      );
    }
    await failJob(pool, job, err);
  }
}

async function runTaskJob(pool, job) {
  try {
    const result = await TASK_HANDLERS[job.type](pool, job);
    await completeJob(pool, job.id, result);
  } catch (err) {
    await failJob(pool, job, err);
  }
}

async function runJob(pool, job) {
  if (TASK_HANDLERS[job.type]) return runTaskJob(pool, job);
  return runCollectorJob(pool, job);
}

function startWorker(pool, { intervalMs = 5000 } = {}) {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      let job;
      while ((job = await claimNextJob(pool))) {
        await runJob(pool, job);
      }
    } catch (err) {
      console.error('❌ Job worker tick error:', err.message);
    } finally {
      running = false;
    }
  };

  const handle = setInterval(tick, intervalMs);
  tick();

  return { stop: () => { stopped = true; clearInterval(handle); } };
}

module.exports = { startWorker, runJob, processItems };
