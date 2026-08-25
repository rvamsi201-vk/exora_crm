/**
 * lead-scorer.js
 * ─────────────────────────────────────────────────────────────
 * Steps:
 *   • Checks website status (live / broken / missing)
 *   • Scrapes HTML to detect missing tech via signatures & keywords
 *   • Calculates final score (base + gap boosts, capped at 100)
 *   • Generates priority + tailored Exora sales pitch
 *   • Updates DB with score, priority, pitch, gaps_found, website_status
 */

require('dotenv').config();
const axios = require('axios');
const cheerio = require('cheerio');
const { Pool } = require('pg');

const sslMode = (process.env.DATABASE_SSL_MODE || 'require').toLowerCase();
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: sslMode === 'disable' ? false : { rejectUnauthorized: sslMode === 'verify-full' }
});

// ── Load scoring config from DB ────────────────────────────
async function loadScoreConfig() {
    const { rows } = await pool.query('SELECT * FROM score_config ORDER BY sort_order ASC');
    return rows;
}

// ── EXORA SERVICE GAP DEFINITIONS ───────────────────────────
// ── EXORA SERVICE GAP DEFINITIONS ───────────────────────────
const GAP_DEFINITIONS = [
    {
        key: 'crm',
        label: 'CRM / Lead Management',
        pitch: 'No professional CRM or automated enquiry system detected. Exora CRM can automate {target} capture, follow-ups, and convert more {type}—without any manual effort.',
        pitches: {
            school: 'Managing parent enquiries in registers is outdated. Exora CRM automates admission follow-ups and captures leads from your website automatically.',
            hospital: 'Patient follow-ups are falling through the cracks. Exora CRM manages patient enquiries and treatment pipelines, ensuring better conversion and care.',
            gym: 'Potential members are walking away. Exora CRM tracks every walk-in and enquiry, sending automated WhatsApp follow-ups to boost memberships.',
            manufacturing: 'Manual deal tracking is slowing you down. Exora CRM digitises your entire B2B pipeline, ensuring no purchase order or enquiry is ever missed.',
            salon: 'Client retention is key. Exora CRM tracks visit history and automated follow-ups for your {target}, ensuring they return for their next {type}.'
        },
        techSigs: ['leadsquared.com', 'hubspot.com', 'salesforce.com', 'zoho.com', 'nopaperforms', 'extraedge', 'meritto.com', 'noesisenquiry', 'leadform', 'forms.gle', 'zenoti.com', 'mindbodyonline.com', 'booksy.com', 'fresha.com', 'treatwell.com', 'vagaro.com', 'shedul.com', 'phorest.com', 'gettimely.com', 'shortcuts.net'],
        keywords: ['crm login', 'enquiry portal', 'appointment booking', 'book now', 'online booking', 'salon login', 'stylist login', 'reserve a slot'],
        apiCats: ['crm', 'marketing-automation'],
        boost: 10
    },
    {
        key: 'lms',
        label: 'Staff Training / LMS Portal',
        pitch: 'No LMS or online training platform found. Exora LMS enables professional training, documentation, and quizzes for your team—all in one place.',
        pitches: {
            school: 'Empower your teachers with a modern LMS. Exora LMS hosts curriculum, lesson plans, and training modules for your academic staff.',
            manufacturing: 'Technical training is vital. Exora LMS digitises your standard operating procedures (SOPs) and safety training for factory workers.',
            hospital: 'Keep your clinical staff updated. Exora LMS manages medical training, protocols, and compliance certifications centrally.'
        },
        techSigs: ['moodle', 'canvas', 'blackboard', 'teachable', 'udemy', 'educomp', 'learnpress', 'tutorlms'],
        keywords: ['student portal', 'lms login'],
        apiCats: ['lms'],
        boost: 10
    },
    {
        key: 'payment',
        label: 'Online Digital Payments',
        pitch: 'No online payment gateway detected. Exora Payments allows {target} to pay safely via UPI, cards, or net banking—reducing manual collections by 80%.',
        pitches: {
            school: 'Fee collection is a manual hassle. Exora Payments enables auto-reminders and instant receipt generation for parents via UPI and cards.',
            gym: 'Membership renewals should be seamless. Exora Payments handles recurring billing and instant payment links for members.',
            salon: 'Secure your bookings with advance payments. Exora Payments allows clients to pay a deposit during online booking, reducing no-shows.',
            manufacturing: 'Digitise your accounts receivable. Exora Payments provides secure portals for your clients to pay invoices instantly, improving cash flow.'
        },
        techSigs: ['razorpay.com', 'stripe.com', 'paytm.in', 'payu.in', 'instamojo.com', 'ccavenue.com', 'cashfree.com', 'secure.pay'],
        keywords: ['pay fee online', 'online fee portal'],
        apiCats: ['payment-processors'],
        boost: 10
    },
    {
        key: 'admission',
        label: 'Digital Registration / Intake',
        pitch: 'No digital onboarding process found. Exora digitises the entire process—from application to document upload and fee payment, cutting paperwork completely.',
        pitches: {
            school: 'The admission season is overwhelming. Exora\'s Digital Admission Portal automates application forms, document uploads, and merit list processing.',
            salon: 'Manual phone bookings are inefficient. Exora\'s Digital Booking Portal lets your clients schedule appointments 24/7 without disturbing your stylists.',
            hospital: 'Reduce front-desk waiting times. Exora Digital Intake allows patients to pre-fill forms and upload medical history before they arrive.',
            gym: 'Simplify member sign-ups. Exora Digital Onboarding handles waivers, agreements, and profiles in a paperless 2-minute flow.'
        },
        techSigs: ['admission.nopaperforms', 'apply.meritto'],
        keywords: ['apply online', 'online admission portal', 'registration form', 'book appointment', 'become a member', 'new client form', 'patient portal'],
        apiCats: [],
        boost: 8
    },
    {
        key: 'app',
        label: 'Mobile App / Client Portal',
        pitch: 'No mobile app or {target} portal detected. Exora Client App keeps your {target} updated with schedules, invoices, and notices—boosting satisfaction.',
        pitches: {
            school: 'Parents want real-time updates. The Exora Parent App provides instant notifications on attendance, homework, and fee status.',
            gym: 'Engagement is key for retention. The Exora Member App keeps your {target} connected with workout plans, diet charts, and renewal alerts.',
            hospital: 'Patient care doesn\'t end at the clinic. The Exora Patient App digitises prescriptions, reports, and follow-up reminders for better recovery.'
        },
        techSigs: ['play.google.com/store/apps', 'apps.apple.com'],
        keywords: ['download our app', 'parent portal'],
        apiCats: [],
        boost: 7
    },
    {
        key: 'attendance',
        label: 'Workforce ERP / Attendance',
        pitch: 'No digital attendance or ERP system detected. Exora ERP lets you mark attendance digitally, auto-notifying stakeholders and generating compliance reports.',
        pitches: {
            school: 'Teacher and student attendance takes too much time. Exora ERP automates daily marking and sends instant "Absent" alerts to parents.',
            manufacturing: 'Workforce management is a bottleneck. Exora ERP handles shift rosters, attendance, and payroll for your entire factory floor.',
            hospital: 'Staff coordination is critical for care. Exora workforce portal tracks shifts, rosters, and attendance for nursing and clinical staff.'
        },
        techSigs: ['fedena', 'edunext', 'entab', 'myclassboard', 'schoolpad', 'edadmin'],
        keywords: ['erp login', 'school erp login', 'staff login', 'employee portal', 'hrms login', 'roster login'],
        apiCats: ['erp'],
        boost: 7
    },
    {
        key: 'chatbot',
        label: 'WhatsApp AI Chatbot',
        pitch: 'No live chat or WhatsApp integration found. Exora AI Chatbot handles queries 24/7 on WhatsApp and your website, converting visitors into leads automatically.',
        pitches: {
            school: 'Front-desk gets flooded with routine queries. Exora AI Chatbot handles admission FAQs and fee status on WhatsApp, 24/7.',
            hospital: 'Your staff is overwhelmed. Exora AI Chatbot handles patient appointments and routine queries on WhatsApp, freeing up your reception desk.',
            gym: 'Inbound queries often go un-replied. Exora AI Chatbot answers membership pricing and facilities queries instantly, driving more conversions.',
            restaurant: 'Customers want instant replies for table bookings. Exora AI Chatbot handles reservations and basic menu queries 24/7 on WhatsApp.'
        },
        techSigs: ['tawk.to', 'tidio.co', 'zendesk.com', 'intercom.io', 'freshchat.com', 'drift.com', 'crisp.chat', 'whatsapp.com/send', 'wa.me'],
        keywords: [],
        apiCats: ['live-chat'],
        boost: 5
    },
    {
        key: 'ssl',
        label: 'Secure Website (HTTPS)',
        pitch: 'Website is not secure (no HTTPS). Exora handles your HTTPS setup as part of the website package, building trust with visitors immediately.',
        techSigs: [],
        keywords: [],
        apiCats: [],
        boost: 5
    },
];

