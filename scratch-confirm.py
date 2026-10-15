ROOT = r'C:\Users\shrawin.sisodiya\Desktop\UR Files\Projects\Debrief Pro' + '\\'


def ed(p, f):
    s = open(ROOT + p, encoding='utf-8', newline='').read()
    t = f(s)
    assert t != s, p
    open(ROOT + p, 'w', encoding='utf-8', newline='').write(t)


def rep(s, a, b):
    assert a in s, a[:90]
    return s.replace(a, b, 1)


# a voice the user has named is confirmed: usable at once, no need to wait for two meetings
ed('src/voice/learn.js', lambda s: rep(s, "export const usableVoices = (people) => (people || []).filter((p) => !p.auto || p.ready);",
    "// A learned voice is used once it has enough speech from enough meetings, or as soon as the user has named it (the\n// user's naming is the confirmation that the group is one person).\nexport const usableVoices = (people) => (people || []).filter((p) => !p.auto || p.ready || p.confirmed);"))


def ui(s):
    s = rep(s, "  return p.ready ? ['Learned, in use', 'ok'] : ['Learned, still learning', 'warn'];", "  if (p.confirmed) return ['Named by you, in use', 'ok'];\n  return p.ready ? ['Learned, in use', 'ok'] : ['Learned, still learning', 'warn'];")
    s = rep(s, "    people = people.map((x) => (x.id === p.id ? { ...x, name: clean } : x));\n    await saveVoices(people);\n    deleteSample(p.id).catch(() => {}); // named now: the clip is no longer kept\n    renderList();",
            "    // naming a learned voice confirms it: it is used from now on, including for meetings already recorded\n    people = people.map((x) => (x.id === p.id ? { ...x, name: clean, ...(x.auto ? { confirmed: true } : {}) } : x));\n    await saveVoices(people);\n    deleteSample(p.id).catch(() => {}); // named now: the clip is no longer kept\n    renderList();\n    const st = await getSettings();\n    if (!st.voiceOn) {\n      const on = await modal({ text: `${clean} is saved. Naming speakers by voice is switched off, so transcripts and minutes will not use the name yet. Turn it on?`, buttons: [{ label: 'Not now', value: 'no' }, { label: 'Turn on', value: 'yes', primary: true }] });\n      if (on?.value === 'yes') await setSetting({ voiceOn: true });\n    }")
    s = rep(s, "import { getVoices, saveVoices,", "import { getSettings, setSetting, getVoices, saveVoices,")
    return s


ed('src/voices-ui.js', ui)


def mom(s):
    # when voices change (named, merged, deleted) while a meeting is open, show the new names and say what to press
    return rep(s, "$('gen').onclick = () => runGenerate();", """$('gen').onclick = () => runGenerate();
chrome.storage.onChanged.addListener(async (c) => {
  if (!c.voices && !c.settings) return;
  try {
    settings = await getSettings();
    labelCache.key = '';
    if (typeof renderTranscript === 'function') renderTranscript();
    if (c.voices && meeting?.mom && !abortCtl && labeledLines()) $('genStatus').textContent = 'Voices changed since these minutes were written. Press Regenerate to use the names.';
  } catch {}
});""")


ed('src/mom.js', mom)
print('ok')
