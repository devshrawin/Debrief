// Manual check against a real local Ollama (not part of `npm test`):
//   node test/local-live.mjs [model]
// Runs the real minutes pipeline with the real OpenAI-compatible client against http://localhost:11434/v1.
import { DEFAULTS } from '../src/store.js';
import { generate } from '../src/llm.js';
import { writeMinutes } from '../src/minutes.js';
import { listOllamaModels, ollamaContext, contextAdvice, OLLAMA_BASE } from '../src/local.js';
import { parseDictionary } from '../src/dictionary.js';

const model = process.argv[2] || 'gemma2:2b';
const found = await listOllamaModels();
console.log('models:', found.ok ? found.models.map((m) => m.name).join(', ') : found.message);
console.log('context:', contextAdvice(await ollamaContext(model)));

const talk = [
  'Aman will share the data validation sheet with the team by Friday.',
  'We decided to move the scheme master review to Tuesday next week.',
  'Priya raised a risk: the mapping file for Kerala is not yet approved, so the upload may slip.',
  'Ravi asked who owns the portal testing. Nobody confirmed yet, so it stays open.',
  'Please send the revised timeline to the client by Monday evening.',
];
const segments = [];
for (let i = 0; i < 12; i++) segments.push({ t: i * 90, src: 'others', text: `${talk[i % talk.length]} ${'We went through the current status and the open points once more. '.repeat(4)}` });
const meeting = { id: 'live', title: 'Cadence call', startedAt: Date.now() - 1100000, endedAt: Date.now(), segments };
const settings = { ...DEFAULTS, llmProvider: 'openai', oaBase: OLLAMA_BASE, oaModel: model, oaKey: '', momLanguage: 'English', dictionary: 'Amal | Aman', minutesMode: 'thorough' };

const t0 = Date.now();
const gen = (system, user, onText) => generate({ settings, system, user, onText: onText || (() => {}) });
const r = await writeMinutes({
  meeting,
  settings,
  notes: '',
  ctx: { entries: parseDictionary(settings.dictionary), attendees: ['Amal Raj', 'Priya Nair', 'Ravi Kumar'] },
  gen,
  onStatus: (t) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${t}`),
});
console.log('\n--- stats ---\n', r.stats);
console.log('\n--- checklist ---\n', r.checklist);
console.log('\n--- minutes ---\n', r.mom);
