// Offscreen document: captures tab audio (+ optional mic), cuts it into <30 s chunks at pauses,
// transcribes each chunk, and sends segments to the service worker.
import { transcribeDetailed, resetSttBudget } from './stt.js';
import { encodeWav } from './wav.js';
import { Chunker, SR, chunkSecs } from './chunker.js';
import { Mixer, Meter, timelineOf, attributeMixed } from './mixer.js';
import { segmentsFromUtterances } from './utter.js';
import { createJobRunner, useStore } from './jobs.js';
import { savePending } from './audiostore.js';
import { transcribePiece } from './coverage.js';
import { VoiceTracker } from './voice/tracker.js';
import { createVoiceClient } from './voice/client.js';
import { MODEL_SHA256 } from './voice/modelstore.js';
import { pack } from './voice/match.js';
import { putPiece, pieceKey, toInt16, MAX_PIECES } from './voice/samples.js';
import { startKeeping, purgeOld } from './audiokeep.js';
import { ScreenWatcher } from './screen.js';
import { describeScreen, resetVision, visionUnavailable } from './vision.js';
import { allExhausted, modelChain } from './gemini.js';
import { visionBudget, parseLimits } from './usage.js';

const CONCURRENCY = 3;
const MAX_REREADS = 8; // pieces read again in parts per recording (each costs a few requests)

// Sarvam's REST API caps audio at 30 s. Gemini takes long audio, so it gets ~2 min chunks,
// which keeps request counts well inside free-tier limits.
const chunkSize = (s, onSkip) => ({ ...chunkSecs(s), onSkip });

let rec = null;

// Small promise pool so slow STT calls don't pile up unbounded.
function makePool(limit) {
  let active = 0;
  const queue = [];
  const pending = new Set();
  const next = () => {
    while (active < limit && queue.length) {
      const job = queue.shift();
      active++;
      const p = job().finally(() => {
        active--;
        pending.delete(p);
        next();
      });
      pending.add(p);
    }
  };
  return {
    add(job) {
      queue.push(job);
      next();
    },
    async drain() {
      while (queue.length || pending.size) await Promise.allSettled([...pending]);
    },
  };
}

async function tap(ctx, stream, onBlock) {
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-tap', { channelCount: 1, channelCountMode: 'explicit' });
  node.port.onmessage = (e) => onBlock(e.data);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node).connect(mute).connect(ctx.destination);
}

async function startVoice(meetingId, keepAudio = false, room = false, modelDownloadUrl = '') {
  const client = createVoiceClient({
    workerUrl: chrome.runtime.getURL('dist/worker.js'),
    modelUrl: chrome.runtime.getURL('models/wespeaker_resnet34_lm.onnx'),
    wasmPaths: chrome.runtime.getURL('vendor/ort/'),
    modelDownloadUrl: modelDownloadUrl || undefined,
    ...(modelDownloadUrl ? { modelSha256: MODEL_SHA256 } : {}),
    onModelProgress: () => {},
  });
  let guard;
  try {
    await Promise.race([client.ready, new Promise((_, rej) => (guard = setTimeout(() => rej(new Error('model load timed out')), 45000)))]);
  } catch (e) {
    client.close(); // the worker is already running: do not leave it behind when the model cannot load
    throw e;
  } finally {
    clearTimeout(guard);
  }
  const out = [];
  const flush = () => {
    if (!out.length) return;
    chrome.runtime.sendMessage({ target: 'bg', type: 'voice-seg', meetingId, segs: out.splice(0) }).catch(() => {});
  };
  let kept = 0;
  // One tracker per stream of speech: the meeting tab (the others) and, in room mode, the microphone.
  const makeTracker = (origin) => new VoiceTracker((seg) => {
    // Optional: a copy of this piece waits in this browser (not uploaded) so an unnamed voice can later be played back.
    if (keepAudio && kept < MAX_PIECES && seg.t1 - seg.t0 >= 2) {
      kept++;
      putPiece(pieceKey(meetingId, seg.t0, origin), toInt16(seg.pcm)).catch(() => {});
    }
    // A slow computer drops pieces here (the client queue is bounded) instead of slowing the recording.
    client
      .embed(seg.pcm)
      .then((e) => e && out.push({ t0: Math.round(seg.t0 * 100) / 100, t1: Math.round(seg.t1 * 100) / 100, e: pack(e), ...(origin === 'm' ? { s: 'm' } : {}) }))
      .catch(() => {});
  });
  const tracker = makeTracker('o');
  const trackerMic = room ? makeTracker('m') : null;
  const timer = setInterval(flush, 10000);
  return { client, tracker, trackerMic, flush, timer };
}

