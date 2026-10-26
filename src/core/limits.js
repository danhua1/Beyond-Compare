export const LIMITS = Object.freeze({
  files: 20000,
  fileBytes: 50 * 1024 * 1024,
  chunkBytes: 1024 * 1024,
  concurrency: 2,
  textBytes: 2 * 1024 * 1024,
  lines: 20000,
  diffWork: 2000000,
});

// Callers may lower budgets (including to zero), never raise the hard ceilings.
export function budget(options, name) {
  const value = options && options[name];
  return Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, LIMITS[name]) : LIMITS[name];
}

export const turn = () => new Promise(resolve => setTimeout(resolve, 0));
export const cancelled = signal => Boolean(signal && signal.aborted);
