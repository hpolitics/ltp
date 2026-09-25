/**
 * Health Politics — License to Publish: back end (Google Apps Script)
 *
 * Bound to the "HP LTP Register" Google Sheet.
 *  - doGet  ?t=TOKEN  → returns the Editorial Office pre-fill for that article (JSON)
 *  - doPost           → receives the signed form, saves PDF + JSON to Drive,
 *                       updates the Register and emails the Editorial Office and the author
 *
 * Deploy: Deploy → New deployment → Web app → Execute as: Me · Who has access: Anyone
 * Recipients: Project Settings → Script Properties → NOTIFY = a@x.org,b@y.org
 *
 * Canonical source: apps-script/Code.gs in https://github.com/hpolitics/ltp.
 * Paste this file from the repository, not from any zip or e-mail copy.
 */

const CONFIG = {
  SHEET_NAME: 'Register',
  // Editorial Office recipients: Script Properties → NOTIFY (comma-separated). Kept out of the repository.
  NOTIFY: (PropertiesService.getScriptProperties().getProperty('NOTIFY') || 'journal@hpolitics.org')
    .split(',').map(s => s.trim()).filter(Boolean),
  SEND_AUTHOR_COPY: true,
  SENDER_NAME: 'Health Politics Editorial Office',
  REPLY_TO: 'journal@hpolitics.org',
  FORM_URL: 'https://hpolitics.github.io/ltp/',
  ROOT_FOLDER_NAME: 'HP License to Publish (signed)',
  AGREEMENT_VERSION: 'LTP v2.0 (September 2026)',
  MAX_BODY: 200000
};

// Must stay identical to section 8 of index.html. Change both together and bump AGREEMENT_VERSION.
const AGREEMENT = [
  'By signing this form, the Author(s) agree to the following terms upon acceptance of the manuscript for publication in <em>Health Politics</em>.',
  '<b>1. Grant of License.</b> The Author(s) hereby grant to <em>Health Politics</em> an exclusive license to publish, reproduce, distribute, and display the manuscript in all forms and media, whether now known or hereafter developed. The manuscript will be published under the Creative Commons license selected above, and the license terms will appear on the article page and be deposited to Crossref as machine-readable metadata.',
  '<b>2. Retention of Copyright.</b> The Author(s) retain copyright ownership of the manuscript. Under the chosen Creative Commons license, the Author(s) may:<br>(a) Self-archive any version of the manuscript (preprint, accepted manuscript, or version of record) immediately and without embargo, provided a DOI citation to the published version is included.<br>(b) Use the manuscript, in whole or in part, for the Author(s)\' own teaching, research, and scholarly purposes.<br>(c) Retain all patent and trademark rights, and rights to any process or procedure described in the manuscript.',
  '<b>3. Author Representations and Warranties.</b> The Author(s) represent and warrant that:<br>(a) The manuscript is an original work and has not been previously published in whole or in part, nor is it under consideration for publication elsewhere. Deposition as a preprint does not constitute prior publication.<br>(b) All authors have read and approved the final version of the manuscript and agree to its submission.<br>(c) The manuscript does not infringe upon the copyright or other intellectual property rights of any third party.<br>(d) Any previously published material included in the manuscript has been duly cited, and the Author(s) have obtained all necessary permissions from the original copyright holders for its reproduction.<br>(e) The research was conducted in compliance with applicable ethical standards and, where required, has received appropriate institutional review board or ethics committee approval.',
  '<b>4. Responsibility.</b> The Author(s) shall be responsible for the accuracy and integrity of the contents of the manuscript.',
  '<b>5. Governing Law.</b> This Agreement shall be governed by and construed in accordance with the laws of the Republic of Korea.',
  '<b>6. Effective Date.</b> This Agreement becomes effective upon acceptance of the manuscript for publication in <em>Health Politics</em>.'
];

const COLS = ['token', 'label', 'article_no', 'status', 'prefill_json', 'link',
  'submitted_at', 'signer', 'signer_email', 'license', 'pdf_url', 'json_url', 'submissions', 'missing_at_submit'];

/* ======================= Web endpoints ======================= */

