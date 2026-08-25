/**
 * lead-scraper.js
 * ─────────────────────────────────────────────────────────────
 * Fetches business listings from Serper API and saves leads to DB.
 * Calculates base_score (0-80) from rating, reviews, phone, website, address.
 *
 * Every successfully-collected, location-matched result is persisted
 * transactionally (per item, so one bad write can't roll back the rest of
 * the batch) into both the legacy `leads` table (what the dashboard reads)
 * and the newer schema — company, company_location, source_record,
 * opportunity, legacy_lead_links — following the same bridging pattern
 * scripts/backfill-legacy-leads.js already uses in the reverse direction.
 * The whole call is tracked as one discovery_campaigns + campaign_runs
 * pair, which always resolves to a terminal status (completed /
 * completed_with_errors / failed), never left in pending/running.
 */

const { loadEnv, assertNotRemoteDatabase } = require('./lib/env-guard');
loadEnv();
assertNotRemoteDatabase(process.env.DATABASE_URL);

const crypto = require('crypto');
const axios = require('axios');
const { Pool } = require('pg');
const { combineQueryWithLocation, normalizeLocation, locationMatches } = require('./lib/normalize');
const { findOrCreateCompany, addLocationIfMissing } = require('./lib/companies');

const DEFAULT_ORG_ID = '00000000-0000-0000-0000-000000000001';

const sslMode = (process.env.DATABASE_SSL_MODE || 'require').toLowerCase();
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslMode === 'disable' ? false : { rejectUnauthorized: sslMode === 'verify-full' }
});

// ── BASE SCORE CALCULATOR ─────────────────────────────────────
function calcBaseScore({ rating, reviews, phone, website, address }) {
    let score = 0;

    const r = parseFloat(rating) || 0;
    if (r >= 4.5) score += 25;
    else if (r >= 4.0) score += 20;
    else if (r >= 3.5) score += 14;
    else if (r >= 3.0) score += 8;
    else if (r > 0) score += 4;

    const rv = parseInt(reviews) || 0;
    if (rv >= 200) score += 20;
    else if (rv >= 100) score += 16;
    else if (rv >= 50) score += 12;
    else if (rv >= 20) score += 8;
    else if (rv >= 5) score += 4;

    if (phone) score += 10;
    if (website) score += 15;
    if (address) score += 10;

    return Math.min(score, 80);
}

