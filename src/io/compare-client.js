export class CompareClient {
  constructor(worker = new Worker(new URL('../workers/compare-worker.js', import.meta.url), { type: 'module' })) {
    this.worker = worker;
    this.sequence = 0;
    this.pending = null;
    this.disposed = false;
    worker.onmessage = ({ data }) => {
      const pending = this.pending;
      if (!pending || data?.id !== pending.id) return;
      if (data.type === 'progress') pending.onProgress?.(data.progress);
      if (data.type === 'result') {
        this.pending = null;
        pending.resolve(data.result);
      }
    };
    worker.onerror = event => {
      event.preventDefault?.();
      this.settle({ status: 'error', reason: 'worker-failed' });
      this.dispose();
    };
    worker.onmessageerror = () => {
      this.settle({ status: 'error', reason: 'worker-message-failed' });
      this.dispose();
    };
  }

  settle(result) {
    const pending = this.pending;
    this.pending = null;
    pending?.resolve(result);
  }

  start(operation, left, right, { onProgress, ...options } = {}) {
    if (this.disposed) return Promise.resolve({ status: 'error', reason: 'worker-disposed' });
    this.cancel();
    const id = `compare-${++this.sequence}`;
    return new Promise(resolve => {
      this.pending = { id, resolve, onProgress };
      try { this.worker.postMessage({ type: 'start', id, operation, left, right, options }); }
      catch { this.settle({ status: 'error', reason: 'worker-message-failed' }); }
    });
  }

  cancel() {
    if (!this.pending) return;
    try { this.worker.postMessage({ type: 'cancel', id: this.pending.id }); }
    catch { /* The caller still receives a terminal cancellation result. */ }
    finally { this.settle({ status: 'cancelled', reason: 'cancelled' }); }
  }

  dispose() {
    this.cancel();
    this.disposed = true;
    this.worker.terminate();
  }
}