// Kept recording: a second, separate graph on the playback context (the 16 kHz transcription path is not touched) mixes the tab
// and the microphone for a MediaRecorder. Gains follow what the transcript hears: the mic only while it is on, nothing while paused.
const TAB_GAIN = 0.9;
const MIC_GAIN = 0.9;
function applyKeepGains(r) {
  if (!r?.keep) return;
  r.keep.tabGain.gain.value = r.paused ? 0 : TAB_GAIN;
  if (r.keep.micGain) r.keep.micGain.gain.value = !r.paused && r.micOn ? MIC_GAIN : 0;
}

async function setupKeep({ playCtx, tabStream, micStream, meetingId, dbgNote }) {
  if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder is not available');
  const dest = playCtx.createMediaStreamDestination();
  const tabGain = playCtx.createGain();
  playCtx.createMediaStreamSource(tabStream).connect(tabGain);
  tabGain.connect(dest);
  let micGain = null;
  if (micStream) {
    micGain = playCtx.createGain();
    playCtx.createMediaStreamSource(micStream).connect(micGain);
    micGain.connect(dest);
  }
  // A failed write (quota) stops keeping and says so once; transcription never depends on this.
  const keeper = await startKeeping({
    stream: dest.stream,
    meetingId,
    onError: (e) => dbgNote(`kept recording stopped: ${e?.message || e} (transcription continues)`),
  });
  return { keeper, tabGain, micGain };
}

// Today's request counts and the daily limits, for visionBudget. This document has no chrome.storage, so they come through the
// service worker (op 'usage' of the store handler: { usage, learnedLimits }); read at most every 30 s. -> [usage, limits]
let usageCache = { at: 0, v: [{}, {}] };
async function usageNow() {
  if (Date.now() - usageCache.at < 30000) return usageCache.v;
  usageCache.at = Date.now();
  try {
    const got = await viaBg({ op: 'usage' });
    const set = await viaBg({ op: 'settings' }).catch(() => null);
    usageCache.v = [got?.usage || {}, { ...(got?.learnedLimits || {}), ...parseLimits(set?.usageLimits) }];
  } catch {
    usageCache.v = [{}, {}]; // not known: no limit to hold back for
  }
  return usageCache.v;
}

