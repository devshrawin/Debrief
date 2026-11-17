// One way to write a day everywhere on screen: "16 Nov 2026" (day, short month, year). Independent of the browser's locale.
import { parseDue } from './actions.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDay(ms) {
  const d = new Date(ms instanceof Date ? ms.getTime() : typeof ms === 'string' && /^\d+$/.test(ms) ? +ms : ms);
  if (ms == null || ms === '' || Number.isNaN(d.getTime())) return '';
  return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`;
}

// A due date written the same way when it can be read as a date; anything else ("next sprint", "Not stated") as written.
export function fmtDue(text, refMs) {
  const s = String(text ?? '');
  const d = parseDue(s, refMs);
  return d ? fmtDay(d.getTime()) : s;
}
