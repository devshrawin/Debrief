"""A small OpenAI-compatible speech-to-text server for Debrief, running Whisper on this computer.

Debrief's "Whisper-compatible" speech provider posts each chunk of audio to POST /v1/audio/transcriptions. This server
answers that, using faster-whisper (CTranslate2) on the CPU, so no audio leaves the machine.

Models (the name Debrief sends as "model"):
  small      Whisper small, multilingual (English, Hindi, ...). Fast enough on a laptop CPU.
  malayalam  A Malayalam fine-tune (thennal/whisper-medium-ml, converted to CTranslate2). Slower, far better Malayalam.
  auto       Runs "small" first; if it hears Malayalam it runs "malayalam" instead. The default for mixed meetings.
Any other name is passed to faster-whisper as it is (a model size such as "base" or "medium", or a folder path).

Run:  python whisper_server.py            (port 8000, Debrief's default)
Env:  PORT, STT_CPU_THREADS (default 4), WHISPER_SMALL (folder or size), WHISPER_ML_DIR (folder of the Malayalam model),
      WHISPER_LANGS (languages meetings may use, default en,hi,ml: the model only picks among these)
"""
import io
import os
import re
import threading
import time
import zlib
from pathlib import Path

import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse

THREADS = int(os.environ.get("STT_CPU_THREADS", "4"))
LANGS = [x.strip() for x in os.environ.get("WHISPER_LANGS", "en,hi,ml").split(",") if x.strip()]
HOME = Path.home()


def _find_small():
    """The faster-whisper 'small' model from the Hugging Face cache if it is there (no network), else its name."""
    env = os.environ.get("WHISPER_SMALL")
    if env:
        return env
    snaps = HOME / ".cache" / "huggingface" / "hub" / "models--Systran--faster-whisper-small" / "snapshots"
    if snaps.exists():
        for d in sorted(snaps.iterdir()):
            if (d / "model.bin").exists():
                return str(d)
    return "small"


def _find_ml():
    env = os.environ.get("WHISPER_ML_DIR")
    cands = [Path(env)] if env else []
    cands += [Path(__file__).resolve().parent / "models" / "malayalam", HOME / "Desktop" / "UR Files" / "Projects" / "MalayalamScribe" / "data" / "whisper" / "ml"]
    for c in cands:
        if (c / "model.bin").exists():
            return str(c)
    return None


MODELS = {"small": _find_small(), "malayalam": _find_ml()}
_loaded = {}
_load_lock = threading.Lock()
_run_lock = threading.Lock()  # one transcription at a time: a laptop CPU does not gain from running two


def get_model(name):
    from faster_whisper import WhisperModel

    key = {"ml": "malayalam"}.get(name, name)
    path = MODELS.get(key, key)
    if path is None:
        raise ValueError("The Malayalam model was not found. Set WHISPER_ML_DIR to its folder.")
    with _load_lock:
        if path not in _loaded:
            t = time.time()
            _loaded[path] = WhisperModel(path, device="cpu", compute_type="int8", cpu_threads=THREADS)
            print(f"loaded {key} ({path}) in {time.time() - t:.1f}s", flush=True)
        return _loaded[path]


def run(model, audio, language, prompt, beam):
    segs, info = model.transcribe(
        audio,
        language=language,
        initial_prompt=vocabulary_prompt(prompt),
        beam_size=beam,
        temperature=0.0,  # one pass: retries at higher temperature made bad stretches take minutes
        repetition_penalty=1.1,
        vad_filter=True,
        condition_on_previous_text=False,  # keeps one bad stretch from repeating through the chunk
    )
    return list(segs), info


def vocabulary_prompt(prompt):
    """Debrief sends its instructions to the model as the prompt ("write Hindi in Devanagari..."). Whisper does not follow
    instructions: it continues the prompt as if it were the previous sentence, and instructions like these push it into the
    wrong script. Only the list of names is useful to it, so only that is kept."""
    m = re.search(r"Names:\s*(.+)$", prompt or "", re.S)
    return m.group(1).strip()[:400] if m else None


def looped(text):
    """Whisper sometimes repeats one syllable for the whole chunk. Real speech compresses far less than that."""
    t = text.strip()
    return len(t) > 60 and len(t.encode("utf-8")) / max(1, len(zlib.compress(t.encode("utf-8")))) > 4.5


