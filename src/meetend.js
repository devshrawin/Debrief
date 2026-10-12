// Recognises Google Meet's "call is over" screens from the visible button and heading texts.
// Only buttons and headings are read, so something typed in chat can never trigger it.
const BUTTON_ONLY = /^(rejoin|return to (the )?home screen)$/i;
const HEADLINE = /(you(?:'|’)?ve|you have) left the meeting|you left the meeting|the meeting has ended|this call has ended|call ended|you(?:'|’)?ve been removed from the meeting|you were removed from the meeting|meeting ended/i;

export function meetingEnded(texts) {
  return (texts || []).some((raw) => {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    return t.length > 0 && t.length < 120 && (BUTTON_ONLY.test(t) || HEADLINE.test(t));
  });
}

export const MEET_CODE = /[a-z]{3}-[a-z]{4}-[a-z]{3}/;
