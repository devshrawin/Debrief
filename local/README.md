# Debrief with no cloud: Ollama + local Whisper

Everything stays on this computer: the audio is turned into text by a Whisper model on your CPU, and the minutes are written by a model in Ollama. No API key, no quota, nothing sent to Google or Anthropic. Voice recognition and the clips were already local.

What is in this folder

| File | What it does |
|---|---|
| `start-local.bat` / `start-local.ps1` | Starts Ollama (with the settings Debrief needs) and the Whisper server, then prints what to set in Debrief |
| `whisper_server.py` | The speech-to-text server (OpenAI-compatible, on `http://localhost:8000/v1`), using faster-whisper |
| `check-local.mjs` | Runs a piece of your own audio through both services with Debrief's own code, and times it |

## One-time setup (about 10 minutes)

1. **Ollama.** Install it from <https://ollama.com>, then get a model for the minutes. `qwen2.5:7b` gave the best minutes here; `qwen3:4b` and `phi4-mini` are faster and a bit weaker.
   ```
   ollama pull qwen2.5:7b
   ```
2. **Whisper.** `start-local.ps1` looks for a Python that has `faster-whisper`, `fastapi`, `uvicorn` and `python-multipart`. If it finds none it offers to build `local\.venv` for you (about 150 MB, and the "small" Whisper model, about 460 MB, downloads on first use). Nothing is downloaded without your yes.
   - For **Malayalam**, put a Malayalam CTranslate2 Whisper model in `local\models\malayalam` (a folder with `model.bin`), or set `WHISPER_ML_DIR`. On this computer the `thennal/whisper-medium-ml` model from your MalayalamScribe project is found automatically.
3. **Start everything.** Double-click `local\start-local.bat`. If Ollama was already running it will say Ollama refuses browser extensions: run it once as `start-local.bat -RestartOllama`, or quit Ollama from the tray and run it again. To make this permanent, run in PowerShell, then restart Ollama:
   ```
   setx OLLAMA_ORIGINS "chrome-extension://*"
   setx OLLAMA_CONTEXT_LENGTH 16384
   ```
   (Ollama's default context is only 4096 tokens, which silently cuts a long transcript.)

## Set Debrief to use them (Settings)

- **Speech to text:** provider *Whisper-compatible* → **Use a local Whisper server**. Model: `auto` (picks the model by the language it hears). Address `http://localhost:8000/v1`. Chrome asks once to allow `localhost`: say yes. **Test it**, then **Save changes**.
- **Minutes:** provider *OpenAI-compatible* → **Use Ollama on this PC** → **Find my installed models** → choose the model → **Test connection**. Set *How carefully* to **Quick** on a laptop without a graphics card.
- **General → Languages spoken in meetings:** for example English + Hindi, or English + Malayalam.

## Check the whole chain

```
node local\check-local.mjs "my-recording-16k.wav" --start 0 --seconds 60 --model qwen2.5:7b
```
The recording must be a 16 kHz mono WAV (`ffmpeg -i in.m4a -ar 16000 -ac 1 out.wav`). It tests both services, transcribes a minute of your audio, writes the minutes from it and prints the timings. Add `--stt-only` to skip the minutes, `--full` for thorough minutes.

## What to expect (measured on an Intel Core 3 100U laptop, 16 GB, no graphics card)

| Step | Result |
|---|---|
| Speech to text, English with an Indian accent | about 0.3 x real time (a 100 s chunk takes about 30 s), good text |
| Speech to text, Malayalam (Malayalam model) | about 0.9 x real time, and the text is short and phonetic compared with Gemini |
| Minutes (qwen2.5:7b, quick mode) | 70 s for the minutes of a 1-minute stretch; expect many minutes for a long meeting, and thorough mode makes several such calls |

Honest limits:
- **Whisper "small" is weaker than Gemini** on Hindi and Hinglish. The server therefore only picks Hindi or Malayalam when the audio is clearly that language, and otherwise reads it as English, because a wrong Hindi guess turns a whole chunk into noise. Hindi-speaking stretches will come out as mangled English.
- **It is not real time on a slow CPU for Malayalam**, and the server handles one chunk at a time.
- **Quality of the minutes** depends on the model. A 7B model writes decent minutes of clear English and misses more in messy Hindi or Malayalam than Gemini or Claude.
- **Hybrid option that still saves most of the quota:** Gemini (free) for speech and Ollama for the minutes, or local Whisper for speech and Gemini for the minutes (then only the text leaves the computer, not the audio).
