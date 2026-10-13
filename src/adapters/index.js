// Picks the page reader for the current site.
import * as meet from './meet.js';
import * as generic from './generic.js';

// Popular online meeting apps that work in the browser. Debrief's page script runs on these (see manifest
// content_scripts), so it can show the amber "a call is on" dot, follow your mute button and notice the
// end of the call. Recording itself works on any tab.
export const OTHER_SITES = [
  { name: 'Zoom (web client)', matches: ['https://app.zoom.us/*', 'https://*.zoom.us/wc/*', 'https://zoom.us/wc/*'] },
  { name: 'Microsoft Teams', matches: ['https://teams.microsoft.com/*', 'https://teams.live.com/*', 'https://teams.cloud.microsoft/*'] },
  { name: 'Webex', matches: ['https://*.webex.com/*'] },
  { name: 'Whereby', matches: ['https://whereby.com/*'] },
  { name: 'Jitsi Meet', matches: ['https://meet.jit.si/*', 'https://8x8.vc/*'] },
  { name: 'GoTo Meeting', matches: ['https://app.goto.com/*', 'https://app.gotomeeting.com/*'] },
  { name: 'BlueJeans', matches: ['https://app.bluejeans.com/*'] },
  { name: 'Amazon Chime', matches: ['https://app.chime.aws/*'] },
  { name: 'Zoho Meeting', matches: ['https://meeting.zoho.com/*', 'https://meeting.zoho.in/*', 'https://meeting.zoho.eu/*'] },
  { name: 'Skype for Web', matches: ['https://web.skype.com/*'] },
];

const hostOf = (pattern) => pattern.replace(/^https:\/\//, '').split('/')[0];
const hostMatches = (pattern, hostname) => {
  const h = hostOf(pattern);
  return h.startsWith('*.') ? hostname === h.slice(2) || hostname.endsWith(h.slice(1)) : hostname === h;
};

export function siteFor(hostname) {
  return OTHER_SITES.find((s) => s.matches.some((m) => hostMatches(m, hostname))) || null;
}

export const isMeetingSite = (hostname) => hostname === 'meet.google.com' || !!siteFor(hostname);

export function adapterFor(hostname) {
  if (hostname === 'meet.google.com') return { id: 'meet', name: 'Google Meet', ...meet, hasPeople: true };
  const site = siteFor(hostname);
  return { id: 'generic', name: site?.name || hostname, ...generic, diagnose: (doc) => generic.diagnose(doc, site?.name || hostname), hasPeople: false };
}
