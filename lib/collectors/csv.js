const { emptyResult } = require('./base');

/**
 * Minimal RFC4180-ish CSV parser (quoted fields, embedded commas/newlines,
 * "" escaping) — hand-rolled to avoid adding a dependency for something
 * this small.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text).replace(/\r\n/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

const COLUMN_ALIASES = {
  name: ['name', 'company', 'company_name', 'school_name', 'business_name'],
  domain: ['domain', 'website', 'url'],
  address: ['address', 'address_line', 'location'],
  email: ['email', 'contact_email'],
  phone: ['phone', 'phone_number', 'contact_phone', 'mobile'],
};

function slug(s) {
  return s.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function findColumn(headers, aliases) {
  const slugged = headers.map(slug);
  for (const alias of aliases) {
    const idx = slugged.indexOf(slug(alias));
    if (idx !== -1) return idx;
  }
  return -1;
}

async function collect({ csv_text } = {}) {
  const result = emptyResult();
  if (!csv_text || !csv_text.trim()) {
    result.errors.push({ message: 'csv_text is empty' });
    return result;
  }

  const rows = parseCsv(csv_text);
  if (rows.length < 2) {
    result.errors.push({ message: 'csv has no data rows' });
    return result;
  }

  const headers = rows[0];
  const col = {
    name: findColumn(headers, COLUMN_ALIASES.name),
    domain: findColumn(headers, COLUMN_ALIASES.domain),
    address: findColumn(headers, COLUMN_ALIASES.address),
    email: findColumn(headers, COLUMN_ALIASES.email),
    phone: findColumn(headers, COLUMN_ALIASES.phone),
  };
  if (col.name === -1) {
    result.errors.push({ message: `no name/company column found in headers: ${headers.join(', ')}` });
    return result;
  }

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = (col.name !== -1 ? r[col.name] : '')?.trim();
    if (!name) {
      result.errors.push({ external_ref: `row_${i + 1}`, message: 'missing name/company value' });
      continue;
    }
    const domain = col.domain !== -1 ? (r[col.domain] || '').trim() || null : null;
    const address = col.address !== -1 ? (r[col.address] || '').trim() || null : null;
    const email = col.email !== -1 ? (r[col.email] || '').trim() || null : null;
    const phone = col.phone !== -1 ? (r[col.phone] || '').trim() || null : null;

    result.items.push({
      external_ref: `row_${i + 1}`,
      company: { name, domain },
      location: address ? { address_line: address } : null,
      contact: (email || phone) ? { email, phone } : null,
      raw: Object.fromEntries(headers.map((h, idx) => [h, r[idx] ?? null])),
    });
  }

  return result;
}

module.exports = { collect, parseCsv };
