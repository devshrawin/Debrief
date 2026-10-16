# Running Debrief with local models

**Fastest way:** the `local/` folder has a ready kit (a Whisper server for speech, a start script that also sets Ollama up, and a one-command end-to-end check). See [local/README.md](../local/README.md). The rest of this page explains the pieces.

Everything below keeps your meeting text on your own computer: no quotas, no API keys, nothing sent to Google or Anthropic. The price is quality and speed, so read the honest summary first.

| Job | Local option | What to expect |
|---|---|---|
| **Writing the minutes** | [Ollama](https://ollama.com) with Gemma, Qwen, Phi, Llama… | Good for clear English or Hinglish. Weaker than Gemini or Claude on messy Hindi or Malayalam and on long meetings. On a CPU-only PC a small model needs one to several minutes per meeting. |
| **Speech to text** | A Whisper-compatible server on your PC | Good for English and Hindi. Hinglish switching is mediocre. Malayalam needs a Malayalam fine-tuned model. |

Gemma (and other Ollama models) can only write the minutes. They cannot take the meeting audio, so speech to text needs a Whisper-style server or a cloud provider.

## 1. Minutes with Ollama

1. Install Ollama from <https://ollama.com> and pull a model. Pick one that fits your PC:
   ```bash
   ollama pull gemma3:4b
   ```
   Smaller models are faster and make more mistakes; 7B models are noticeably better and need roughly 8 GB of free RAM and patience on a CPU. Models you already have show up automatically in step 4.
2. Let the extension talk to Ollama and give it room to read a whole meeting. In PowerShell:
   ```powershell
   setx OLLAMA_ORIGINS "chrome-extension://nckojmcchehoejdfklcmllhpekagiddo"
   setx OLLAMA_CONTEXT_LENGTH 16384
   ```
   Then quit Ollama from the tray icon and start it again (these settings are only read when it starts).
   - **Why the first line:** Ollama refuses requests from browser extensions unless you allow them.
   - **Why the second:** Ollama's default context is only a few thousand tokens and it **silently cuts off** the rest of a long transcript. A one hour meeting is about 9,000 words, so use 16384 or more (more memory use).
3. In Debrief open **Settings → Minutes**, choose **OpenAI-compatible**, and press **Use Ollama on this PC**.
4. Press **Find my installed models**, pick one, and press **Save changes**. Debrief also tells you whether your context length is big enough for a long meeting.
5. Press **Test connection**. You should see `works ✓`.

**Tips**
- Set **How carefully to write the minutes** to *Quick* if it is too slow. Thorough mode makes several calls per meeting. With a local model Debrief already uses smaller reading windows.
- If the minutes look wrong or cut off, raise `OLLAMA_CONTEXT_LENGTH` first.
- Names: the dictionary and attendee list are applied before the model sees the transcript, so they help small models a lot.
- Safety nets for weaker models are on by default: invented action-item owners are dropped when the transcript does not name them, and leaked prompt text is stripped from the output.

## 2. Speech to text on your PC

Any server that offers the OpenAI-style `/v1/audio/transcriptions` endpoint works. Several open projects do (faster-whisper based servers such as Speaches, LocalAI, and whisper.cpp's server in OpenAI-compatible mode). Follow that project's own install guide; Docker is the usual route, but pip or a prebuilt binary also exist.

Then in Debrief **Settings → Speech to text**:
1. Choose **Whisper-compatible**, press **Use a local Whisper server**.
2. Set the address if your server does not use port 8000, and fill in the model name your server expects (for example a `small` or `medium` Whisper).
3. Press **Test it**, then **Save changes**.

For **Malayalam**, use a Malayalam fine-tuned Whisper model served through the same kind of server, and set *Language spoken in meetings* to *Malayalam + English* in General. For **Hindi and Hinglish**, a larger Whisper model (medium or large) is noticeably better than small.

## Troubleshooting

| Message | What to do |
|---|---|
| *Could not reach Ollama* | Ollama is not running. Start the app or run `ollama serve`. |
| *Ollama refused the extension* | Set `OLLAMA_ORIGINS=chrome-extension://*` and restart Ollama. |
| *Ollama is running but has no models yet* | `ollama pull gemma3:4b` (or any model). |
| Minutes stop halfway or miss the end of the meeting | The model's context is too small. Raise `OLLAMA_CONTEXT_LENGTH`. |
| Very slow | Use a smaller model, set minutes to *Quick*, or run it on a machine with a GPU. |
| Transcripts are garbled | The Whisper model is too small for your audio. Try a bigger one, or use Gemini for speech and Ollama only for the minutes. |

A middle path: **Gemini (free) for speech, Ollama for the minutes**. This saves a lot of free quota and gives better transcripts, but note that the audio still goes to Google, so Google still hears the meeting. Only the writing of the minutes happens on your machine. For a fully private setup both steps must be local.
