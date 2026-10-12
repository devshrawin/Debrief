// Emails the finished MOM through the user's own Google Apps Script relay (apps-script/Code.gs),
// so it is sent from their Gmail account with no server of ours in the middle.

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const mailReady = (s) => /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec/.test(s.emailWebhook || '');

// Email clients drop <style> blocks, so give tables and headings inline styles.
function inlineStyles(html) {
  return html
    .replace(/<table>/g, '<table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:14px">')
    .replace(/<th>/g, '<th style="border:1px solid #d0d4da;padding:7px 10px;background:#f1f3f9;text-align:left">')
    .replace(/<th /g, '<th style="border:1px solid #d0d4da;padding:7px 10px;background:#f1f3f9;text-align:left" ')
    .replace(/<td>/g, '<td style="border:1px solid #d0d4da;padding:7px 10px;vertical-align:top">')
    .replace(/<td /g, '<td style="border:1px solid #d0d4da;padding:7px 10px;vertical-align:top" ')
    .replace(/<h1>/g, '<h1 style="font-size:20px;margin:18px 0 8px">')
    .replace(/<h2>/g, '<h2 style="font-size:17px;margin:18px 0 6px;color:#1e1b6b">')
    .replace(/<h3>/g, '<h3 style="font-size:15px;margin:14px 0 4px">');
}

const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120);
const b64 = (str) => {
  const b = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
};

// Word opens HTML saved as .doc, tables and headings intact.
export const wordDocHtml = (bodyHtml) =>
  `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><style>body{font-family:Calibri,sans-serif}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 8px}</style></head><body>${bodyHtml}</body></html>`;

// The relay turns this page into a PDF (Apps Script can convert HTML to PDF, the browser cannot offline).
const pdfPageHtml = (bodyHtml, m) =>
  `<html><head><meta charset="utf-8"><style>@page{size:A4;margin:18mm}body{font-family:Arial,sans-serif;font-size:11pt;line-height:1.5;color:#1f2328}h1{font-size:18pt;color:#1e1b6b;border-bottom:3px solid #ff7a1a;padding-bottom:6px}h2{font-size:14pt;color:#1e1b6b;margin-top:18px}h3{font-size:12pt}table{border-collapse:collapse;width:100%;margin:10px 0}th{background:#eef0f8;text-align:left}td,th{border:1px solid #c8ccd4;padding:5px 8px;vertical-align:top}.meta{color:#656d76;margin-bottom:14px}</style></head><body><h1>${escapeHtml(m.title)}</h1><div class="meta">${escapeHtml(meta(m))}</div>${bodyHtml}</body></html>`;

const meta = (m) => {
  const start = new Date(m.startedAt);
  const mins = m.endedAt ? Math.max(1, Math.round((m.endedAt - m.startedAt) / 60000)) : null;
  return `${start.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}${mins ? ` · ${mins} min` : ''}`;
};

// renderHtml: markdown -> HTML (the MOM page's own renderer, which already escapes raw HTML).
export function buildEmail(meeting, settings, renderHtml, transcriptText) {
  const date = new Date(meeting.startedAt).toISOString().slice(0, 10);
  const body = inlineStyles(renderHtml(meeting.mom || ''));
  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.55;color:#1f2328;max-width:760px">
<div style="border-left:4px solid #ff7a1a;padding:2px 0 2px 12px;margin-bottom:14px">
<div style="font-size:19px;font-weight:700;color:#1e1b6b">${escapeHtml(meeting.title)}</div>
<div style="color:#656d76;font-size:13px">${escapeHtml(meta(meeting))}</div>
</div>
${body}
<p style="color:#8a9099;font-size:12px;margin-top:22px;border-top:1px solid #e3e6ea;padding-top:10px">Written by Debrief${meeting.model ? ` with ${escapeHtml(meeting.model)}` : ''}. Speech-to-text can mishear names and numbers, so check before circulating.</p>
</div>`;
  const text = `${meeting.title}\n${meta(meeting)}\n\n${meeting.mom || ''}\n\n-- Written by Debrief`;
  const attachments = [];
  const base = safeName(`MOM ${meeting.title} ${date}`);
  const raw = renderHtml(meeting.mom || '');
  if (settings.emailPdf) attachments.push({ name: `${base}.pdf`, mime: 'application/pdf', fromHtml: pdfPageHtml(raw, meeting) });
  if (settings.emailWord) attachments.push({ name: `${base}.doc`, mime: 'application/msword', base64: b64(wordDocHtml(raw)) });
  if (settings.emailMd) attachments.push({ name: `${base}.md`, mime: 'text/markdown', base64: b64(meeting.mom || '') });
  if (settings.emailTranscript && transcriptText) {
    attachments.push({ name: safeName(`Transcript ${meeting.title} ${date}`) + '.txt', mime: 'text/plain', base64: b64(transcriptText) });
  }
  return { subject: `MOM: ${meeting.title} (${date})`, html, text, attachments };
}

export async function sendMail(mail, settings) {
  if (!mailReady(settings)) throw new Error('Email is not set up: add the Apps Script URL in Settings.');
  let res;
  try {
    res = await fetch(settings.emailWebhook, {
      method: 'POST',
      // text/plain keeps this a "simple" request: Apps Script web apps do not answer CORS preflights.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ to: settings.emailTo || '', ...mail }),
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'The mail relay did not answer in 60 s.' : `Could not reach the mail relay (${e.message}).`);
  }
  const raw = await res.text();
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error(
      /<html|accounts\.google\.com|Sign in/i.test(raw)
        ? 'The relay asked for a Google sign-in. Redeploy the web app with "Who has access: Anyone".'
        : `Unexpected reply from the mail relay (HTTP ${res.status}).`
    );
  }
  if (!j.ok) throw new Error(j.error || 'The mail relay refused the request.');
  return j;
}