// ── FREE LOCAL DEEP SCANNER ───────────────────────────────
// Replaces expensive APIs by aggressively scanning for invisible tech signatures
function deepTechScan(html) {
    if (!html) return [];

    const $ = cheerio.load(html);
    const foundTechs = new Set();
    const rawHtml = html.toLowerCase();

    // 1. Scrape all domains from scripts, iframes, and links
    const externalDomains = [];
    $('script[src]').each((_, el) => externalDomains.push($(el).attr('src')));
    $('iframe[src]').each((_, el) => externalDomains.push($(el).attr('src')));
    $('link[href]').each((_, el) => externalDomains.push($(el).attr('href')));

    const domainString = externalDomains.filter(Boolean).map(d => d.toLowerCase()).join(' ');

    // 2. Map of signatures to categories
    const techSignatures = [
        { cat: 'crm', match: ['leadsquared', 'hubspot', 'salesforce', 'zoho', 'nopaperforms', 'meritto', 'leadform', 'extraedge', 'forms.gle'] },
        { cat: 'lms', match: ['moodle', 'canvas', 'learnpress', 'tutorlms', 'teachable', 'blackboard', 'educomp'] },
        { cat: 'payment-processors', match: ['razorpay', 'stripe', 'paytm', 'payu', 'instamojo', 'ccavenue', 'cashfree', 'billdesk'] },
        { cat: 'erp', match: ['fedena', 'edunext', 'entab', 'myclassboard', 'schoolpad', 'edadmin'] },
        { cat: 'live-chat', match: ['tawk.to', 'tidio', 'zendesk', 'intercom', 'freshchat', 'drift', 'crisp', 'whatsapp.com/send', 'wa.me'] }
    ];

    // 3. Hunt through both the visible domains AND the invisible raw HTML
    for (const tech of techSignatures) {
        for (const signature of tech.match) {
            // Uncover hidden scripts embedded directly into the HTML body that cheerio wouldn't extract as an external source
            if (domainString.includes(signature) || rawHtml.includes(signature)) {
                foundTechs.add(tech.cat);
                break; // Found one tool in this category, move to next category
            }
        }
    }

    return Array.from(foundTechs);
}

