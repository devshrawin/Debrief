// Offscreen document: captures tab audio (+ optional mic), cuts it into <30 s chunks at pauses,
// transcribes each chunk, and sends segments to the service worker.
import { transcribe } from './stt.js';
import { encodeWav } from './wav.js';
import { Chunker, SR } from './chunker.js';
import { savePending } from './audiostore.js';
import { VoiceTracker } from './voice/tracker.js';
import { createVoiceClient } from './voice/client.js';
import { pack } from './voice/match.js';

const CONCURRENCY = 3;

// Sarvam's REST API caps audio at 30 s. Gemini takes long audio, so it gets ~2 min chunks,
// which keeps request counts well inside free-tier limits.
const chunkSize = (s, onSkip) => ({ ...(s.sttProvider === 'gemini' ? { minSec: 100, maxSec: 150 } : { minSec: 18, maxSec: 28 }), onSkip });

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

async function startVoice(meetingId) {
  const client = createVoiceClient({
    workerUrl: chrome.runtime.getURL('dist/worker.js'),
    modelUrl: chrome.runtime.getURL('models/wespeaker_resnet34_lm.onnx'),
    wasmPaths: chrome.runtime.getURL('vendor/ort/'),
  });
  await Promise.race([client.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('model load timed out')), 45000))]);
  const out = [];
  const flush = () => {
    if (!out.length) return;
    chrome.runtime.sendMessage({ target: 'bg', type: 'voice-seg', meetingId, segs: out.splice(0) }).catch(() => {});
  };
  const tracker = new VoiceTracker((seg) => {
    // A slow computer drops pieces here (the client queue is bounded) instead of slowing the recording.
    client
      .embed(seg.pcm)
      .then((e) => e && out.push({ t0: Math.round(seg.t0 * 100) / 100, t1: Math.round(seg.t1 * 100) / 100, e: pack(e) }))
      .catch(() => {});
  });
  const timer = setInterval(flush, 10000);
  return { client, tracker, flush, timer };
}

async function start({ streamId, settings, meetingId }) {
  if (rec) throw new Error('Already recording');

  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });

  // Capturing a tab mutes it for the user, so play it back at full quality.
  const playCtx = new AudioContext();
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
  }

  const ctx = new AudioContext({ sampleRate: SR });
  // An offscreen document has no user gesture, so Chrome may leave audio contexts suspended; a
  // suspended context never runs the worklet and records nothing.
  await Promise.all([ctx.resume(), playCtx.resume()]);
  if (ctx.state !== 'running') throw new Error(`Audio context is ${ctx.state}, recording would capture nothing.`);
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('worklet.js'));

  const pool = makePool(CONCURRENCY);
  const onChunk = (src, t, pcm) =>
    pool.add(async () => {
      const wav = encodeWav(pcm, SR);
      const t0 = Date.now();
      try {
        const text = await transcribe(wav, settings);
        chrome.runtime.sendMessage({ target: 'bg', type: 'dbg', meetingId, note: `chunk ${src} @${Math.round(t)}s ${Math.round(pcm.length / SR)}s -> ${text.length} chars in ${((Date.now() - t0) / 1000).toFixed(1)}s` });
        if (text) chrome.runtime.sendMessage({ target: 'bg', type: 'segment', meetingId, seg: { t, src, text, dur: Math.round((pcm.length / SR) * 10) / 10 } });
      } catch (e) {
        // Keep the audio so the MOM page can retry it after the meeting.
        let saved = false;
        try {
          await savePending({ meetingId, src, t, wav, error: e.message });
          saved = true;
        } catch {}
        const note = saved ? 'audio kept, will retry after the meeting' : 'audio could not be kept';
        chrome.runtime.sendMessage({ target: 'bg', type: 'stt-error', meetingId, error: `[${Math.round(t)}s ${src}] ${e.message} (${note})` });
      }
    });

  // A silent chunk is dropped without any transcript, so say so instead of failing quietly.
  const onSkip = (src, t, peak) =>
    chrome.runtime.sendMessage({
      target: 'bg',
      type: 'dbg',
      meetingId,
      note: `[${Math.round(t)}s ${src}] chunk skipped as silent (peak ${peak.toFixed(4)}, needs 0.012)`,
    });

  rec = { tabStream, micStream, playCtx, ctx, pool, micOn: !!micStream, chunkers: {} };
  rec.chunkers.others = new Chunker('others', onChunk, chunkSize(settings, onSkip));
  await tap(ctx, tabStream, (b) => {
    rec?.chunkers.others.push(b);
    rec?.voice?.tracker.push(b);
  });
  if (micStream) {
    rec.chunkers.me = new Chunker('me', onChunk, chunkSize(settings, onSkip));
    // While the mic is paused, feed silence so timestamps stay aligned.
    await tap(ctx, micStream, (b) => {
      if (rec) {
        let pk = 0;
        for (let i = 0; i < b.length; i += 8) pk = Math.max(pk, Math.abs(b[i]));
        rec.micRawPeak = Math.max(rec.micRawPeak || 0, pk);
        rec.micRawBlocks = (rec.micRawBlocks || 0) + 1;
      }
      rec?.chunkers.me.push(rec.micOn ? b : new Float32Array(b.length));
    });
  }

  // Voice recognition (optional): fingerprints of the other participants' speech, made here in a worker.
  // Only the fingerprints leave this document; the audio is never stored and never sent anywhere.
  if ((settings.voiceOn && (settings.voices || []).length) || settings.voiceLearn) {
    rec.voice = await startVoice(meetingId).catch(() => null);
    chrome.runtime.sendMessage({ target: 'bg', type: 'dbg', meetingId, note: rec.voice ? 'voice recognition: on' : 'voice recognition: could not start (recording continues without it)' });
  }

  // Stop if the tab stops sharing audio (tab closed or navigated away).
  tabStream.getAudioTracks()[0].addEventListener('ended', () => chrome.runtime.sendMessage({ target: 'bg', type: 'stop' }));

  // Live input levels for the popup meter (0 = dead/silent source).
  rec.levelTimer = setInterval(() => {
    if (!rec) return;
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
  rec.dbgTimer = setInterval(() => {
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
    if (n >= 24) clearInterval(rec.dbgTimer);
  }, 5000);

  return { mic: !!micStream, micError };
}

async function stop() {
  if (!rec) return;
  const r = rec;
  rec = null;
  clearInterval(r.levelTimer);
  clearInterval(r.dbgTimer);
  Object.values(r.chunkers).forEach((c) => c.flush());
  [r.tabStream, r.micStream].forEach((s) => s?.getTracks().forEach((t) => t.stop()));
  await Promise.allSettled([r.ctx.close(), r.playCtx.close()]);
  await r.pool.drain();
  if (r.voice) {
    r.voice.tracker.flush();
    await r.voice.client.drain(20000);
    clearInterval(r.voice.timer);
    r.voice.flush();
    r.voice.client.close();
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
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
  if (msg.type === 'mic') {
    if (rec) rec.micOn = !!msg.on && !!rec.micStream;
    sendResponse({ ok: true, micOn: rec?.micOn ?? false });
  }
});
