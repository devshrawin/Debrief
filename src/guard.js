// Who counts as "outside my organisation" when minutes are shared. Pure: no storage, no network.
// Automatic sharing never goes to outsiders (the person decides by pressing Share on the minutes page); the guard
// only works when the organisation's domains are known, because guessing would hold back the wrong people.
import { parseDomains, myDomains } from './orgtemplate.js';

// Lower-case domains of the organisation: the setting, else the domain of "Send to" when it is a company address.
// Empty = unknown (a personal mail address says nothing about who is "inside").
export const orgDomains = (settings) => myDomains(settings || {});
export { parseDomains };

const domainOf = (a) => String(a || '').trim().toLowerCase().replace(/^.*</, '').replace(/>$/, '').split('@').pop();
// a.b.example.com is inside example.com; example.com.evil.org and notexample.com are not
const inside = (addr, domains) => {
  const d = domainOf(addr);
  return !!d && domains.some((x) => d === x || d.endsWith(`.${x}`));
};

export function splitRecipients(addresses, settings) {
  const list = (addresses || []).filter(Boolean);
  const domains = orgDomains(settings);
  if (!domains.length) return { internal: [...list], external: [], unknown: true };
  const internal = [];
  const external = [];
  for (const a of list) (inside(a, domains) ? internal : external).push(a);
  return { internal, external, unknown: false };
}

const people = (n) => `${n} ${n === 1 ? 'person' : 'people'} outside your organisation`;

// What may go out automatically. With the guard off, or the organisation unknown, everything may.
export function guardAutoShare(list, settings) {
  const all = (list || []).filter(Boolean);
  if (settings?.shareExternalGuard === false) return { send: all, held: [], reason: '' };
  const { internal, external, unknown } = splitRecipients(all, settings);
  if (unknown || !external.length) return { send: all, held: [], reason: '' };
  return { send: internal, held: external, reason: people(external.length) };
}

// For the page, before a manual Share: '' when nothing needs a second look.
export function shareWarning(list, settings) {
  if (settings?.shareExternalGuard === false) return '';
  const { external } = splitRecipients(list, settings);
  if (!external.length) return '';
  if (external.length === 1) return `${external[0]} is outside your organisation.`;
  return `${external[0]} and ${external.length - 1} more are outside your organisation.`;
}

// The line the minutes page shows for addresses that were not sent automatically.
export const heldStatus = (held) => `Not sent automatically to people outside your organisation: ${held.join(', ')}. Open the minutes and press Share to send to them.`;
