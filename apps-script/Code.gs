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
// Safety: mail only ever goes to YOUR address plus the people you list below, whatever a request
// says, and the web app URL is a long secret that only Debrief knows.

const ALLOWED = []; // people you want to be able to share minutes with, e.g. ['priya@company.com']
const ALLOWED_DOMAINS = []; // or everyone at a company, e.g. ['company.com']

function doGet() {
  return out({ ok: true, message: 'Debrief mail relay is live.', version: 5 });
}

function authorize() {
  CalendarApp.getDefaultCalendar();
  MailApp.getRemainingDailyQuota();
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
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
      const name = a.name || 'attachment.txt';
      // fromHtml: build a PDF from an HTML page (Apps Script converts it for us).
      if (a.fromHtml) return Utilities.newBlob(a.fromHtml, 'text/html', name.replace(/\.pdf$/i, '') + '.html').getAs('application/pdf').setName(name);
      return Utilities.newBlob(Utilities.base64Decode(a.base64), a.mime || 'text/plain', name);
    });
    const options = {
      to: recipients || me,
      subject: String(d.subject || 'Debrief MOM').slice(0, 250),
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

function isAllowed(address, me) {
  const a = String(address).toLowerCase();
  if (a === String(me).toLowerCase()) return true;
  if (ALLOWED.some(function (x) { return String(x).toLowerCase() === a; })) return true;
  const domain = a.split('@')[1] || '';
  return ALLOWED_DOMAINS.some(function (x) { return String(x).toLowerCase() === domain; });
}

// Finds the calendar event for this meeting (by Meet code in its description or location, else by title)
// and returns who was invited and what they replied.
function findInvitees(d) {
  const start = new Date(Number(d.start) - 45 * 60000);
  const end = new Date(Number(d.end) + 45 * 60000);
  const code = String(d.code || '').toLowerCase();
  const title = String(d.title || '').toLowerCase();
  let best = null;
  CalendarApp.getDefaultCalendar().getEvents(start, end).forEach(function (ev) {
    const where = (ev.getLocation() + ' ' + ev.getDescription()).toLowerCase();
    if (code && where.indexOf(code) >= 0) best = ev;
    else if (!best && title && ev.getTitle().toLowerCase() === title) best = ev;
  });
  if (!best) return out({ ok: true, found: false, guests: [] });
  const status = function (g) {
    const s = String(g.getGuestStatus()).toLowerCase();
    return s.indexOf('yes') >= 0 ? 'yes' : s.indexOf('no') >= 0 && s.indexOf('not') < 0 ? 'no' : s.indexOf('maybe') >= 0 ? 'maybe' : 'invited';
  };
  const guests = best.getGuestList(true).map(function (g) {
    return { name: g.getName() || '', email: g.getEmail(), status: status(g) };
  });
  const me = Session.getEffectiveUser().getEmail();
  if (!guests.some(function (g) { return String(g.email).toLowerCase() === String(me).toLowerCase(); })) guests.push({ name: '', email: me, status: 'owner' });
  return out({ ok: true, found: true, title: best.getTitle(), guests: guests });
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
