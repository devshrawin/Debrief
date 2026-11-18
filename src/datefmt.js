// One way to write a day everywhere on screen: "16 Nov 2026" (day, short month, year). Independent of the browser's locale.
import { parseDue } from './actions.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDay(ms) {
  const d = new Date(ms instanceof Date ? ms.getTime() : typeof ms === 'string' && /^\d+$/.test(ms) ? +ms : ms);
  if (ms == null || ms === '' || Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`;
}

// A due date written the same way when it can be read as a date; anything else ("next sprint", "Not stated") as written.
// Only when the WHOLE cell is a date ("By end of week, 5 Dec" and "6 marketing tasks" stay as written).
const MONW = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_ONLY = new RegExp(
  `^(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/-]\\d{1,2}[/-](?:\\d{2}|\\d{4})|\\d{1,2}(?:st|nd|rd|th)?[ -]${MONW}\\.?(?:,?[ -](?:\\d{2}|\\d{4}))?|${MONW}\\.? \\d{1,2}(?:st|nd|rd|th)?(?:,? (?:\\d{2}|\\d{4}))?)$`,
  'i',
);
export function fmtDue(text, refMs) {
  const s = String(text ?? '');
  if (!DATE_ONLY.test(s.trim())) return s;
  const d = parseDue(s, refMs);
  return d ? fmtDay(d.getTime()) : s;
}
