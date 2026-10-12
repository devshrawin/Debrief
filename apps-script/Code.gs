// Debrief mail relay: lets the Debrief extension email your MOM from your own Google account.
//
// Setup:  paste this whole file into a new project at script.google.com, then
//         Deploy > New deployment > Web app > Who has access: Anyone > Deploy.
//         Copy the Web app URL into Debrief > Settings > Email the MOM.
//
// Safety: mail only ever goes to YOUR address (plus anything you list in ALLOWED), whatever the
// request says, and the web app URL is a long secret that only Debrief knows.

const ALLOWED = []; // optional extra recipients, e.g. ['team@company.com']

function doGet() {
  return out({ ok: true, message: 'Debrief mail relay is live.', version: 4 });
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);

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
