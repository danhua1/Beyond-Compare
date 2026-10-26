import { compareDirectory } from '../core/bytes.js';
import { compareText } from '../core/diff.js';

let current = null;
let tail = Promise.resolve();
self.onmessage = ({ data }) => {
  if (!data || typeof data.id !== 'string') return;
  if (data.type === 'cancel') {
    if (current?.id === data.id) {
      current.controller.abort();
      current.clearProgress?.();
    }
    return;
  }
  if (data.type !== 'start') return;
  current?.controller.abort();
  current?.clearProgress?.();
  const job = { id: data.id, controller: new AbortController() };
  current = job;
  // Serial job handover keeps cancelled-but-still-reading jobs from exceeding
  // the global two-lane ceiling when a new input arrives.
  tail = tail.catch(() => {}).then(async () => {
    if (current !== job) return;
    const send = payload => {
      if (current === job) self.postMessage({ id: job.id, ...payload });
    };
    let pendingProgress;
    let progressTimer;
    let lastProgressAt = -Infinity;
    job.clearProgress = () => {
      clearTimeout(progressTimer);
      progressTimer = undefined;
      pendingProgress = undefined;
    };
    const flushProgress = () => {
      progressTimer = undefined;
      if (pendingProgress && current === job && !job.controller.signal.aborted) {
        send({ type: 'progress', progress: pendingProgress });
        lastProgressAt = performance.now();
      }
      pendingProgress = undefined;
    };
    const onProgress = progress => {
      if (current !== job || job.controller.signal.aborted) return;
      pendingProgress = progress;
      if (progressTimer !== undefined) return;
      const delay = 75 - (performance.now() - lastProgressAt);
      if (delay <= 0) flushProgress();
      else progressTimer = setTimeout(flushProgress, delay);
    };
    try {
      const options = { ...data.options, signal: job.controller.signal, onProgress };
      let result;
      if (data.operation === 'directory' && Array.isArray(data.left) && Array.isArray(data.right)) {
        result = await compareDirectory(data.left, data.right, options);
      } else if (data.operation === 'text') result = await compareText(data.left, data.right, options);
      else throw new Error('invalid-operation');
      job.clearProgress();
      send({ type: 'result', result });
    } catch {
      job.clearProgress();
      send({ type: 'result', result: { status: 'error', reason: 'worker-failed' } });
    } finally {
      job.clearProgress();
      if (current === job) current = null;
    }
  });
};
