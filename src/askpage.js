import { getSettings, listMeetings, llmReady } from './store.js';
import { parseDictionary } from './dictionary.js';
import { modelLabel } from './llm.js';
import { mountAsk } from './askui.js';

const $ = (id) => document.getElementById(id);

async function scoped() {
  const days = $('scope').value;
  const all = (await listMeetings()).filter((m) => m.segments?.length || m.mom);
  const cutoff = days === 'all' ? 0 : Date.now() - Number(days) * 86400000;
  return all.filter((m) => m.startedAt >= cutoff);
}

// Seconds of speech on record for a meeting: its length, or the last line's time when it never got an end time.
const seconds = (m) => (m.endedAt ? (m.endedAt - m.startedAt) / 1000 : Math.max(0, ...(m.segments || []).map((s) => s.t || 0)));
const span = (sec) => {
  const min = Math.round(sec / 60);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
};

(async () => {
  const settings = await getSettings();
  if (llmReady(settings)) $('modelName').textContent = modelLabel(settings);
  const refresh = async () => {
    const list = await scoped();
    const n = list.length;
    const total = list.reduce((a, m) => a + seconds(m), 0);
    $('count').textContent = `${n} meeting${n === 1 ? '' : 's'}${total >= 60 ? `, ${span(total)} of transcript` : ''}`;
  };
  $('scope').onchange = refresh;
  await refresh();
  mountAsk($('askBox'), {
    large: true,
    getMeetings: scoped,
    getCtx: () => ({ entries: parseDictionary(settings.dictionary), attendees: [], learned: (settings.learnedNames || []).slice(-40), myName: settings.myName }),
    openLink: true,
    placeholder: 'e.g. "What did we decide about the scheme master review?"',
    suggestions: ['What action items are still open?', 'What did we decide about the Kerala mapping?', 'Which risks came up recently?', 'What did Amal say about the data validation?'],
  });
})();