// Screen notes: a hidden <video> shows the tab's picture, a ScreenWatcher samples it, vision.js describes changed frames.
function setupScreen({ videoStream, settings, meetingId, getRec, dbgNote }) {
  resetVision();
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = videoStream;
  Promise.resolve(video.play?.()).catch(() => {});
  let prev = '';
  let budgetSaid = false;
  const watcher = new ScreenWatcher({
    video,
    everySec: settings.screenNotesEverySec,
    onGiveUp: (why) => dbgNote(`screen notes: stopped for this recording because the request cannot succeed (${why}); no more pictures are sent`),
    // nothing is asked while every general Gemini model is over its limit, once the model has shown it cannot see pictures, or
    // when asking would eat into what the minutes need (see visionBudget)
    budgetOk: async () => {
      if (visionUnavailable()) return false;
      if (settings.llmProvider !== 'gemini') return true;
      if (await allExhausted(modelChain(settings.geminiModel))) return false;
      const b = visionBudget(...(await usageNow()), settings);
      if (b.known && !b.ok) {
        if (!budgetSaid) {
          budgetSaid = true;
          dbgNote(`screen notes: stopped to keep the last ${b.reserve} of today's ${b.limit} requests for ${b.model} for the minutes (${b.used} used)`);
        }
        return false;
      }
      return true;
    },
    onFrame: async (blob, t) => {
      const r = await describeScreen(blob, settings, { prev, onNote: dbgNote });
      if (r.text) {
        prev = r.text;
        chrome.runtime.sendMessage({ target: 'bg', type: 'screen-note', meetingId, note: { t, text: r.text, presenter: getRec()?.presenter || null } }).catch(() => {});
      }
      return r;
    },
  });
  watcher.start();
  return { watcher, video };
}

// Everything a recording holds, undone. Used by stop() and by a start() that failed or was stopped half-way, so it may meet a
// recording with only some of its parts and runs twice without harm (each part is cleared as it goes).
async function teardown(r) {
  if (rec === r) rec = null;
  clearInterval(r.levelTimer);
  clearInterval(r.dbgTimer);
  try {
    r.mixer?.drain();
    Object.values(r.chunkers || {}).forEach((c) => c.flush());
  } catch {}
  try {
    r.screen?.watcher.stop();
    if (r.screen) {
      r.screen.video.srcObject = null;
      r.screen.video.remove?.();
    }
  } catch {}
  r.screen = null;
  const keep = r.keep;
  r.keep = null;
  await keep?.keeper.stop().catch(() => {}); // the last piece is written before the audio contexts close
  [r.tabStream, r.micStream, r.videoStream].forEach((x) => x?.getTracks().forEach((t) => t.stop()));
  await Promise.allSettled([r.ctx?.close(), r.playCtx?.close()]);
  await r.pool?.drain();
  const voice = r.voice;
  r.voice = null;
  if (voice) {
    clearInterval(voice.timer);
    try {
      voice.tracker.flush();
      voice.trackerMic?.flush();
      await voice.client.drain(20000);
    } catch {}
    voice.flush();
    voice.client.close();
  }
}

async function start({ streamId, settings, meetingId }) {
  if (rec) throw new Error('Already recording');
  // From here `rec` exists, so a stop() that arrives while we wait finds everything made so far and undoes it; after each wait
  // we look whether that happened (`gone()`) and undo what was just made too.
  const r = { tabStream: null, micStream: null, videoStream: null, playCtx: null, ctx: null, pool: null, micOn: false, chunkers: {} };
  rec = r;
  const gone = async () => {
    if (rec === r) return;
    await teardown(r);
    throw new Error('Recording was stopped while it was starting');
  };
  try {
    return await startInner(r, gone, { streamId, settings, meetingId });
  } catch (e) {
    await teardown(r).catch(() => {});
    throw e;
  }
}

