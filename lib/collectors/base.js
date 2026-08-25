/**
 * Shared collector contract. Every connector in lib/collectors/ exports:
 *
 *   async function collect(params) -> {
 *     items: [{
 *       external_ref: string,        // stable id from the source, for provenance
 *       company: { name, domain?, industry? },
 *       location: { address_line?, city?, state?, postal_code?, country? } | null,
 *       contact: { name?, email?, phone? } | null,
 *       raw: object                  // the untouched source record, stored as-is
 *     }],
 *     errors: [{ external_ref?, message }]
 *   }
 *
 * Collectors never write to the database and never know about
 * organizations/campaigns/jobs — lib/jobs/worker.js does that. This keeps
 * core company/contact tables free of provider-specific fields: anything
 * connector-specific stays inside `raw`.
 */

function emptyResult() {
  return { items: [], errors: [] };
}

module.exports = { emptyResult };
