// Turn a raw STT/LLM error into something worth interrupting the user for (or null for ordinary errors).
export function classifyError(err) {
  const e = String(err || '');
  const model = (e.match(/model:\s*([\w.-]+)/i) || [])[1];
  const retry = (e.match(/retry in\s*([\dhms.]+)/i) || [])[1];
  if (/API key not valid|API_KEY_INVALID|\b(401|403)\b/i.test(e)) {
    return {
      kind: 'key',
      title: 'API key rejected',
      detail: 'Google says the key is invalid or lacks access. Check it in Debrief settings. Audio is kept and will retry.',
    };
  }
  if (/\b429\b|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(e)) {
    const reset = retry ? `, resets in about ${retry.replace(/\.\d+s?$/, '')}` : '';
    return {
      kind: 'quota',
      title: 'API limit reached',
      detail: `${model ? `${model}: ` : ''}free-tier limit used up${reset}. Debrief tries other models first; chunks that still fail are kept and retried from the MOM page.`,
    };
  }
  return null;
}