async function startInner(r, gone, { streamId, settings, meetingId }) {
  const dbgNote = (note) => chrome.runtime.sendMessage({ target: 'bg', type: 'dbg', meetingId, note }).catch(() => {});
  purgeOld(settings.keepAudioDays).catch(() => {}); // cheap: drops kept audio older than the setting

  const tabStream = (r.tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  }));
  await gone();

  // The picture is wanted only for screen notes. The audio above is already safe, so nothing here can cost it.
  let videoStream = null;
  if (settings.screenNotes) {
    const tabSource = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
    const video = { mandatory: { ...tabSource, maxWidth: 1280, maxHeight: 720, maxFrameRate: 1 } };
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    } catch {
      // some Chrome versions allow one consumer per stream id: ask for both in one call, keep its picture, drop its second audio
      try {
        videoStream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: tabSource }, video });
        videoStream.getAudioTracks().forEach((t) => t.stop());
      } catch {
        videoStream = null;
      }
    }
    if (!videoStream?.getVideoTracks().length) {
      videoStream?.getTracks().forEach((t) => t.stop());
      videoStream = null;
      dbgNote('screen notes: could not capture the tab picture');
    }
    r.videoStream = videoStream;
    await gone();
  }

  // Capturing a tab mutes it for the user, so play it back at full quality.
  const playCtx = (r.playCtx = new AudioContext());
  playCtx.createMediaStreamSource(tabStream).connect(playCtx.destination);

  let micStream = null;
  let micError = null;
  if (settings.captureMic) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      micError = e.name === 'NotAllowedError' ? 'Microphone permission not granted (open Settings → Grant microphone).' : e.message;
    }
    r.micStream = micStream;
    r.micOn = !!micStream;
    await gone();
  }

  const ctx = (r.ctx = new AudioContext({ sampleRate: SR }));
  // An offscreen document has no user gesture, so Chrome may leave audio contexts suspended; a
  // suspended context never runs the worklet and records nothing.
  await Promise.all([ctx.resume(), playCtx.resume()]);
  await gone();
  if (ctx.state !== 'running') throw new Error(`Audio context is ${ctx.state}, recording would capture nothing.`);
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('worklet.js'));
  await gone();

  resetSttBudget();
  const pool = (r.pool = makePool(CONCURRENCY));
  const rereads = { left: MAX_REREADS }; // a limit on the extra requests a recording may spend on doubtful pieces
  const onChunk = (src, t, pcm, metas, info) =>
    pool.add(async () => {
      const wav = encodeWav(pcm, SR);
      const tl = metas ? timelineOf(metas) : null;
      const t0 = Date.now();
      const dur = Math.round((pcm.length / SR) * 10) / 10;
      try {
        // A long piece answered with a few sentences (or nothing) is read again as short parts (see coverage.js); if it is still thin it is reported as a gap.
        const voicedSec = info?.voicedSec || 0;
        const { text, utterances, gap, chars } = await transcribePiece({
          pcm,
          wav,
          voicedSec,
          transcribeFn: (w) => transcribeDetailed(w, settings), // { text, utterances }
          encode: (x) => encodeWav(x, SR),
          budget: rereads,
          note: (n) => dbgNote(`chunk ${src} @${Math.round(t)}s: ${n}`),
        });
        dbgNote(`chunk ${src} @${Math.round(t)}s ${Math.round(pcm.length / SR)}s -> ${text.length} chars in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        if (gap) chrome.runtime.sendMessage({ target: 'bg', type: 'gap', meetingId, gap: { t: Math.round(t), dur, src, voicedSec: Math.round(voicedSec), chars } }).catch(() => {});
        // one mixed stream: split the text into who-said-what; otherwise the chunk already has its speaker
        // timed utterances (when the provider gave them): real times and a me/others call per utterance; otherwise the whole text is placed by the piece's start
        const segs = !text ? [] : utterances ? segmentsFromUtterances(utterances, { t, src, timeline: tl }) : tl ? attributeMixed(text, t, tl) : [{ t, src, text }];
        for (const seg of segs) chrome.runtime.sendMessage({ target: 'bg', type: 'segment', meetingId, seg: { ...seg, dur, c: Math.round(t * 10) / 10 } }); // c, dur: where the piece this text came from starts and how long it is
      } catch (e) {
        // Keep the audio so the MOM page can retry it after the meeting.
        let saved = false;
        try {
          await savePending({ meetingId, src, t, wav, error: e.message, ...(tl ? { tl } : {}) });
          saved = true;
        } catch {}
        const note = saved ? 'audio kept, will retry after the meeting' : 'audio could not be kept';
        chrome.runtime.sendMessage({ target: 'bg', type: 'stt-error', meetingId, error: `[${Math.round(t)}s ${src}] ${e.message} (${note})` });
      }
    });

  // A silent chunk is dropped without any transcript, so say so instead of failing quietly.
  const onSkip = (src, t, peak, dur) => {
    chrome.runtime.sendMessage({
      target: 'bg',
      type: 'dbg',
      meetingId,
      note: `[${Math.round(t)}s ${src}] chunk skipped as silent (peak ${peak.toFixed(4)}, needs 0.012)`,
    });
    // remembered so a stretch with no text is not reported as a gap when it was really silent (only when this chunker hears everything)
    if (src === 'mix' || !micStream) chrome.runtime.sendMessage({ target: 'bg', type: 'silence', meetingId, t: Math.round(t), dur: Math.round(dur || 0) }).catch(() => {});
  };

  // Gemini with the mic on: ONE mixed stream and one request per chunk (the speaker comes from the levels afterwards).
  // Other providers have no tight daily limit and keep two streams.
  const mixed = !!micStream && settings.sttProvider === 'gemini';
  if (mixed) {
    const mixChunker = new Chunker('mix', onChunk, chunkSize(settings, onSkip));
    r.chunkers.mix = mixChunker;
    // not rec.chunkers: stop() has already cleared rec when the mixer drains its last blocks
    r.mixer = new Mixer((blk, meta) => mixChunker.push(blk, meta));
  }
  r.chunkers.others = mixed ? new Meter() : new Chunker('others', onChunk, chunkSize(settings, onSkip));
  // The callbacks hold THIS recording, not the global: a new recording that starts while this one is still being torn down
  // must not be fed this one's last blocks.
  await tap(ctx, tabStream, (b) => {
    if (rec !== r) return;
    // Paused: the clock keeps running (so times stay right) but only silence goes on, and silence is never sent anywhere.
    const blk = r.paused ? new Float32Array(b.length) : b;
    r.chunkers.others.push(blk);
    r.mixer?.pushTab(blk);
    r.voice?.tracker.push(blk);
  });
  await gone();
  if (micStream) {
    r.chunkers.me = mixed ? new Meter() : new Chunker('me', onChunk, chunkSize(settings, onSkip));
    // While the mic is paused, feed silence so timestamps stay aligned.
    await tap(ctx, micStream, (b) => {
      if (rec !== r) return;
      let pk = 0;
      for (let i = 0; i < b.length; i += 8) pk = Math.max(pk, Math.abs(b[i]));
      r.micRawPeak = Math.max(r.micRawPeak || 0, pk);
      r.micRawBlocks = (r.micRawBlocks || 0) + 1;
      const blk = r.micOn && !r.paused ? b : new Float32Array(b.length);
      r.chunkers.me?.push(blk);
      r.mixer?.pushMic(blk);
      r.voice?.trackerMic?.push(blk);
    });
    await gone();
  }

  // Keep the recording (optional, off by default): stays on this computer, see audiokeep.js.
  if (settings.keepAudio) {
    try {
      r.keep = await setupKeep({ playCtx, tabStream, micStream, meetingId, dbgNote });
      await gone();
      applyKeepGains(r);
    } catch (e) {
      if (rec !== r) throw e; // stopped meanwhile: gone() has already undone it
      dbgNote(`keep recording: could not start (${e.message}); transcription continues`);
    }
  }

  if (videoStream) {
    try {
      r.screen = setupScreen({ videoStream, settings, meetingId, getRec: () => rec, dbgNote });
      if (r.presentingOn != null) r.screen.watcher.setPresenting(r.presentingOn); // told before the watcher existed
    } catch (e) {
      dbgNote(`screen notes: could not start (${e.message})`);
    }
  }

  // Voice recognition (optional): fingerprints of the other participants' speech, made here in a worker.
  // Only the fingerprints leave this document; the audio is never stored and never sent anywhere.
  if ((settings.voiceOn && (settings.voices || []).length) || settings.voiceLearn) {
    r.voice = await startVoice(meetingId, !!(settings.voiceLearn && settings.voiceSamples), !!settings.roomMode, settings.voiceModelUrl).catch(() => null);
    await gone(); // a stop() during the model load: the voice worker and its timer are closed with the rest
    chrome.runtime.sendMessage({ target: 'bg', type: 'dbg', meetingId, note: r.voice ? 'voice recognition: on' : 'voice recognition: could not start (recording continues without it)' });
  }

  // Stop if the tab stops sharing audio (tab closed or navigated away).
  tabStream.getAudioTracks()[0].addEventListener('ended', () => chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }));

  // Live input levels for the popup meter (0 = dead/silent source).
  r.levelTimer = setInterval(() => {
    if (!rec) return;
    // Chrome can suspend an audio context mid-meeting (it is reported): a suspended one records nothing. Try once, and say what came of it.
    if (!rec.resumeTried && (rec.ctx.state === 'suspended' || rec.playCtx.state === 'suspended')) {
      rec.resumeTried = true;
      const was = `ctx=${rec.ctx.state} play=${rec.playCtx.state}`;
      Promise.all([rec.ctx.resume(), rec.playCtx.resume()]).then(
        () => dbgNote(`audio was suspended mid-meeting (${was}); resume() -> ctx=${rec?.ctx.state} play=${rec?.playCtx.state}`),
        (e) => dbgNote(`audio was suspended mid-meeting (${was}); resume() failed: ${e?.message || e}`)
      );
    }
    chrome.runtime.sendMessage({
      target: 'bg',
      type: 'level',
      tab: rec.chunkers.others.takeLevel(),
      mic: rec.chunkers.me && rec.micOn ? rec.chunkers.me.takeLevel() : null,
      ctx: rec.ctx.state,
    });
  }, 1000);

  // Breadcrumbs the MOM page / disk can show: what the audio pipeline is actually doing.
  const dbg = (note) => chrome.runtime.sendMessage({ target: 'bg', type: 'dbg', meetingId, note });
  const trk = (s) => s?.getAudioTracks().map((t) => `${t.readyState}${t.muted ? ' MUTED' : ''}${t.enabled ? '' : ' disabled'}`).join('|') || 'none';
  dbg(`start: ctx=${ctx.state} play=${playCtx.state} tab=${trk(tabStream)} mic=${trk(micStream)}`);
  let n = 0;
  r.dbgTimer = setInterval(() => {
    if (!rec) return;
    n++;
    // A microphone that delivers exactly nothing for a minute is the wrong device or blocked, not a quiet room.
    if (rec.micStream && !rec.micWarned && rec.micRawBlocks > 400 && rec.micRawPeak < 0.0005) {
      rec.micWarned = true;
      dbg(`mic: the raw microphone signal has been silent for ${n * 5}s (peak ${rec.micRawPeak.toFixed(5)}): wrong device or blocked`);
      chrome.runtime.sendMessage({ target: 'bg', type: 'mic-silent', meetingId });
    }
    const c = rec.chunkers.others;
    dbg(`t+${n * 5}s ctx=${rec.ctx.state} play=${rec.playCtx.state} tab=${trk(rec.tabStream)} tabSamples=${c.total} tabPeak=${c.maxEver.toFixed(4)}` + (rec.chunkers.me ? ` micSamples=${rec.chunkers.me.total} micPeak=${rec.chunkers.me.maxEver.toFixed(4)}` : ''));
    if (n >= 24) clearInterval(r.dbgTimer);
  }, 5000);

  return { mic: !!micStream, micError };
}

async function stop() {
  if (!rec) return;
  await teardown(rec);
}

// ---- minutes jobs (see jobs.js): this document has no chrome.storage, so reading and saving go through the service worker ----
const viaBg = async (m) => {
  const r = await chrome.runtime.sendMessage({ target: 'bg', type: 'store', ...m });
  if (!r?.ok) throw new Error('The extension could not reach its storage.');
  return r.value;
};
useStore({
  getSettings: () => viaBg({ op: 'settings' }),
  getMeeting: (id) => viaBg({ op: 'getMeeting', id }),
  saveMeeting: (meeting) => viaBg({ op: 'saveMeeting', meeting }),
  patchMeeting: (id, fields) => viaBg({ op: 'patchMeeting', id, fields }),
  mergeEmailNames: (found) => viaBg({ op: 'mergeEmailNames', found }),
  listMeetingMetas: (opts) => viaBg({ op: 'listMeetingMetas', opts }),
  getMeetingMeta: (id, opts) => viaBg({ op: 'getMeetingMeta', id, opts }),
  appendMeeting: (id, list, items) => viaBg({ op: 'appendMeeting', id, list, items }),
  setActionStatus: (id, actionId, status) => viaBg({ op: 'setActionStatus', id, actionId, status }), // a tick is read and written under the meeting's lock
  applyReview: (id, done, by) => viaBg({ op: 'applyReview', id, done, by }),
  saveMinutes: (id, fields) => viaBg({ op: 'saveMinutes', id, fields }), // the minutes and the action ticks in one update, so a tick made meanwhile is kept
});
const jobs = createJobRunner({
  emit: (m) => chrome.runtime.sendMessage(m).catch(() => {}),
  notify: (n) => chrome.runtime.sendMessage({ target: 'bg', type: 'notify', ...n }).catch(() => {}),
  // when nothing is left to do and nothing is recording, ask the service worker to close this document
  onIdle: (left) => !left && !rec && chrome.runtime.sendMessage({ target: 'bg', type: 'offscreen-idle' }).catch(() => {}),
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // A web page's content script (Meet, Teams) can message the extension too; it must not reach 'mic', 'pause', 'stop', 'job-run'
  // or 'presenting' here. The service worker and Debrief's own pages carry no tab, or a tab on an extension address.
  if (sender?.tab && !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) return;
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'job-run') return sendResponse(jobs.run(msg.id, { force: !!msg.force, reread: !!msg.reread, resume: !!msg.resume }));
  if (msg.type === 'job-hold') return sendResponse(jobs.hold(msg.id));
  if (msg.type === 'job-abort') return sendResponse(jobs.abort(msg.id));
  if (msg.type === 'job-count') return sendResponse({ ok: true, count: jobs.count() });
  if (msg.type === 'start') {
    start(msg).then(
      (r) => sendResponse({ ok: true, ...r }),
      (e) => sendResponse({ ok: false, error: e.message })
    );
    return true;
  }
  if (msg.type === 'stop') {
    stop().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'pause') {
    if (rec) {
      rec.paused = !!msg.on;
      // each part is told on its own: one that throws must not leave the others (or the reply) undone
      for (const f of [() => applyKeepGains(rec), () => rec.keep?.keeper.setPaused(rec.paused), () => rec.screen?.watcher.setPaused(rec.paused)]) {
        try {
          f();
        } catch {}
      }
    }
    sendResponse({ ok: true, paused: !!rec?.paused });
    return;
  }
  if (msg.type === 'mic') {
    if (rec) rec.micOn = !!msg.on && !!rec.micStream;
    applyKeepGains(rec);
    sendResponse({ ok: true, micOn: rec?.micOn ?? false });
    return;
  }
  // From the meeting page via the service worker: who is presenting (Google Meet only; never sent elsewhere = unknown).
  if (msg.type === 'presenting') {
    if (rec) {
      if (msg.on) rec.presenter = msg.name ? String(msg.name).slice(0, 80) : null; // a new presenter whose name cannot be read is not the previous one
      rec.presentingOn = !!msg.on;
      rec.screen?.watcher.setPresenting(!!msg.on);
    }
    sendResponse({ ok: true });
  }
});