def candidates(model, audio, allowed):
    """Which language to try first, then the other. Whisper's own guess can be any of 99 languages and is often wrong for
    Indian-accented English or mixed speech, so the choice is only among the meeting languages, and Hindi or Malayalam
    must be clearly more likely than English to win. English is the safe default: its transcript is readable even when
    some Hindi words are mangled, while a wrong Hindi guess turns the whole chunk into noise."""
    try:
        _, _, probs = model.detect_language(audio, vad_filter=True, language_detection_segments=3)
        p = {l: v for l, v in probs}
    except Exception:  # noqa: BLE001
        p = {}
    en, hi, ml = p.get("en", 0.0), p.get("hi", 0.0), p.get("ml", 0.0)
    if "ml" in allowed and ml >= 0.5 and ml > 2 * max(en, hi):
        return ["ml", "en"]
    if "hi" in allowed and hi >= 0.6 and hi > 2 * en:
        return ["hi", "en"]
    return ["en", "hi"] if "hi" in allowed else ["en"]


app = FastAPI(title="Debrief local Whisper")
# only the Debrief extension (its ID is pinned by the manifest key) may call this from a browser; other web pages are refused
app.add_middleware(CORSMiddleware, allow_origins=[], allow_origin_regex=r"chrome-extension://nckojmcchehoejdfklcmllhpekagiddo", allow_methods=["*"], allow_headers=["*"])
MAX_UPLOAD = 25 * 1024 * 1024
ALLOWED_MODELS = {"auto", "whisper-1", "", "small", "malayalam", "ml", "base", "medium", "tiny", "large-v3"}


@app.middleware("http")
async def local_only(request, call_next):
    # a web page on another site can reach 127.0.0.1 too (DNS rebinding): require a local Host name
    host = (request.headers.get("host") or "").split(":")[0]
    if host not in ("localhost", "127.0.0.1", "[::1]", ""):
        return JSONResponse({"error": {"message": "Only local requests are accepted."}}, status_code=403)
    return await call_next(request)


@app.get("/health")
def health():
    return {"ok": True, "models": {k: bool(v) for k, v in MODELS.items()}, "loaded": list(_loaded)}


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": m, "object": "model"} for m in ("auto", "small", "malayalam") if MODELS.get(m if m != "auto" else "small")]}


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...), model: str = Form("auto"), language: str = Form(None), prompt: str = Form(None), response_format: str = Form("json")):
    if model not in ALLOWED_MODELS:
        return JSONResponse({"error": {"message": f"Unknown model {model!r}. Use auto, small or malayalam."}}, status_code=400)
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        return JSONResponse({"error": {"message": "That audio is too large."}}, status_code=413)
    t0 = time.time()
    lang = (language or "").strip() or None
    try:
        from faster_whisper.audio import decode_audio

        audio = decode_audio(io.BytesIO(data), sampling_rate=16000)
        with _run_lock:
            if model in ("auto", "whisper-1", ""):
                small = get_model("small")
                # Debrief sends a language when the meetings use English plus ONE other language ("hi" for English + Hindi):
                # that means "English or this one", not "Hindi only", so it only narrows the choice.
                allowed = {"en", lang} if lang else set(LANGS)
                order = candidates(small, audio, allowed)
                segs, info, used = [], None, "small"
                for code in order[:2]:
                    # Malayalam heard (and the Malayalam model is available): that model can actually read it
                    use_ml = code == "ml" and MODELS.get("malayalam")
                    segs, info = run(get_model("malayalam") if use_ml else small, audio, code, prompt, 1)
                    used = "malayalam" if use_ml else "small"
                    if not looped(" ".join(s.text for s in segs)):
                        break
                else:
                    segs = []  # both attempts looped: better an empty chunk than a page of one syllable
            else:
                segs, info = run(get_model(model), audio, lang, prompt, 1)
                used = model
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": {"message": f"{type(e).__name__}: {e}"}}, status_code=500)
    text = " ".join(s.text.strip() for s in segs).strip()
    print(f"{used}: {info.duration:.0f}s audio -> {len(text)} chars in {time.time() - t0:.1f}s (language {info.language})", flush=True)
    if response_format == "text":
        return PlainTextResponse(text)
    body = {"text": text}
    if response_format == "verbose_json":
        body.update(language=info.language, duration=info.duration, segments=[{"start": s.start, "end": s.end, "text": s.text} for s in segs])
    return body


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print(f"Debrief local Whisper on http://localhost:{port}/v1  (models: {', '.join(k for k, v in MODELS.items() if v)})", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
