// Manual check with a real local Ollama: node test/ask-live.mjs [model]
import { DEFAULTS } from '../src/store.js';
import { generate } from '../src/llm.js';
import { askMeetings } from '../src/ask.js';
import { parseDictionary } from '../src/dictionary.js';

const model = process.argv[2] || 'gemma2:2b';
const settings = { ...DEFAULTS, llmProvider: 'openai', oaBase: 'http://localhost:11434/v1', oaModel: model, oaKey: '' };
const m = { id: 'm1', title: 'Cadence call', startedAt: Date.UTC(2026, 9, 12, 5), mom: '## Decisions\n- Scheme master review moves to Tuesday.\n\n## Action Items\n| # | Action | Owner |\n|---|---|---|\n| 1 | Share the data validation sheet | Amal Raj |', segments: [
  { t: 60, src: 'others', text: 'Aman said he will share the data validation sheet by Friday. The Kerala mapping file is not yet approved.' },
  { t: 400, src: 'others', text: 'Ravi asked who owns the portal testing. Nobody confirmed.' } ] };
for (const q of ['Who owns the portal testing?', 'Who shares the data validation sheet and by when?', 'What did we decide about the budget?']) {
  const t0 = Date.now();
  const r = await askMeetings({ question: q, meetings: [m], ctx: { entries: parseDictionary('Amal | Aman'), attendees: ['Amal Raj'] }, gen: (system, user, onText) => generate({ settings, system, user, onText: onText || (() => {}) }), onText: () => {} });
  console.log(`\nQ: ${q}  (${Math.round((Date.now() - t0) / 1000)}s)\nA: ${r.answer}\nsources: ${r.sources.map((s) => s.label).join(' | ')}`);
}
