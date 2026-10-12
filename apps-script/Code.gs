// Debrief mail relay: lets the Debrief extension email your MOM from your own Google account.
//
// Setup (2 minutes):
//   1. Go to script.google.com > New project, delete the sample code, paste this whole file.
//   2. Change TOKEN below to any long random string and keep it handy.
//   3. Deploy > New deployment > type: Web app
//        Execute as: Me
//        Who has access: Anyone
//      Authorize when asked (it needs permission to send email as you).
//   4. Copy the Web app URL and your TOKEN into Debrief > Settings > Email the MOM.
//
// Safety: mail only goes to YOUR address plus anything you list in ALLOWED, and only
// when the request carries your TOKEN, so a leaked URL alone cannot be used to send spam.

const TOKEN = 'CHANGE-ME';
const ALLOWED = []; // extra recipients you are happy to send to, e.g. ['team@company.com']

function doGet() {
  return out({ ok: true, message: 'Debrief mail relay is live.' });
}

function doPost(e) {
  try {
    if (TOKEN === 'CHANGE-ME') return out({ ok: false, error: 'Set TOKEN in the script first.' });
    const d = JSON.parse(e.postData.contents);
    if (d.token !== TOKEN) return out({ ok: false, error: 'Token does not match.' });

    const me = Session.getEffectiveUser().getEmail();
    const allowed = [me].concat(ALLOWED).map(function (s) { return s.toLowerCase(); });
    const wanted = String(d.to || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    const to = wanted.filter(function (a) { return allowed.indexOf(a.toLowerCase()) >= 0; });
    const recipients = to.length ? to.join(',') : me;

    const attachments = (d.attachments || []).map(function (a) {
      const name = a.name || 'attachment.txt';
      // fromHtml: build a PDF from an HTML page (Apps Script converts it for us).
      if (a.fromHtml) return Utilities.newBlob(a.fromHtml, 'text/html', name.replace(/\.pdf$/i, '') + '.html').getAs('application/pdf').setName(name);
      return Utilities.newBlob(Utilities.base64Decode(a.base64), a.mime || 'text/plain', name);
    });
    MailApp.sendEmail({
      to: recipients,
      subject: String(d.subject || 'Debrief MOM').slice(0, 250),
      body: String(d.text || ''),
      htmlBody: String(d.html || ''),
      attachments: attachments,
      name: 'Debrief',
    });
    return out({ ok: true, to: recipients });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
