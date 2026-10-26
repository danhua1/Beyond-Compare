async function runBrowserTests({ forceFail = false, forceTimeout = false } = {}) {
  if (forceTimeout) await new Promise(() => {});
  let assertions = 0;
  const ok = (condition, message) => {
    assertions++;
    if (!condition) throw new Error(`Browser assertion ${assertions}: ${message}`);
  };
  const waitFor = async predicate => {
    const end = Date.now() + 8000;
    while (!predicate()) {
      if (Date.now() > end) throw new Error('Browser condition timeout');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  ok(!forceFail, 'forced failure proves nonzero exit');
  await waitFor(() => document.documentElement.dataset.ready === 'true');
  ok(document.title.includes('本地文件比较'), 'real page title');
  ok(document.querySelector('script[type="module"]').src.endsWith('/src/main.js'), 'ES module loaded');
  const button = document.querySelector('#self-test');
  ok(button && !button.disabled, 'accessible self-test button');
  button.click();
  await waitFor(() => document.querySelector('#status').textContent.includes('自检通过'));
  ok(document.querySelector('#cancel').disabled, 'self-test finished in real Worker');
  button.click(); document.querySelector('#cancel').click();
  await new Promise(resolve => setTimeout(resolve, 80));
  ok(document.querySelector('#status').textContent.startsWith('已取消'), 'UI cancellation cannot be overwritten');

  const loadInput = (selector, contents, name) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([contents], name));
    const input = document.querySelector(selector);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  loadInput('#left-file', 'before\n', 'note.txt');
  loadInput('#right-file', 'after\n', 'note.txt');
  document.querySelector('#compare').click();
  await waitFor(() => document.querySelector('#text-detail').hidden === false &&
    document.querySelector('#detail-status').textContent.includes('差异区块'));
  ok(document.querySelector('#diff-body tr')?.textContent.includes('before') &&
    document.querySelector('#diff-body tr')?.textContent.includes('after'), 'selected files render paired text diff');

  const $ = selector => document.querySelector(selector);
  // These actions are intentionally synchronous: no Worker completion can race the assertions.
  $('#compare').click();
  ok($('#self-test').disabled && $('#compare').disabled && !$('#cancel').disabled, 'comparison locks self-test and compare');
  $('#self-test').click(); $('#cancel').click();
  ok(!$('#compare').disabled && !$('#self-test').disabled && $('#cancel').disabled, 'cancel restores input-aware controls');
  $('#self-test').click();
  ok($('#compare').disabled, 'self-test also locks comparison');
  ok($('#ignore-whitespace').disabled && $('#ignore-eol').disabled, 'self-test locks both text rules');
  const oldRule = $('#ignore-whitespace').checked;
  $('#ignore-whitespace').click();
  ok($('#ignore-whitespace').checked === oldRule, 'disabled rule cannot silently change during self-test');
  await waitFor(() => $('#status').textContent.includes('自检通过'));
  ok(!$('#compare').disabled && $('#cancel').disabled, 'self-test after cancellation restores compare');
  ok(!$('#ignore-whitespace').disabled && !$('#ignore-eol').disabled, 'self-test restores rule controls');
  $('#compare').click();
  await waitFor(() => !$('#compare').disabled);
  ok($('#detail-status').textContent.includes('差异区块'), 'compare/cancel/self-test/compare completes');

  loadInput('#left-file', 'a b', 'rules.txt'); loadInput('#right-file', 'ab', 'rules.txt');
  $('#compare').click(); await waitFor(() => !$('#compare').disabled);
  ok($('#detail-status').textContent.includes('1 个差异区块'), 'strict whitespace difference displayed');
  $('#ignore-whitespace').click(); await waitFor(() => !$('#compare').disabled);
  ok($('#detail-status').textContent.includes('0 个差异区块'), 'unlocked rule immediately recomputes detail');
  $('#ignore-whitespace').click(); await waitFor(() => !$('#compare').disabled);

  const mode = value => {
    const input = $(`input[name="mode"][value="${value}"]`);
    input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const loadDirectory = (side, entries) => {
    const transfer = new DataTransfer();
    for (const [name, contents] of entries) {
      const file = new File([contents], name);
      Object.defineProperty(file, 'webkitRelativePath', { value: `root/${name}` });
      transfer.items.add(file);
    }
    const input = $(`#${side}-directory`);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  mode('directory');
  const directoryFiles = [['A.txt', 'A\n'.repeat(250)], ['B.txt', 'B\n'.repeat(1000)],
    ['C.txt', 'current-C'], ['D.bin', new Uint8Array([0, 1])],
    ...Array.from({ length: 101 }, (_, i) => [`extra-${String(i).padStart(3, '0')}`, ''])];
  loadDirectory('left', directoryFiles); $('#compare').click();
  await waitFor(() => !$('#results').hidden && $('#cancel').disabled);
  ok($('#page-label').textContent === '1 / 2', 'directory results paginated');
  $('#next-page').click(); ok($('#page-label').textContent === '2 / 2', 'directory next page');
  $('#previous-page').click();
  const openDetail = name => {
    const row = [...document.querySelectorAll('#results-body tr')].find(row => row.cells[0].textContent === name);
    row.querySelector('button').click();
  };
  openDetail('A.txt');
  ok($('#self-test').disabled, 'detail disables self-test');
  await waitFor(() => !$('#compare').disabled);
  ok($('#diff-body').textContent.includes('A') && $('#diff-page-label').textContent === '1 / 3', 'A detail has paginated content');
  $('#next-diff-page').click(); ok($('#diff-page-label').textContent === '2 / 3', 'detail next page');
  openDetail('B.txt');
  ok($('#detail-title').textContent.includes('B.txt') && $('#diff-body').children.length === 0, 'B loading clears A before any asynchronous work');
  ok($('#next-diff-page').disabled && $('#previous-diff-page').disabled && !$('#diff-page-label').textContent, 'loading clears and disables pagination');
  $('#next-diff-page').click(); $('#cancel').click();
  ok($('#detail-status').textContent.includes('已取消') && $('#diff-body').children.length === 0, 'cancelled B detail is explicit and empty');
  await new Promise(resolve => setTimeout(resolve, 100));
  ok($('#detail-status').textContent.includes('已取消') && $('#diff-body').children.length === 0 && $('#next-diff-page').disabled, 'old B cannot restore loading or content');
  openDetail('A.txt'); openDetail('B.txt'); openDetail('C.txt');
  await waitFor(() => !$('#compare').disabled);
  ok($('#detail-title').textContent.includes('C.txt') && $('#diff-body').textContent === 'current-C', 'rapid A/B/C shows only C');
  ok($('#diff-page-label').textContent === '1 / 1' && $('#next-diff-page').disabled, 'rapid switch resets detail page');
  openDetail('D.bin');
  await waitFor(() => !$('#compare').disabled);
  ok($('#detail-status').textContent.includes('二进制文件') && $('#diff-body').children.length === 0, 'failed detail never retains old text');
  $('#path-filter').value = 'extra-100'; $('#path-filter').dispatchEvent(new Event('input'));
  await waitFor(() => $('#page-label').textContent === '1 / 1');
  ok($('#results-body').rows.length === 1 && $('#results-body').textContent.includes('extra-100'), 'debounced path filter finds cached lowercase path');
  $('#path-filter').value = ''; $('#status-filter').dispatchEvent(new Event('change'));
  ok($('#results-body').rows.length === 100, 'status change immediately applies latest path query');
  openDetail('B.txt');
  $('#path-filter').value = 'obsolete'; $('#path-filter').dispatchEvent(new Event('input'));
  loadDirectory('right', [['replacement', '']]);
  ok($('#text-detail').hidden && $('#results').hidden && !$('#compare').disabled, 'input change cancels and invalidates details');
  ok($('#results-body').children.length === 0 && $('#results-summary').textContent === '', 'input change releases old result DOM and summary');
  $('#compare').click(); mode('file');
  await new Promise(resolve => setTimeout(resolve, 100));
  ok($('#compare').disabled && $('#cancel').disabled && !$('#self-test').disabled && $('#results').hidden, 'mode change invalidates in-flight comparison');
  ok($('#results-body').children.length === 0 && $('#page-label').textContent === '', 'pending debounce cannot restore cleared results after mode change');
  $('#path-filter').value = '';

  const { CompareClient } = await import('/src/io/compare-client.js');
  const { entriesFromFiles } = await import('/src/io/files.js');
  const { decodeText } = await import('/src/core/text.js');
  const { diffLines } = await import('/src/core/diff.js');
  const { LIMITS } = await import('/src/core/limits.js');
  const client = new CompareClient();
  const file = (text, name = 'fixture.txt') => new File([text], name);
  const entry = (path, text = '') => ({ path, file: file(text) });
  try {
    let progress = 0;
    const left = [entry('空'), entry('中文/深层/同名.txt', 'a'), entry('same-size', 'abc'), entry('left'), entry('size', 'a')];
    const right = [entry('空'), entry('中文/深层/同名.txt', 'a'), entry('same-size', 'abd'), entry('right'), entry('size', 'ab')];
    const result = await client.start('directory', left, right, { onProgress: () => progress++ });
    ok(result.status === 'complete', 'Worker directory completed');
    ok(result.counts.same === 2 && result.counts.different === 2, 'same-size differences and empty/Chinese files');
    ok(result.counts['left-only'] === 1 && result.counts['right-only'] === 1, 'both one-sided states');
    ok(progress > 0, 'Worker progress received');
    const bytes = new Uint8Array(LIMITS.chunkBytes + 9);
    const large = [{ path: 'chunk', file: file(bytes) }];
    const streamed = await client.start('directory', large, large);
    ok(streamed.counts.same === 1, 'real File multi-chunk read');
    const { compareBytes } = await import('/src/core/bytes.js');
    const slices = [];
    const observedFile = { size: bytes.length, slice(start, end) {
      slices.push([start, end]); return large[0].file.slice(start, end);
    } };
    ok((await compareBytes(observedFile, large[0].file)).status === 'same', 'direct read observation preserves result');
    ok(slices.length === 2 && slices.every(([a, b]) => b - a <= LIMITS.chunkBytes) && slices.at(-1)[1] === bytes.length,
      'chunk ceiling observed independently of throttled progress');
    const hugeFile = file(new Uint8Array(LIMITS.fileBytes + 1));
    const huge = await client.start('directory', [{ path: 'large', file: hugeFile }], [{ path: 'large', file: hugeFile }]);
    ok(huge.rows[0].reason === 'file-limit' && huge.counts.same === 0, '50MiB limit not same');
    const many = Array.from({ length: LIMITS.files + 1 }, (_, i) => ({ path: `nested/${i}`, file: left[0].file }));
    const limited = await client.start('directory', many, many);
    ok(limited.rows.length === 0 && limited.reason === 'directory-limit', 'directory overflow explicitly rejected before pairing');
    ok(limited.counts.same === 0 && limited.status === 'limited', 'directory budget honest status');
    const duplicate = await client.start('directory', [entry('a'), entry('a')], []);
    ok(duplicate.rows[0].status === 'error', 'duplicate paths error');

    const originalA = 'a b\r\n\r\n尾'; const originalB = 'ab\n\n尾\n';
    const strict = await client.start('text', file(originalA), file(originalB));
    ok(strict.status === 'ok' && strict.differenceCount > 0, 'strict raw newline comparison');
    const ignored = await client.start('text', file(originalA), file(originalB), { ignoreWhitespace: true, ignoreEol: true });
    ok(ignored.status === 'ok' && ignored.differenceCount === 0, 'text ignore rules');
    for (const [side, original] of [['left', originalA], ['right', originalB]]) {
      ok(ignored.rows.map(row => row[side]?.raw || '').join('') === original, `${side} exact reconstruction`);
      for (const row of ignored.rows) if (row[side]) {
        ok(original.slice(row[side].start, row[side].end) === row[side].raw, `${side} offset mapping`);
      }
    }
    const utf16 = await client.start('text', file(new Uint8Array([0xfe, 0xff, 0x4e, 0x2d])), file('中'));
    ok(utf16.status === 'ok' && utf16.left.encoding === 'utf-16be' && utf16.differenceCount === 0, 'real File UTF16BE');
    const le = await client.start('text', file(new Uint8Array([0xff, 0xfe, 0x2d, 0x4e])), file('中'));
    ok(le.left.encoding === 'utf-16le' && le.differenceCount === 0, 'real File UTF16LE');
    ok(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 65])).text === 'A', 'UTF8 BOM');
    for (const [bytes, reason] of [[new Uint8Array([0]), 'binary'], [new Uint8Array([0xc3, 0x28]), 'invalid-encoding']]) {
      const unsupported = await client.start('text', file(bytes), file(''));
      ok(unsupported.reason === reason && unsupported.status === 'uncompared', reason);
    }
    const textLimit = await client.start('text', file(new Uint8Array(LIMITS.textBytes + 1)), file(''));
    ok(textLimit.reason === 'text-limit' && !textLimit.rows, 'text size limit');
    const lineLimit = await client.start('text', file('x\n'.repeat(20001)), file(''));
    ok(lineLimit.reason === 'line-limit' && !lineLimit.rows, 'line count limit');
    const workLimit = await client.start('text', file('a\n'.repeat(100)), file('b\n'.repeat(100)), { diffWork: 50 });
    ok(workLimit.reason === 'diff-budget' && !workLimit.rows, 'diff compute limit no partial success');
    const single = await client.start('text', null, file('one\n'));
    ok(single.rows[0].kind === 'insert', 'single side read API');
    for (const [a, b, kind] of [['a', '', 'delete'], ['', 'a', 'insert'], ['a', 'b', 'replace']]) {
      ok((await diffLines(a, b)).rows[0].kind === kind, `diff ${kind}`);
    }
    const distant = Array.from({ length: 20000 }, (_, i) => `line-${i}\n`).join('');
    const changedDistant = distant.replace('line-100\n', 'change-a\n').replace('line-19900\n', 'change-b\n');
    const sparse = await client.start('text', file(distant), file(changedDistant));
    ok(sparse.status === 'ok' && sparse.differenceCount === 2, 'real Worker computes distant changes at 20000-line ceiling');
    ok(sparse.rows.map(row => row.left?.raw || '').join('') === distant &&
      sparse.rows.map(row => row.right?.raw || '').join('') === changedDistant, 'sparse Worker preserves both original mappings');
    const slow = client.start('text', file('a\n'.repeat(1000)), file('b\n'.repeat(1000)));
    const fresh = client.start('directory', [entry('new', 'z')], [entry('new', 'z')]);
    ok((await slow).status === 'cancelled', 'superseded request resolves cancelled');
    const freshResult = await fresh;
    ok(freshResult.counts.same === 1 && freshResult.rows[0].path === 'new', 'old result cannot overwrite new task');
    const pending = client.start('directory', large, large); client.cancel();
    ok((await pending).status === 'cancelled', 'explicit client cancel');

    const malicious = '<img src=x onerror="globalThis.injected=true">.txt';
    const unsafe = await client.start('directory', [entry(malicious, '<script>bad</script>')], []);
    ok(unsafe.rows[0].path === malicious && unsafe.rows[0].status === 'left-only', 'hostile filename remains data');
    const node = document.createElement('pre'); node.textContent = unsafe.rows[0].path;
    document.body.append(node);
    ok(!node.querySelector('img') && !globalThis.injected, 'textContent prevents injection'); node.remove();
    const selected = file('fixture', '中文.txt');
    Object.defineProperty(selected, 'webkitRelativePath', { value: '所选根/嵌套/中文.txt' });
    ok(entriesFromFiles([selected], { directory: true })[0].path === '嵌套/中文.txt', 'real File directory adapter');
  } finally { client.dispose(); }

  // Test the raw Worker cancel protocol too, not just client-side suppression.
  const raw = new Worker('/src/workers/compare-worker.js', { type: 'module' });
  try {
    const rawResult = new Promise((resolve, reject) => {
      raw.onerror = () => reject(new Error('raw Worker failed'));
      raw.onmessage = ({ data }) => { if (data.type === 'result') resolve(data); };
    });
    const f = file(new Uint8Array(3 * LIMITS.chunkBytes));
    raw.postMessage({ type: 'start', id: 'cancel-raw', operation: 'directory', left: [{ path: 'x', file: f }], right: [{ path: 'x', file: f }] });
    raw.postMessage({ type: 'cancel', id: 'cancel-raw' });
    const result = await rawResult;
    ok(result.id === 'cancel-raw' && result.result.status === 'cancelled', 'Worker processes cancel message');
    ok(result.result.counts.same === 0 && result.result.rows[0].reason === 'cancelled', 'raw cancelled read not same');
  } finally { raw.terminate(); }

  let progressReport;
  const progressWorker = new Worker('/src/workers/compare-worker.js', { type: 'module' });
  try {
    const messages = [];
    const complete = new Promise((resolve, reject) => {
      progressWorker.onerror = () => reject(new Error('progress Worker failed'));
      progressWorker.onmessage = ({ data }) => { messages.push(data); if (data.type === 'result') resolve(data.result); };
    });
    const many = Array.from({ length: 10000 }, (_, i) => ({ path: `small/${i}`, file: file('') }));
    const started = performance.now();
    progressWorker.postMessage({ type: 'start', id: 'progress', operation: 'directory', left: many, right: [] });
    const result = await complete;
    const elapsed = performance.now() - started;
    const progress = messages.filter(m => m.type === 'progress').length;
    progressReport = { files: many.length, elapsedMs: +elapsed.toFixed(2), progressMessages: progress, unthrottledMessages: many.length };
    ok(result.status === 'complete' && result.counts['left-only'] === 10000, 'throttling preserves exact final counts');
    ok(progress > 0 && progress <= Math.ceil(elapsed / 75) + 1 && progress < 100, '10000 small files produce bounded cross-thread progress');
    const count = messages.length;
    await new Promise(resolve => setTimeout(resolve, 120));
    ok(messages.length === count && messages.at(-1).type === 'result', 'no delayed progress after result');
  } finally { progressWorker.terminate(); }

  const handover = new Worker('/src/workers/compare-worker.js', { type: 'module' });
  try {
    let cancelled = false; let freshFinished = false; let lateOldMessages = 0;
    const result = new Promise((resolve, reject) => {
      handover.onerror = () => reject(new Error('handover Worker failed'));
      handover.onmessage = ({ data }) => {
        if (data.id === 'old-many') {
          if (freshFinished) lateOldMessages++;
          if (!cancelled && data.type === 'progress') {
            cancelled = true;
            handover.postMessage({ type: 'cancel', id: 'old-many' });
            handover.postMessage({ type: 'start', id: 'fresh-small', operation: 'directory',
              left: [entry('fresh', 'x')], right: [entry('fresh', 'x')] });
          }
        } else if (data.id === 'fresh-small' && data.type === 'result') {
          freshFinished = true; resolve(data.result);
        }
      };
    });
    const empty = file('');
    const many = prefix => Array.from({ length: 20000 }, (_, i) => ({ path: `${prefix}/${i}`, file: empty }));
    handover.postMessage({ type: 'start', id: 'old-many', operation: 'directory', left: many('left'), right: many('right') });
    const fresh = await result;
    ok(cancelled && fresh.counts.same === 1, '40000-path metadata job yields and hands over to real Worker replacement');
    await new Promise(resolve => setTimeout(resolve, 100));
    ok(lateOldMessages === 0, 'no old progress or result follows the replacement result');
  } finally { handover.terminate(); }

  const violations = [];
  const listener = event => violations.push(event.violatedDirective);
  document.addEventListener('securitypolicyviolation', listener);
  let blocked = false;
  try { await fetch('http://127.0.0.1:1/controlled-csp-probe'); } catch { blocked = true; }
  await new Promise(resolve => setTimeout(resolve, 30));
  document.removeEventListener('securitypolicyviolation', listener);
  ok(blocked && violations.includes('connect-src'), 'real Chrome CSP blocks connections');
  ok(localStorage.length === 0 && sessionStorage.length === 0, 'no browser key/value persistence');
  ok((await indexedDB.databases()).length === 0, 'no IndexedDB database');
  ok((await navigator.serviceWorker.getRegistrations()).length === 0, 'no Service Worker');
  return { assertions, status: 'PASS', userFilesRead: 0, progress: progressReport };
}
