// Which meetings "Ask your meetings" searches: everything, the last N days, a date range, or meetings picked by hand.
// Pure functions, so every rule is unit-tested.

const DAY = 86400000;

// "2026-10-14" -> start of that day on the user's clock
export const dayStart = (iso) => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN;
};

// scope: { mode: 'all' | 'days' | 'range' | 'pick', days, from, to, ids }
export function filterByScope(meetings, scope = { mode: 'all' }, now = Date.now()) {
  const usable = (meetings || []).filter((m) => m.segments?.length || m.mom);
  const when = (m) => m.startedAt || 0;
  switch (scope.mode) {
    case 'days': {
      const cutoff = now - Number(scope.days || 0) * DAY;
      return usable.filter((m) => when(m) >= cutoff);
    }
    case 'range': {
      const from = dayStart(scope.from);
      const to = dayStart(scope.to);
      return usable.filter((m) => (Number.isNaN(from) || when(m) >= from) && (Number.isNaN(to) || when(m) < to + DAY));
    }
    case 'pick': {
      const ids = new Set(scope.ids || []);
      return usable.filter((m) => ids.has(m.id));
    }
    default:
      return usable;
  }
}

// One line saying what is being searched, for the count under the selector.
export function describeScope(scope = { mode: 'all' }) {
  if (scope.mode === 'days') return `the last ${scope.days} days`;
  if (scope.mode === 'range') return scope.from && scope.to ? `${scope.from} to ${scope.to}` : scope.from ? `from ${scope.from}` : scope.to ? `up to ${scope.to}` : 'all dates';
  if (scope.mode === 'pick') return `${(scope.ids || []).length} picked`;
  return 'all meetings';
}
