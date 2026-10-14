// Debrief mail relay: lets the Debrief extension email your MOM from your own Google account.
//
// Setup:  paste this whole file into a new project at script.google.com, then
//         Deploy > New deployment > Web app > Who has access: Anyone > Deploy.
//         Copy the Web app URL into Debrief > Settings > Email.
//
// After you change this file later: Deploy > Manage deployments > pencil > Version: New version > Deploy.
// The first time (and whenever Google asks for new permissions), pick the function "authorize" in the
// toolbar and press Run once, then allow access. That grants email sending and calendar reading.
//
// Security: "Anyone" can reach the URL, so the script locks itself to the Debrief install that talks to it
// first. Debrief makes up a long random secret on its own (you never type it) and sends it with every
// request; the script remembers the first one and refuses everything else. Mail only ever goes to YOUR
// address plus the people you list below. If you reinstall Debrief or use a new browser profile and see
// "locked", run the function "resetSecret" here once and send a test email again.

const ALLOWED = []; // people you want to be able to share minutes with, e.g. ['priya@company.com']
const ALLOWED_DOMAINS = []; // or everyone at a company, e.g. ['company.com']

function doGet() {
  return out({ ok: true, message: 'Debrief mail relay is live.', version: 7, locked: !!PropertiesService.getScriptProperties().getProperty('secret') });
}

function authorize() {
  CalendarApp.getDefaultCalendar();
  MailApp.getRemainingDailyQuota();
}

// Run this from the editor if Debrief says the relay is locked to another install.
function resetSecret() {
  PropertiesService.getScriptProperties().deleteProperty('secret');
}