// ── WEBSITE STATUS CHECK ─────────────────────────────────────
async function checkWebsiteStatus(url) {
    if (!url || url.trim() === '') {
        return { status: 'missing', html: '', isHttps: false };
    }

    let normalised = url.trim();
    if (!/^https?:\/\//i.test(normalised)) normalised = 'https://' + normalised;
    const isHttps = normalised.startsWith('https://');

    try {
        const response = await axios.get(normalised, {
            timeout: 10000,
            maxRedirects: 5,
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ExoraBot/1.0; +https://exora.solutions)' },
            validateStatus: (s) => s < 500,
        });

        if (response.status >= 400) {
            return { status: 'broken', html: '', isHttps, httpStatus: response.status };
        }

        // Check if redirected to HTTPS
        let finalIsHttps = isHttps;
        if (response.request && response.request.res && response.request.res.responseUrl) {
            finalIsHttps = response.request.res.responseUrl.startsWith('https://');
        }

        return { status: 'live', html: response.data || '', isHttps: finalIsHttps, httpStatus: response.status };
    } catch (err) {
        console.log(`   ⚠️  Website unreachable: ${url} — ${err.message}`);
        return { status: 'broken', html: '', isHttps, error: err.message };
    }
}

// ── GAP DETECTOR ─────────────────────────────────────────────
function detectGaps(html, websiteStatus, isHttps, wappalyzerData = []) {
    const foundGaps = [];
    const $ = cheerio.load(html || '');

    // Extract all URLs from scripts, iframes, forms, links
    const srcs = [];
    $('[src]').each((_, el) => srcs.push($(el).attr('src')));
    $('[href]').each((_, el) => srcs.push($(el).attr('href')));
    $('[action]').each((_, el) => srcs.push($(el).attr('action')));

    const techString = srcs.filter(Boolean).join(' ').toLowerCase();
    const bodyText = $('body').text().toLowerCase();

    for (const gap of GAP_DEFINITIONS) {
        if (gap.key === 'ssl') {
            if (!isHttps || websiteStatus === 'missing') foundGaps.push(gap);
            continue;
        }

        if (websiteStatus !== 'live') {
            foundGaps.push(gap); // All gaps apply if site is broken/missing
            continue;
        }

        const hasTechSig = gap.techSigs && gap.techSigs.some((sig) => techString.includes(sig));
        const hasKeyword = gap.keywords && gap.keywords.some((kw) => bodyText.includes(kw));

        // Deep Tech API Scan Match
        let hasApiMatch = false;
        if (gap.apiCats && wappalyzerData.length > 0) {
            hasApiMatch = gap.apiCats.some(cat => wappalyzerData.includes(cat));
        }

        if (!hasTechSig && !hasKeyword && !hasApiMatch) {
            foundGaps.push(gap);
        }
    }

    return foundGaps;
}

// ── FINAL SCORE CALCULATOR ───────────────────────────────────
function calcFinalScore(baseScore, gaps) {
    let boost = 0;
    for (const gap of gaps) boost += gap.boost;
    return Math.min(baseScore + boost, 100);
}

// ── PRIORITY CLASSIFIER ──────────────────────────────────────
function classifyPriority(finalScore, gapCount) {
    if (finalScore >= 75 || gapCount >= 5) return '🔥 high';
    if (finalScore >= 50 || gapCount >= 3) return '⚡ medium';
    return '📋 low';
}

// ── PITCH GENERATOR ──────────────────────────────────────────
// ── SECTOR INTELLIGENCE PROFILES ─────────────────────────────
// Defines which services are most critical for specific industries
const SECTOR_PROFILES = {
    school: { priority: ['lms', 'admission', 'payment', 'crm', 'attendance'], labels: { lms: 'LMS / Student Portal', admission: 'Online Admissions', payment: 'Fee Payment' } },
    college: { priority: ['lms', 'admission', 'payment', 'crm'], labels: { lms: 'LMS / Student Portal', admission: 'Online Admissions' } },
    gym: { priority: ['app', 'payment', 'crm', 'chatbot'], labels: { app: 'Member App', crm: 'Member Management', payment: 'Membership Fees' } },
    fitness: { priority: ['app', 'payment', 'crm', 'chatbot'], labels: { app: 'Client App', payment: 'Recurring Payments' } },
    hospital: { priority: ['chatbot', 'crm', 'app', 'payment', 'ssl'], labels: { chatbot: 'Patient AI Assistant', app: 'Patient Portal', crm: 'Clinic Management' } },
    clinic: { priority: ['chatbot', 'crm', 'app', 'payment'], labels: { chatbot: 'Patient AI Assistant', crm: 'Clinic Management' } },
    manufacturing: { priority: ['attendance', 'crm', 'chatbot', 'ssl'], labels: { attendance: 'Workforce ERP', crm: 'Deal Tracker' } },
    factory: { priority: ['attendance', 'crm', 'ssl'], labels: { attendance: 'Workforce ERP' } },
    salon: { priority: ['admission', 'chatbot', 'payment', 'crm'], labels: { admission: 'Online Booking', crm: 'Appointment Manager' } },
    spa: { priority: ['admission', 'chatbot', 'payment', 'crm'], labels: { admission: 'Online Booking' } },
    auditing: { priority: ['crm', 'chatbot', 'ssl', 'payment'], labels: { crm: 'Client Pipeline', chatbot: 'Auto-Responder' } },
    restaurant: { priority: ['chatbot', 'payment', 'app', 'crm'], labels: { payment: 'Digital Billing', chatbot: 'WhatsApp Ordering' } },
    hotel: { priority: ['admission', 'chatbot', 'payment', 'crm'], labels: { admission: 'Booking Engine' } }
};

// ── PITCH GENERATOR ──────────────────────────────────────────
async function generatePitch(lead, gaps, websiteStatus, finalScore, priority) {
    let domainRaw = (lead.domain || 'school').toLowerCase().trim();
    
    // Normalize plural to singular (except manufacturing)
    let domain = domainRaw;
    if (domain !== 'manufacturing' && domain.endsWith('s')) {
        domain = domain.slice(0, -1);
    }

    // Dynamic terminology from DB
    let terms = { target: 'customers', type: 'business' };
    try {
        const { rows } = await pool.query('SELECT target_term, type_term FROM domains WHERE name = $1', [domain]);
        if (rows.length > 0) {
            terms.target = rows[0].target_term || 'customers';
            terms.type = rows[0].type_term || 'business';
        }
    } catch (e) {
        console.error(`[WARN] Failed to fetch terms for domain ${domain}:`, e.message);
    }

    // --- NEW: Sector-Aware Intelligence ---
    // 1. Identify Profile
    let profile = SECTOR_PROFILES[domain] || SECTOR_PROFILES.school; // Fallback to school if unknown
    
    // 2. Intelligent dynamic classification for "new" sectors
    if (!SECTOR_PROFILES[domain]) {
        if (/health|med|doc|clinic|hospital/.test(domain)) profile = SECTOR_PROFILES.hospital;
        else if (/train|edu|learn|coach/.test(domain)) profile = SECTOR_PROFILES.school;
        else if (/work|industrial|prod|manufacturing/.test(domain)) profile = SECTOR_PROFILES.manufacturing;
        else if (/book|salon|hair|spa|service/.test(domain)) profile = SECTOR_PROFILES.salon;
        else if (/money|bill|pay|audit|finance/.test(domain)) profile = SECTOR_PROFILES.auditing;
    }

    // 3. Re-order gaps based on industry priority
    const prioritizedGaps = [...gaps].sort((a, b) => {
        const indexA = profile.priority.indexOf(a.key);
        const indexB = profile.priority.indexOf(b.key);
        
        // If both are in priority list, use priority order
        if (indexA !== -1 && indexB !== -1) return indexA - indexB;
        // If only one is in priority list, that one goes first
        if (indexA !== -1) return -1;
        if (indexB !== -1) return 1;
        // Fallback to boost points
        return (b.boost || 0) - (a.boost || 0);
    });

    const name = lead.school_name || `your ${domain}`;
    
    // Use sector-specific label if available in profile
    const gapLabels = prioritizedGaps.map((g) => {
        const sectorLabel = profile.labels && (profile.labels[g.key] || profile.labels[g.key.replace(/s$/, '')]);
        return sectorLabel || g.label || g.key;
    });

    let intro = '';
    if (websiteStatus === 'missing') {
        intro = `${name} currently has no website, making it nearly invisible to ${terms.target} searching online.`;
    } else if (websiteStatus === 'broken') {
        intro = `${name}'s website appears to be offline or broken, causing lost ${terms.type} opportunities daily.`;
    } else {
        intro = `${name} has an online presence, but our analysis identified ${gaps.length} critical technology gaps.`;
    }

    const pitchPoints = prioritizedGaps.slice(0, 5).map((g, i) => {
        let p = (g.pitches && (g.pitches[domain] || g.pitches[domainRaw] || g.pitches.default)) || g.pitch || '';
        
        // Replace placeholders
        p = p.replace(/{target}/g, terms.target).replace(/{type}/g, terms.type);
        return `${i + 1}. ${p}`;
    }).join('\n');

    const urgency =
        priority === '🔥 high'
            ? '⚡ HIGH PRIORITY — Contact within 24 hours. Multiple urgent gaps identified.'
            : priority === '⚡ medium'
                ? '📅 MEDIUM PRIORITY — Schedule a call this week.'
                : '📋 LOW PRIORITY — Add to drip campaign.';

    return `
=== EXORA SALES INTELLIGENCE REPORT ===
Lead    : ${name}
Score   : ${finalScore}/100 | Priority: ${priority.toUpperCase()}
Website : ${websiteStatus.toUpperCase()}
Rating  : ${lead.rating || 'N/A'} ⭐  (${lead.reviews || 0} reviews)
Phone   : ${lead.phone || 'N/A'}

📌 SITUATION
${intro}

🔍 GAPS IDENTIFIED (${gaps.length} found)
${gapLabels.join(' | ')}

💬 RECOMMENDED PITCH POINTS
${pitchPoints}

🎯 RECOMMENDED EXORA SERVICES
${gapLabels.join(', ')}

${urgency}
`.trim();
}

// \u2500\u2500 SCORE & UPDATE ONE LEAD ──────────────────────────────────
async function scoreLead(lead) {
    console.log(`\n\ud83d\udd0e Scoring: ${lead.school_name}`);

    // Load live config from DB every time (always up-to-date)
    const cfg = await loadScoreConfig();
    const baseCfg = cfg.filter(c => c.category === 'base');
    const gapCfg = cfg.filter(c => c.category === 'gap');

    // \u2500\u2500 Dynamic base score from DB config \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const getBase = (key) => { const r = baseCfg.find(c => c.key === key); return (r && r.enabled) ? r.points : 0; };
    let baseScore = 0;
    const rating = parseFloat(lead.rating) || 0;
    if (rating >= 4.5) baseScore += getBase('rating_4_5');
    else if (rating >= 4.0) baseScore += getBase('rating_4_0');
    else if (rating >= 3.5) baseScore += getBase('rating_3_5');
    else if (rating >= 3.0) baseScore += getBase('rating_3_0');
    else if (rating > 0) baseScore += getBase('rating_any');
    const rv = parseInt(lead.reviews) || 0;
    if (rv >= 200) baseScore += getBase('reviews_200');
    else if (rv >= 100) baseScore += getBase('reviews_100');
    else if (rv >= 50) baseScore += getBase('reviews_50');
    else if (rv >= 20) baseScore += getBase('reviews_20');
    else if (rv >= 5) baseScore += getBase('reviews_5');
    if (lead.phone) baseScore += getBase('has_phone');
    if (lead.website) baseScore += getBase('has_website');
    if (lead.address) baseScore += getBase('has_address');
    baseScore = Math.min(baseScore, 80);
    console.log(`   \ud83d\udcca Base score (dynamic): ${baseScore}`);

    // \u2500\u2500 Website check \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const { status: websiteStatus, html, isHttps } = await checkWebsiteStatus(lead.website);
    console.log(`   \ud83c\udf10 Website status: ${websiteStatus}`);

    let apiTechs = [];
    if (websiteStatus === 'live') {
        apiTechs = deepTechScan(html);
        if (apiTechs.length > 0) console.log(`   \ud83d\udce1 Deep scanner detected: ${apiTechs.join(', ')}`);
    }

    // \u2500\u2500 Gap detection + dynamic boosts from DB config \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const detectedGaps = detectGaps(html, websiteStatus, isHttps, apiTechs);
    const gaps = detectedGaps
        .map(g => {
            const dbRule = gapCfg.find(c => c.key === g.key);
            if (!dbRule || !dbRule.enabled) return null; // skip disabled rules
            return { 
                ...g, 
                boost: dbRule.points,
                labels: dbRule.labels_json || {},
                pitches: dbRule.pitches_json || g.pitches || {}
            };
        })
        .filter(Boolean);
    console.log(`   \ud83d\udcc9 Gaps: ${gaps.map(g => g.key + '(+' + g.boost + 'pt)').join(', ') || 'none'}`);

    const finalScore = calcFinalScore(baseScore, gaps);
    const priority = classifyPriority(finalScore, gaps.length);
    const pitch = await generatePitch(lead, gaps, websiteStatus, finalScore, priority);

    await pool.query(
        `UPDATE leads SET
           base_score     = $1,
           website_status = $2,
           gaps_found     = $3,
           score          = $4,
           priority       = $5,
           pitch          = $6,
           scored_at      = NOW(),
           status         = CASE WHEN status = 'new' THEN 'scored' ELSE status END
         WHERE id = $7`,
        [baseScore, websiteStatus, JSON.stringify(gaps.map(g => g.key)), finalScore, priority, pitch, lead.id]
    );

    console.log(`   \u2705 Score: ${baseScore} base + gaps \u2192 ${finalScore}/100 | Priority: ${priority}`);
    return { ...lead, base_score: baseScore, website_status: websiteStatus, gaps, score: finalScore, priority, pitch };
}

// ── SCORE ALL UN-SCORED LEADS ────────────────────────────────
async function scoreAllPendingLeads() {
    const { rows: leads } = await pool.query(
        `SELECT * FROM leads WHERE scored_at IS NULL ORDER BY created_at DESC`
    );

    if (leads.length === 0) {
        console.log('ℹ️  No un-scored leads found.');
        return [];
    }

    console.log(`\n🚀 Scoring ${leads.length} leads...\n`);
    const results = [];

    for (const lead of leads) {
        try {
            const scored = await scoreLead(lead);
            results.push(scored);
            await new Promise((r) => setTimeout(r, 1500)); // polite delay
        } catch (err) {
            console.error(`❌ Failed to score ${lead.school_name}:`, err.message);
        }
    }

    console.log(`\n🏁 Scoring complete — ${results.length}/${leads.length} leads scored.`);
    return results;
}

module.exports = { scoreLead, scoreAllPendingLeads, checkWebsiteStatus, detectGaps, generatePitch };
