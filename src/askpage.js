import { getSettings, listMeetings } from './store.js';
import { parseDictionary } from './dictionary.js';
import { mountAsk } from './askui.js';

const $ = (id) => document.getElementById(id);

async function scoped() {
  const days = $('scope').value;
  const all = (await listMeetings()).filter((m) => m.segments?.length || m.mom);
  const cutoff = days === 'all' ? 0 : Date.now() - Number(days) * 86400000;
  return all.filter((m) => m.startedAt >= cutoff);
}

(async () => {
  const settings = await getSettings();
  const refresh = async () => {
    const n = (await scoped()).length;
    $('count').textContent = `${n} meeting${n === 1 ? '' : 's'}`;
  };
  $('scope').onchange = refresh;
  await refresh();
  mountAsk($('askBox'), {
    getMeetings: scoped,
    getCtx: () => ({ entries: parseDictionary(settings.dictionary), attendees: [], learned: (settings.learnedNames || []).slice(-40), myName: settings.myName }),
    openLink: true,
    placeholder: 'e.g. "What did we decide about the scheme master review?"',
    suggestions: ['What action items are still open?', 'What did we decide about the Kerala mapping?', 'Which risks came up recently?', 'What did Amal say about the data validation?'],
  });
})();
