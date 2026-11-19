// Wait for a promise, but never longer than `ms`: resolves to `fallback` when the time is up (the promise itself is left running).
export function withTimeout(promise, ms, fallback) {
  let t;
  const timer = new Promise((resolve) => {
    t = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([Promise.resolve(promise).finally(() => clearTimeout(t)), timer]);
}
