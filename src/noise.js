// Gemini sometimes answers quiet or noisy audio with a loop of one short phrase ("तो तो वो तो तो वो ...").
// A real transcript never looks like that, so such replies are treated as "no speech".
export function isLoopNoise(text) {
  const words = (text || '').toLowerCase().split(/[\s,.;:!?।|-]+/).filter(Boolean);
  if (words.length < 12) return false;
  if (new Set(words).size / words.length < 0.2) return true;
  // The same 1-6 word phrase repeated back to back for most of the reply.
  for (let n = 1; n <= 6; n++) {
    let covered = 0;
    for (let i = 0; i + 2 * n <= words.length; ) {
      let reps = 1;
      while (i + (reps + 1) * n <= words.length && words.slice(i, i + n).join(' ') === words.slice(i + reps * n, i + (reps + 1) * n).join(' ')) reps++;
      if (reps >= 4) {
        covered += reps * n;
        i += reps * n;
      } else i++;
    }
    if (covered / words.length > 0.6) return true;
  }
  return false;
}
