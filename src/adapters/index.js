// Picks the page reader for the current site.
import * as meet from './meet.js';
import * as generic from './generic.js';

// Sites other than Meet that can be switched on in Settings (experimental, generic detection).
export const OTHER_SITES = [
  { name: 'Microsoft Teams', matches: ['https://teams.microsoft.com/*', 'https://teams.live.com/*'] },
  { name: 'Zoom (web client)', matches: ['https://app.zoom.us/*', 'https://*.zoom.us/wc/*'] },
  { name: 'Webex', matches: ['https://*.webex.com/*'] },
  { name: 'Whereby', matches: ['https://whereby.com/*'] },
  { name: 'Jitsi Meet', matches: ['https://meet.jit.si/*'] },
];

export function adapterFor(hostname) {
  if (hostname === 'meet.google.com') return { id: 'meet', name: 'Google Meet', ...meet, hasPeople: true };
  const site = OTHER_SITES.find((s) => s.matches.some((m) => new RegExp(`^${m.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(`https://${hostname}/`)));
  return { id: 'generic', name: site?.name || hostname, ...generic, diagnose: (doc) => generic.diagnose(doc, site?.name || hostname), hasPeople: false };
}
