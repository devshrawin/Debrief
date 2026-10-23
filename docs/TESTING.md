# Testing the redesign

## 1. Automated (run after every change)
```bash
npm install            # esbuild, axe-core (Playwright comes from your machine or: npm i -D playwright)
npm run build:fx       # regenerates extension/fx/ and the spring tokens in style.css
npm run test:smoke     # every page, light + dark, axe, RTL, 200% zoom, reduced motion
node test/perf.mjs 9   # median first paint per page
node test/pill-preview.mjs   # visual check of the pill in all states
npm run screenshots    # regenerates docs/img
```
Then run the repo's own suites from branch `pro` (`npm run build`, `npm test`, `node test/chrome-smoke.mjs`, `node test/chrome-job.mjs`). They were **not available to this redesign** and must be run before merging (see the final report).

## 2. Must be tested live, in your Chrome
1. **A real Google Meet recording** (10 min or more, two people, one speaking Hindi or Malayalam):
   - Popup shows the amber "A call is on" banner, the Start ring and the beam before recording. Beam and ring disappear once recording starts.
   - The recording card shows the calm beam, meters move, and the mic switch still toggles.
   - Stop. The minutes page opens. The orb steps through *searching → composing → shaping* while the job runs, and the job card beam stops when it finishes.
   - Countdown and hold, resume after restarting Chrome, and attendance "Name (address)" behave exactly as before.
2. **The automatic email:** exactly one email arrives, and the minutes page shows the "Emailed" metal badge.
3. **The pill on a Meet page:** it stays readable over video and full screen and never covers Meet's bottom controls. The panel opens on click and closes on Escape or an outside click. The switch works from the keyboard (Tab, then Space).
4. **Voices:** enrol a voice; the language segmented control slides; ▶ Play on an unnamed voice works.
5. **Settings → General → Appearance → Reduce transparency:** every open Debrief page turns solid at once. Also check that the system Reduce transparency (macOS) and Windows Transparency effects off give the same result.

## 3. Performance in real Chrome
1. Open chrome://extensions, find Debrief, click **Inspect views: service worker**, then right-click the toolbar icon and choose **Inspect popup**.
2. In the Performance panel, enable "Disable cache" and record a reload of `popup.html`. First Contentful Paint should be ≤ 120 ms on a warm profile.
3. Record scrolling the minutes page of a long meeting. If frames drop, check that the minutes document (opaque) is what scrolls under the thin header (one blur layer only). If it is still slow, set `--blur-thin: none` for `.doc-head`.
4. Watch the Task Manager (Shift+Esc) while a pulse beam is on in the popup and with the minutes job running: the effects must not hold a CPU core.