function sameText(a, b) {
  a = String(a);
  b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// First secret seen is kept (trust on first use). Everything after must present the same one.
function authorized(d) {
  const props = PropertiesService.getScriptProperties();
  const stored = props.getProperty('secret');
  const given = typeof d.secret === 'string' ? d.secret : '';
  if (!stored) {
    if (given.length < 24) return false;
    props.setProperty('secret', given);
    return true;
  }
  return sameText(stored, given);
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (!authorized(d)) return out({ ok: false, error: 'This script is locked to a different Debrief install. In the script editor run the function resetSecret once, then try again.' });
    if (d.action === 'invitees') return findInvitees(d);

    const me = Session.getEffectiveUser().getEmail();
    const pick = function (list) {
      const wanted = String(list || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      const ok = [];
      const skipped = [];
      wanted.forEach(function (a) {
        (isAllowed(a, me) ? ok : skipped).push(a);
      });
      return { ok: ok, skipped: skipped };
    };
    const to = pick(d.to);
    const cc = pick(d.cc);
    const bcc = pick(d.bcc);
    const recipients = to.ok.length ? to.ok.join(',') : (cc.ok.length || bcc.ok.length ? '' : me);

    const attachments = (d.attachments || []).map(function (a) {
      const name = String(a.name || 'attachment.txt').slice(0, 150);
      // fromHtml: build a PDF from an HTML page. Remote resources are stripped so the page cannot call out.
      if (a.fromHtml) return Utilities.newBlob(stripRemote(a.fromHtml), 'text/html', name.replace(/\.pdf$/i, '') + '.html').getAs('application/pdf').setName(name);
      return Utilities.newBlob(Utilities.base64Decode(a.base64), a.mime || 'text/plain', name);
    });
    const options = {
      to: recipients || me,
      subject: String(d.subject || 'Debrief MOM').replace(/[\r\n]+/g, ' ').slice(0, 250),
      body: String(d.text || ''),
      htmlBody: String(d.html || ''),
      attachments: attachments,
      name: 'Debrief',
      replyTo: me,
    };
    if (cc.ok.length) options.cc = cc.ok.join(',');
    if (bcc.ok.length) options.bcc = bcc.ok.join(',');
    MailApp.sendEmail(options);
    return out({ ok: true, to: options.to, cc: cc.ok, bcc: bcc.ok, skipped: to.skipped.concat(cc.skipped, bcc.skipped) });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function stripRemote(html) {
  return String(html)
    .replace(/<(img|link|script|iframe|object|embed|video|audio|source)\b[^>]*>/gi, '')
    .replace(/url\s*\([^)]*\)/gi, 'none')
    .replace(/@import[^;]*;/gi, '');
}

function isAllowed(address, me) {
  const a = String(address).trim().toLowerCase();
  if (!/^[^\s@,;<>"'`()\[\]\\]+@[^\s@,;<>"'`()\[\]\\]+\.[^\s@,;<>"'`()\[\]\\]+$/.test(a) || a.split('@').length !== 2) return false;
  if (a === String(me).toLowerCase()) return true;
  if (ALLOWED.some(function (x) { return String(x).toLowerCase() === a; })) return true;
  const domain = a.split('@')[1];
  return ALLOWED_DOMAINS.some(function (x) { return String(x).toLowerCase() === domain; });
}

// Finds the calendar event for this meeting by its exact Meet code (else by exact title) and returns who
// was invited and what they replied. Only names, emails and replies leave the script, never the event text.
function findInvitees(d) {
  const code = String(d.code || '').toLowerCase();
  const codeOk = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code);
  const startMs = Number(d.start);
  const endMs = Number(d.end);
  if (!(startMs > 0)) return out({ ok: true, found: false, guests: [] });
  const dayMs = 24 * 3600 * 1000;
  const start = new Date(startMs - 45 * 60000);
  const end = new Date(Math.min(isFinite(endMs) && endMs > startMs ? endMs : startMs, startMs + dayMs) + 45 * 60000);
  const title = String(d.title || '').toLowerCase().trim();
  // Meet links added with "Add Google Meet" are often not in the event's location or description, so the code
  // alone misses them. Three tiers: the code, the exact title, then a title that mostly matches.
  const words = function (t) {
    return t.split(/[^a-z0-9\u0900-\u097f\u0d00-\u0d7f]+/).filter(function (w) { return w.length >= 3; });
  };
  const near = function (a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length >= 6 && b.length >= 6 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)) return true;
    const wa = words(a);
    const wb = words(b);
    if (wa.length < 2 || wb.length < 2) return false;
    const common = wa.filter(function (w) { return wb.indexOf(w) >= 0; }).length;
    return common / Math.min(wa.length, wb.length) >= 0.67;
  };
  let best = null;
  let bestRank = 9;
  let bestGap = Infinity;
  let how = '';
  CalendarApp.getDefaultCalendar().getEvents(start, end).forEach(function (ev) {
    const where = (ev.getLocation() + ' ' + ev.getDescription()).toLowerCase();
    const gap = Math.abs(ev.getStartTime().getTime() - startMs);
    const t = ev.getTitle().toLowerCase().trim();
    const rank = codeOk && where.indexOf(code) >= 0 ? 0 : title && t === title ? 1 : title && near(t, title) ? 2 : 9;
    if (rank < 9 && (rank < bestRank || (rank === bestRank && gap < bestGap))) {
      best = ev;
      bestRank = rank;
      bestGap = gap;
      how = rank === 0 ? 'code' : rank === 1 ? 'title' : 'similar title';
    }
  });
  if (!best) return out({ ok: true, found: false, guests: [] });
  const status = function (g) {
    const s = String(g.getGuestStatus()).toLowerCase();
    return s.indexOf('owner') >= 0 ? 'owner' : s.indexOf('yes') >= 0 ? 'yes' : s.indexOf('maybe') >= 0 ? 'maybe' : s === 'no' || s.indexOf('.no') >= 0 ? 'no' : 'invited';
  };
  const guests = best.getGuestList(true).map(function (g) {
    return { name: g.getName() || '', email: g.getEmail(), status: status(g) };
  });
  const me = Session.getEffectiveUser().getEmail();
  if (!guests.some(function (g) { return String(g.email).toLowerCase() === String(me).toLowerCase(); })) guests.push({ name: '', email: me, status: 'owner' });
  return out({ ok: true, found: true, how: how, guests: guests });
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