function doGet(e) {
  const t = (e && e.parameter && e.parameter.t) || '';
  if (!t) return json_({ ok: true, prefill: null });
  const row = findRow_(t);
  if (!row) return json_({ ok: false, error: 'This link is not valid. Please contact journal@hpolitics.org.' });
  let prefill = null;
  try { prefill = row.data.prefill_json ? JSON.parse(row.data.prefill_json) : null; } catch (err) { prefill = null; }
  return json_({ ok: true, prefill: prefill, submitted_at: fmt_(row.data.submitted_at) });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const body = (e && e.postData && e.postData.contents) || '';
    if (!body || body.length > CONFIG.MAX_BODY) return json_({ ok: false, error: 'Empty or oversized submission.' });
    const req = JSON.parse(body);
    const md = req.metadata || {};
    if (!md.title || !Array.isArray(md.contributors) || !md.contributors.length) return json_({ ok: false, error: 'Incomplete submission.' });

    const sh = sheet_();
    let row = req.token ? findRow_(req.token) : null;
    if (req.token && !row) return json_({ ok: false, error: 'This link is not valid.' });
    if (!row) { // submission from the blank form (no token)
      const tok = newToken_();
      sh.appendRow(COLS.map(c => c === 'token' ? tok : (c === 'label' ? 'Unsolicited: ' + md.title.slice(0, 60) : (c === 'status' ? 'open' : ''))));
      row = findRow_(tok);
    }

    const now = new Date();
    const stamp = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd HH:mm') + ' KST';
    const corr = md.contributors.filter(c => c.corresponding);
    const signer = corr[0] || md.contributors[0];
    const signerName = [signer.given_name, signer.surname].filter(Boolean).join(' ');
    const base = 'HP_LTP_' + safe_(md.article_number || row.data.article_no || row.data.label || 'MS') + '_' + safe_(signer.surname || 'author');
    const ref = 'LTP-' + Utilities.formatDate(now, 'Asia/Seoul', 'yyyyMMdd-HHmm') + '-' + row.data.token.slice(0, 6).toUpperCase();

    md.server = { received_at: now.toISOString(), reference: ref, agreement_version: CONFIG.AGREEMENT_VERSION,
      client_agreement_version: req.agreement_version || '', token: row.data.token };

    const folder = issueFolder_(md);
    const pdf = Utilities.newBlob(renderHtml_(md, ref, stamp), 'text/html', base + '.html').getAs('application/pdf').setName(base + '_signed.pdf');
    const pdfFile = folder.createFile(pdf);
    const jsonFile = folder.createFile(Utilities.newBlob(JSON.stringify(md, null, 2), 'application/json', base + '_metadata.json'));

    const missing = (md.completeness && md.completeness.missing) || [];
    setCells_(row.index, {
      status: 'signed', submitted_at: now, signer: signerName, signer_email: signer.email || '',
      license: (md.license && md.license.type) || '', pdf_url: pdfFile.getUrl(), json_url: jsonFile.getUrl(),
      submissions: (Number(row.data.submissions) || 0) + 1, missing_at_submit: missing.join(' | ')
    });

    const subj = 'Health Politics — License to Publish received: ' + (md.article_number ? md.article_number + ' ' : '') + (signer.surname || '');
    const office = '<p>A License to Publish has been submitted.</p><table cellpadding="4" style="font-family:Arial;font-size:13px">' +
      tr_('Reference', ref) + tr_('Received', stamp) + tr_('Article', esc_((md.article_number || '') + ' ' + md.title)) +
      tr_('Type', esc_(md.article_type)) + tr_('Signed by', esc_(signerName) + ' &lt;' + esc_(signer.email || '') + '&gt;') +
      tr_('License', esc_(md.license && md.license.type)) + tr_('Submission no.', (Number(row.data.submissions) || 0) + 1) +
      tr_('PDF', '<a href="' + pdfFile.getUrl() + '">' + esc_(pdfFile.getName()) + '</a>') +
      tr_('Metadata', '<a href="' + jsonFile.getUrl() + '">' + esc_(jsonFile.getName()) + '</a>') + '</table>' +
      (missing.length ? '<p><b>Note:</b> ' + esc_(missing.join('; ')) + '</p>' : '');
    MailApp.sendEmail({ to: CONFIG.NOTIFY.join(','), subject: subj, htmlBody: office, name: CONFIG.SENDER_NAME,
      replyTo: signer.email || CONFIG.REPLY_TO, attachments: [pdfFile.getBlob()] });

    let sentTo = '';
    if (CONFIG.SEND_AUTHOR_COPY && signer.email) {
      const toAuthor = '<p>Dear ' + esc_(signerName) + ',</p><p>Thank you for completing the License to Publish for “' + esc_(md.title) +
        '”. A copy of the agreement is attached for your records (reference ' + ref + ').</p>' +
        '<p>If anything needs correcting, you may open the same link, correct the form and submit again.</p>' +
        '<p>With thanks,<br>Editorial Office, <i>Health Politics</i><br>journal@hpolitics.org · hpolitics.org</p>';
      MailApp.sendEmail({ to: signer.email, subject: 'Health Politics — your License to Publish (' + ref + ')', htmlBody: toAuthor,
        name: CONFIG.SENDER_NAME, replyTo: CONFIG.REPLY_TO, attachments: [pdfFile.getBlob()] });
      sentTo = signer.email;
    }
    return json_({ ok: true, ref: ref, received_at: stamp, sent_to: sentTo });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ======================= PDF rendering ======================= */

function renderHtml_(md, ref, stamp) {
  const c = md.contributors || [];
  const f = md.funding || {};
  const d = md.declarations || {};
  const authors = c.map((a, i) => '<tr><td style="width:22px;vertical-align:top">' + (i + 1) + '</td><td>' +
    '<b>' + esc_([a.given_name, a.surname].filter(Boolean).join(' ')) + '</b>' + (a.corresponding ? ' (corresponding)' : '') +
    '<br>' + esc_(a.email || '') + (a.orcid ? ' · ORCID ' + esc_(a.orcid) : '') +
    (a.affiliations || []).map(x => '<br>' + esc_(x.display || '') + (x.ror ? ' [' + esc_(x.ror) + ']' : '')).join('') +
    (a.credit_roles && a.credit_roles.length ? '<br><span style="color:#787878">CRediT: ' + esc_(a.credit_roles.join('; ')) + '</span>' : '') +
    '</td></tr>').join('');
  const funders = (f.funders || []).map(x => esc_(x.funder_name) + (x.funder_id ? ' [' + esc_(x.funder_id) + ']' : '') +
    (x.award_numbers && x.award_numbers.length ? ': ' + esc_(x.award_numbers.join('; ')) : '') + (x.recipients ? ' (' + esc_(x.recipients) + ')' : '')).join('<br>');
  const sig = (md.signature || []).map(s => esc_(s.name) + ' · initials: <b>' + esc_(s.initials) + '</b> · dated ' + esc_(s.date)).join('<br>');
  const row = (k, v) => v ? '<tr><td class="k">' + k + '</td><td>' + v + '</td></tr>' : '';
  return '<html><head><meta charset="utf-8"><style>' +
    'body{font-family:Georgia,serif;font-size:10.5pt;color:#333;line-height:1.45}' +
    'h1{font-size:17pt;color:#9B2C2C;margin:0 0 2px}.jn{font-family:Arial;font-size:9pt;letter-spacing:1px;color:#787878}' +
    'h2{font-family:Arial;font-size:9.5pt;color:#9B2C2C;text-transform:uppercase;letter-spacing:1px;border-bottom:1.5px solid #9B2C2C;padding-bottom:3px;margin:16px 0 6px}' +
    'table{border-collapse:collapse;width:100%}td{padding:3px 4px;vertical-align:top}td.k{width:150px;color:#787878;font-family:Arial;font-size:9pt}' +
    '.agr p{margin:0 0 6px;font-size:9.5pt}.foot{font-family:Arial;font-size:8pt;color:#787878;border-top:1px solid #D0B49F;margin-top:18px;padding-top:6px}' +
    '</style></head><body>' +
    '<div class="jn">HEALTH POLITICS · eISSN 3092-5517</div><h1>License to Publish Agreement</h1>' +
    '<div class="jn">Signed electronically · ' + esc_(stamp) + ' · Reference ' + esc_(ref) + '</div>' +
    '<h2>Article</h2><table>' + row('Title', '<b>' + esc_(md.title) + '</b>') + row('Article type', esc_(md.article_type)) +
    row('Volume / issue', esc_([md.volume, md.issue].filter(Boolean).join(' / '))) + row('Article number', esc_(md.article_number)) +
    row('Series', esc_(md.series)) +
    row('DOI', esc_(md.doi)) + row('Manuscript no.', esc_(md.manuscript_id)) +
    row('Dates', esc_(Object.keys(md.dates || {}).filter(k => md.dates[k]).map(k => k.replace('_', ' ') + ' ' + md.dates[k]).join(' · '))) +
    row('Keywords', esc_((md.keywords || []).join('; '))) + '</table>' +
    (md.abstract ? '<h2>Abstract</h2><div style="white-space:pre-wrap;font-size:9.5pt">' + esc_(md.abstract) + '</div>' : '') +
    '<h2>Authors</h2><table>' + authors + '</table>' +
    '<h2>Funding and declarations</h2><table>' + row('Funding', esc_(f.status) + (funders ? '<br>' + funders : '')) +
    row('Funding statement', esc_(f.statement)) + row('Conflict of interest', esc_(d.conflict_of_interest)) +
    row('Ethics', esc_(d.ethics)) + row('Data availability', esc_(d.data_availability)) + '</table>' +
    '<h2>License</h2><p><b>' + esc_(md.license && md.license.type) + '</b> ' + esc_(md.license && md.license.url) + '</p>' +
    '<h2>Agreement (' + esc_(CONFIG.AGREEMENT_VERSION) + ')</h2><div class="agr">' + AGREEMENT.map(p => '<p>' + p + '</p>').join('') + '</div>' +
    '<h2>Corresponding author signature</h2><p>' + sig + '</p>' +
    '<div class="foot">Submitted through the Health Politics License to Publish form (' + esc_(CONFIG.FORM_URL) + ') on ' + esc_(stamp) +
    '. Received by the Editorial Office, Health Politics, journal@hpolitics.org.</div></body></html>';
}

/* ======================= Admin menu ======================= */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('LTP')
    .addItem('1. Set up register (first time)', 'setup')
    .addItem('2. Generate tokens and links for new rows', 'generateLinks')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sh) { sh = ss.getSheets()[0]; sh.setName(CONFIG.SHEET_NAME); } // e.g. after File → Import of register.csv
  const head = sh.getRange(1, 1, 1, COLS.length).getValues()[0];
  if (head.join('') === '') sh.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  rootFolder_();
  generateLinks();
  SpreadsheetApp.getUi().alert('Register ready. Signed PDFs will be saved in Drive folder: ' + CONFIG.ROOT_FOLDER_NAME);
}