// ── PHONE CLEANER ─────────────────────────────────────────────
function cleanPhone(raw) {
    if (!raw) return '';
    let s = String(raw).trim();
    // Remove leading single quote (from Excel imports)
    s = s.replace(/^[']+/, '').trim();
    // Filter out literal garbage strings
    if (/^(undefined|null|none|nan|#ERROR!|#N\/A|#VALUE!|#REF!|#NAME\?|#DIV\/0!|#NULL!)$/i.test(s)) return '';
    return s;
}

function cleanWebsite(raw) {
    if (!raw) return '';
    let url = String(raw).trim().replace(/^['"\s]+|['"\s]+$/g, '');
    if (!url) return '';
    if (!url.startsWith('http') && !url.startsWith('//')) {
        url = 'https://' + url;
    }
    return url;
}

// ── PERSIST A BATCH OF ALREADY-FETCHED PLACES ──────────────────
// Split out from scrapeAndSave so it can be exercised directly with mocked
// place objects (no live Serper call) — see test/lead-scraper.integration.test.js.
async function saveScrapedPlaces(places, { query, domain, location = {}, org_id = DEFAULT_ORG_ID, campaignId = null, runId = null, pool: dbPool = pool } = {}) {
    const saved = [], skipped = [], errors = [], rejected = [];
    const normalizedLocation = normalizeLocation(location);

    const recordSourceError = async (place, reason) => {
        try {
            await dbPool.query(
                `INSERT INTO source_records (id, org_id, campaign_id, run_id, source_type, external_ref, raw_payload, status, error)
                 VALUES ($1,$2,$3,$4,'serper',$5,$6,'error',$7)`,
                [crypto.randomUUID(), org_id, campaignId, runId, place?.placeId || place?.title || null, JSON.stringify(place || {}), reason]
            );
        } catch { /* best-effort provenance row; never let logging failure mask the real result */ }
    };

    for (const place of places || []) {
        const name = place.title || place.name || null;
        if (!name) {
            errors.push({ error: 'malformed result: missing title/name' });
            console.error(`   ❌ Malformed result: missing title/name`);
            await recordSourceError(place, 'malformed result: missing title/name');
            continue;
        }

        const { matches, reason } = locationMatches(place.address, location);
        if (!matches) {
            rejected.push({ name, reason });
            console.log(`   🚫 Rejected (location mismatch): ${name} — ${reason}`);
            await recordSourceError(place, `location mismatch: ${reason}`);
            continue;
        }

        const client = await dbPool.connect();
        try {
            await client.query('BEGIN');

            const phone = cleanPhone(place.phoneNumber || place.phone || '');
            const website = cleanWebsite(place.website || '');
            const address = place.address || '';
            const rating = place.rating ? String(place.rating) : null;
            const reviews = (place.reviews || place.reviewsCount) ? parseInt(place.reviews || place.reviewsCount) : null;
            const baseScore = calcBaseScore({ rating, reviews, phone, website, address });

            const { company } = await findOrCreateCompany(client, { org_id, name, domain: website || null });
            if (address) {
                await addLocationIfMissing(client, {
                    org_id, company_id: company.id, address_line: address,
                    city: location.city, area: location.area, state: location.state, country: location.country,
                });
            }

            const leadResult = await client.query(
                `INSERT INTO leads
                   (school_name, address, phone, website, rating, reviews, base_score, score, source, status, search_query, domain, city, area, state, country, normalized_location, org_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'serper','new',$9,$10,$11,$12,$13,$14,$15,$16)
                 ON CONFLICT DO NOTHING
                 RETURNING *`,
                [name, address, phone, website, rating, reviews, baseScore, baseScore, query, domain,
                    location.city || null, location.area || null, location.state || null, location.country || null, normalizedLocation, org_id]
            );

            if (leadResult.rows.length) {
                const lead = leadResult.rows[0];
                const sourceRecordId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO source_records (id, org_id, campaign_id, run_id, source_type, external_ref, raw_payload, company_id, legacy_lead_id, status)
                     VALUES ($1,$2,$3,$4,'serper',$5,$6,$7,$8,'collected')`,
                    [sourceRecordId, org_id, campaignId, runId, place.placeId || name, JSON.stringify(place), company.id, lead.id]
                );

                const opportunityId = crypto.randomUUID();
                await client.query(
                    `INSERT INTO opportunities (id, org_id, company_id, legacy_lead_id, name, stage, deal_value, campaign_id)
                     VALUES ($1,$2,$3,$4,$5,'new',0,$6)`,
                    [opportunityId, org_id, company.id, lead.id, name, campaignId]
                );

                await client.query(
                    `INSERT INTO legacy_lead_links (id, legacy_lead_id, org_id, company_id, opportunity_id, source_record_id)
                     VALUES ($1,$2,$3,$4,$5,$6)`,
                    [crypto.randomUUID(), lead.id, org_id, company.id, opportunityId, sourceRecordId]
                );

                await client.query('COMMIT');
                saved.push(lead);
                console.log(`   ✅ Saved: ${name} (base_score: ${baseScore})`);
            } else {
                await client.query('COMMIT');
                skipped.push(name);
                console.log(`   ⏭️  Skipped (duplicate): ${name}`);
            }
        } catch (err) {
            await client.query('ROLLBACK');
            errors.push({ name, error: err.message });
            console.error(`   ❌ Error saving ${name}:`, err.message);
            await recordSourceError(place, err.message);
        } finally {
            client.release();
        }
    }

    return { saved, skipped, errors, rejected };
}

// ── SCRAPE & SAVE ─────────────────────────────────────────────
async function scrapeAndSave(query = 'preschools in Bengaluru', domain = 'school', location = {}, org_id = DEFAULT_ORG_ID) {
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) throw new Error('SERPER_API_KEY not set in .env');

    // `query` is preserved as-is for `search_query`/provenance below; only
    // the text actually sent to Serper gets the location folded in. When
    // no city/area/state/country is supplied this is identical to `query`,
    // so existing searches behave exactly as before.
    const searchText = combineQueryWithLocation(query, location);
    const normalizedLocation = normalizeLocation(location);
    console.log(`\n🔍 Searching Serper for: "${searchText}"`);

    const campaignId = crypto.randomUUID();
    const runId = crypto.randomUUID();

    try {
        await pool.query(
            `INSERT INTO discovery_campaigns (id, org_id, name, query, source_type, city, area, state, country, normalized_location, status)
             VALUES ($1,$2,$3,$4,'serper',$5,$6,$7,$8,$9,'active')`,
            [campaignId, org_id, searchText, query,
                location.city || null, location.area || null, location.state || null, location.country || null, normalizedLocation]
        );
        await pool.query(`INSERT INTO campaign_runs (id, org_id, campaign_id, status) VALUES ($1,$2,$3,'pending')`, [runId, org_id, campaignId]);
        await pool.query(`UPDATE campaign_runs SET status='running', started_at=NOW() WHERE id=$1`, [runId]);

        const response = await axios.post(
            'https://google.serper.dev/maps',
            { q: searchText, num: 20 },
            { headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' }, timeout: 20000 }
        );

        const places = response.data?.places || [];
        console.log(`   Found ${places.length} results`);

        const result = await saveScrapedPlaces(places, { query, domain, location, org_id, campaignId, runId, pool });

        const totalErrors = result.errors.length + result.rejected.length;
        const runStatus = totalErrors === 0 ? 'completed' : (result.saved.length > 0 ? 'completed_with_errors' : 'failed');
        await pool.query(
            `UPDATE campaign_runs SET status=$2, stats=$3, finished_at=NOW() WHERE id=$1`,
            [runId, runStatus, JSON.stringify({
                found: places.length, saved: result.saved.length, skipped: result.skipped.length,
                rejected: result.rejected.length, errors: result.errors.length,
            })]
        );

        console.log(`\n📋 Scrape done: ${result.saved.length} saved, ${result.skipped.length} skipped, ${result.rejected.length} rejected (location), ${result.errors.length} errors`);
        return { ...result, campaign_id: campaignId, run_id: runId };
    } catch (err) {
        console.error('   ❌ Scrape failed:', err.message);
        await pool.query(
            `UPDATE campaign_runs SET status='failed', error=$2, finished_at=NOW() WHERE id=$1`,
            [runId, err.message]
        ).catch(() => { /* best-effort: the run row may not exist yet if the very first insert above failed */ });
        throw err;
    }
}

module.exports = { scrapeAndSave, saveScrapedPlaces, calcBaseScore, cleanPhone };
