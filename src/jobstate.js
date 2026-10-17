// Job state shared by the service worker (which resumes jobs), the runner and the minutes page. Kept tiny on purpose:
// the service worker imports this without pulling in the whole minutes pipeline.
export const ACTIVE = ['queued', 'transcribing-retry', 'writing', 'emailing'];
export const isActive = (m) => ACTIVE.includes(m?.job?.state);
export const STALE_MS = 30000; // a running job refreshes its beat every 5 s; older than this and nobody is running it
export const COUNTDOWN_MS = 10000;

// Meetings whose job was running when the browser closed or the runner died, and that nobody is running now.
// A job the person held (touched the page during the countdown) waits for them and is never resumed by itself.
export function stuckJobs(meetings, now = Date.now()) {
  return meetings.filter((m) => m && isActive(m) && !m.job?.held && now - (m.job?.beat || 0) > STALE_MS).map((m) => m.id);
}