function generateLinks() {
  const sh = sheet_();
  const vals = sh.getDataRange().getValues();
  const h = vals[0];
  const ti = h.indexOf('token'), li = h.indexOf('link'), si = h.indexOf('status');
  for (let r = 1; r < vals.length; r++) {
    if (!vals[r].join('')) continue;
    if (!vals[r][ti]) sh.getRange(r + 1, ti + 1).setValue(newToken_());
    const tok = sh.getRange(r + 1, ti + 1).getValue();
    sh.getRange(r + 1, li + 1).setValue(CONFIG.FORM_URL + '?t=' + tok);
    if (!vals[r][si]) sh.getRange(r + 1, si + 1).setValue('open');
  }
}

/* ======================= Helpers ======================= */

function sheet_() { return SpreadsheetApp.getActive().getSheetByName(CONFIG.SHEET_NAME); }

function findRow_(token) {
  if (!token || !/^[A-Za-z0-9_-]{8,64}$/.test(token)) return null;
  const vals = sheet_().getDataRange().getValues();
  const h = vals[0]; const ti = h.indexOf('token');
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][ti]) === token) {
      const data = {}; h.forEach((k, i) => data[k] = vals[r][i]);
      return { index: r + 1, data: data };
    }
  }
  return null;
}

function setCells_(rowIndex, obj) {
  const sh = sheet_(); const h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  Object.keys(obj).forEach(k => { const i = h.indexOf(k); if (i >= 0) sh.getRange(rowIndex, i + 1).setValue(obj[k]); });
}

function rootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('ROOT_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate */ } }
  const f = DriveApp.createFolder(CONFIG.ROOT_FOLDER_NAME);
  props.setProperty('ROOT_FOLDER_ID', f.getId());
  return f;
}

function issueFolder_(md) {
  const root = rootFolder_();
  const name = (md.volume && md.issue) ? 'Vol' + md.volume + 'No' + md.issue : 'Unassigned';
  const it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

function newToken_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 20); }
function safe_(s) { return String(s).replace(/[^\w.-]+/g, '_').slice(0, 40); }
function esc_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function tr_(k, v) { return '<tr><td style="color:#787878">' + k + '</td><td>' + (v == null ? '' : v) + '</td></tr>'; }
function fmt_(d) { return d instanceof Date ? Utilities.formatDate(d, 'Asia/Seoul', 'yyyy-MM-dd HH:mm') + ' KST' : (d || ''); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
