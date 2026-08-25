/**
 * Tech-gap signatures for the new company-scoring model. Ported from the
 * detection rules proven out in lead-scorer.js's GAP_DEFINITIONS (the
 * legacy `leads` scorer keeps its own independent copy and is untouched
 * by this file) — same signal source, applied to the new companies model.
 */
const GAP_DEFINITIONS = [
  { key: 'crm', label: 'CRM / Lead Management', boost: 10,
    techSigs: ['leadsquared.com', 'hubspot.com', 'salesforce.com', 'zoho.com', 'nopaperforms', 'meritto.com', 'leadform', 'forms.gle'],
    keywords: ['crm login', 'enquiry portal', 'appointment booking', 'book now', 'online booking'] },
  { key: 'lms', label: 'Staff Training / LMS Portal', boost: 10,
    techSigs: ['moodle', 'canvas', 'blackboard', 'teachable', 'learnpress', 'tutorlms'],
    keywords: ['student portal', 'lms login'] },
  { key: 'payment', label: 'Online Digital Payments', boost: 10,
    techSigs: ['razorpay.com', 'stripe.com', 'paytm.in', 'payu.in', 'instamojo.com', 'ccavenue.com', 'cashfree.com'],
    keywords: ['pay fee online', 'online fee portal'] },
  { key: 'admission', label: 'Digital Registration / Intake', boost: 8,
    techSigs: ['admission.nopaperforms', 'apply.meritto'],
    keywords: ['apply online', 'online admission portal', 'registration form', 'book appointment'] },
  { key: 'app', label: 'Mobile App / Client Portal', boost: 7,
    techSigs: ['play.google.com/store/apps', 'apps.apple.com'],
    keywords: ['download our app', 'parent portal'] },
  { key: 'attendance', label: 'Workforce ERP / Attendance', boost: 7,
    techSigs: ['fedena', 'edunext', 'entab', 'myclassboard', 'schoolpad', 'edadmin'],
    keywords: ['erp login', 'staff login', 'employee portal', 'hrms login'] },
  { key: 'chatbot', label: 'WhatsApp / AI Chatbot', boost: 5,
    techSigs: ['tawk.to', 'tidio.co', 'zendesk.com', 'intercom.io', 'freshchat.com', 'drift.com', 'crisp.chat', 'whatsapp.com/send', 'wa.me'],
    keywords: [] },
  { key: 'ssl', label: 'Secure Website (HTTPS)', boost: 5, techSigs: [], keywords: [] },
];

const MAX_BOOST = GAP_DEFINITIONS.reduce((sum, g) => sum + g.boost, 0);

/**
 * Detects gaps from raw homepage HTML (from lib/enrichment/website.js's
 * crawlWebsite `home_html`) plus whether the site is missing/unreachable.
 * websiteStatus: 'live' | 'broken' | 'missing'.
 */
function detectGaps(html, websiteStatus, hasHttps) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html || '');
  const srcs = [];
  $('[src]').each((_, el) => srcs.push($(el).attr('src')));
  $('[href]').each((_, el) => srcs.push($(el).attr('href')));
  const techString = srcs.filter(Boolean).join(' ').toLowerCase();
  const bodyText = $('body').text().toLowerCase();
  const rawHtml = (html || '').toLowerCase();

  const found = [];
  for (const gap of GAP_DEFINITIONS) {
    if (gap.key === 'ssl') {
      if (!hasHttps || websiteStatus === 'missing') found.push(gap);
      continue;
    }
    if (websiteStatus !== 'live') { found.push(gap); continue; }

    const hasTechSig = gap.techSigs.some((sig) => techString.includes(sig) || rawHtml.includes(sig));
    const hasKeyword = gap.keywords.some((kw) => bodyText.includes(kw));
    if (!hasTechSig && !hasKeyword) found.push(gap);
  }
  return found;
}

module.exports = { GAP_DEFINITIONS, MAX_BOOST, detectGaps };
