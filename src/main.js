import { CompareClient } from './io/compare-client.js';
import { entriesFromFiles } from './io/files.js';

let client = new CompareClient();
const state = {
  mode: 'file',
  leftFiles: [],
  rightFiles: [],
  leftByPath: new Map(),
  rightByPath: new Map(),
  pathKeys: [],
  result: null,
  filteredRows: [],
  page: 0,
  detail: null,
  detailPath: null,
  detailPage: 0,
  generation: 0,
  task: null,
  detailToken: null,
  detailMessage: '',
};
const pageSize = 100;
const detailPageSize = 120;
let filterTimer;
const elements = {
  status: document.querySelector('#status'),
  compare: document.querySelector('#compare'),
  cancel: document.querySelector('#cancel'),
  leftFile: document.querySelector('#left-file'),
  rightFile: document.querySelector('#right-file'),
  leftDirectory: document.querySelector('#left-directory'),
  rightDirectory: document.querySelector('#right-directory'),
  leftSelection: document.querySelector('#left-selection'),
  rightSelection: document.querySelector('#right-selection'),
  results: document.querySelector('#results'),
  summary: document.querySelector('#results-summary'),
  pathFilter: document.querySelector('#path-filter'),
  statusFilter: document.querySelector('#status-filter'),
  resultsBody: document.querySelector('#results-body'),
  previousPage: document.querySelector('#previous-page'),
  nextPage: document.querySelector('#next-page'),
  pageLabel: document.querySelector('#page-label'),
  detail: document.querySelector('#text-detail'),
  detailStatus: document.querySelector('#detail-status'),
  diffBody: document.querySelector('#diff-body'),
  previousDiffPage: document.querySelector('#previous-diff-page'),
  nextDiffPage: document.querySelector('#next-diff-page'),
  diffPageLabel: document.querySelector('#diff-page-label'),
  ignoreWhitespace: document.querySelector('#ignore-whitespace'),
  ignoreEol: document.querySelector('#ignore-eol'),
  selfTest: document.querySelector('#self-test'),
};

const statusLabels = {
  different: '有差异', same: '相同', 'left-only': '仅左侧', 'right-only': '仅右侧',
  uncompared: '未比较', error: '错误',
};
const reasonLabels = {
  'directory-limit': '超过目录数量上限', 'file-limit': '超过文件大小上限',
  'text-limit': '超过文本大小上限', 'line-limit': '超过行数上限',
  'diff-budget': '超过差异计算预算', cancelled: '已取消', 'read-failed': '读取失败',
  'invalid-entry': '无效文件', 'duplicate-path': '路径重复', binary: '二进制文件',
  'invalid-encoding': '编码不受支持', 'worker-failed': '比较线程失败',
  'worker-message-failed': '比较线程通信失败', 'worker-disposed': '比较线程已关闭，请刷新页面',
};

function setStatus(message, kind = '') {
  elements.status.textContent = message;
  elements.status.dataset.kind = kind;
}

// Only the current task may settle controls or publish a result.
function updateTaskControls() {
  elements.compare.disabled = Boolean(state.task) || (!state.leftFiles.length && !state.rightFiles.length);
  elements.cancel.disabled = !state.task;
  elements.selfTest.disabled = Boolean(state.task);
  const testing = state.task?.kind === 'self-test';
  elements.ignoreWhitespace.disabled = testing;
  elements.ignoreEol.disabled = testing;
}

function stopTask() {
  state.generation++;
  client.cancel();
  state.task = null;
  updateTaskControls();
}

function beginTask(kind) {
  stopTask();
  state.task = { kind, token: state.generation };
  updateTaskControls();
  return state.generation;
}

function finishTask(token) {
  if (token !== state.generation || state.task?.token !== token) return false;
  state.task = null;
  updateTaskControls();
  return true;
}

function resetDetail(path = null, token = null, message = '') {
  state.detail = null;
  state.detailPath = path;
  state.detailToken = token;
  state.detailPage = 0;
  state.detailMessage = message;
  document.querySelector('#detail-title').textContent = path ? `文本差异 · ${path}` : '文本差异';
  renderTextDetail();
}

function resetResults() {
  clearTimeout(filterTimer);
  filterTimer = undefined;
  state.result = null;
  state.filteredRows = [];
  state.pathKeys = [];
  state.page = 0;
  elements.summary.textContent = '';
  elements.resultsBody.replaceChildren();
  elements.pageLabel.textContent = '';
  elements.previousPage.disabled = true;
  elements.nextPage.disabled = true;
  elements.results.hidden = true;
}

function cancelTask() {
  const kind = state.task?.kind;
  stopTask();
  if (!kind) return;
  if (kind === 'detail') resetDetail(state.detailPath, null, '已取消文本详情；取消不表示文件相同。');
  setStatus('已取消；取消不表示文件相同。', 'error');
}

function getModeInputs() {
  return state.mode === 'directory'
    ? [elements.leftDirectory, elements.rightDirectory]
    : [elements.leftFile, elements.rightFile];
}

function describeFiles(files) {
  if (!files.length) return '尚未选择';
  if (state.mode === 'file') return files[0].file.name;
  return `${files.length.toLocaleString()} 个文件`;
}

function updateSelectionLabels() {
  elements.leftSelection.textContent = describeFiles(state.leftFiles);
  elements.rightSelection.textContent = describeFiles(state.rightFiles);
  updateTaskControls();
}

function readInput(input, side) {
  stopTask();
  resetResults();
  resetDetail();
  elements.detail.hidden = true;
  try {
    const files = entriesFromFiles(input.files, { directory: state.mode === 'directory' });
    state[side] = files;
    state[side === 'leftFiles' ? 'leftByPath' : 'rightByPath'] = new Map(files.map(entry => [entry.path, entry.file]));
    updateSelectionLabels();
    setStatus(`${side === 'leftFiles' ? '左侧' : '右侧'}已选择 ${describeFiles(files)}。`);
  } catch (error) {
    input.value = '';
    state[side] = [];
    state[side === 'leftFiles' ? 'leftByPath' : 'rightByPath'].clear();
    updateSelectionLabels();
    setStatus(error.message === 'directory-limit' ? '每侧最多 20,000 个文件；超限选择已整体拒绝，请重新选择。'
      : error.message === 'multiple-directory-roots' ? '每侧只能选择一个目录。' : '选择的文件路径无法处理。', 'error');
  }
}

function setMode(mode) {
  stopTask();
  state.mode = mode;
  state.leftFiles = [];
  state.rightFiles = [];
  state.leftByPath.clear();
  state.rightByPath.clear();
  resetResults();
  resetDetail();
  elements.leftFile.value = '';
  elements.rightFile.value = '';
  elements.leftDirectory.value = '';
  elements.rightDirectory.value = '';
  const directory = mode === 'directory';
  elements.leftFile.hidden = directory;
  elements.rightFile.hidden = directory;
  elements.leftDirectory.hidden = !directory;
  elements.rightDirectory.hidden = !directory;
  elements.leftFile.previousElementSibling.hidden = directory;
  elements.rightFile.previousElementSibling.hidden = directory;
  elements.leftDirectory.previousElementSibling.hidden = !directory;
  elements.rightDirectory.previousElementSibling.hidden = !directory;
  elements.results.hidden = true;
  elements.detail.hidden = true;
  updateSelectionLabels();
  setStatus(directory ? '请选择左右两个目录。' : '请选择左右两个文件。');
}

function formatReason(row) {
  return reasonLabels[row.reason] || row.reason || '';
}

function applyFilters() {
  clearTimeout(filterTimer);
  filterTimer = undefined;
  const query = elements.pathFilter.value.trim().toLocaleLowerCase();
  const selected = elements.statusFilter.value;
  const rows = state.result?.rows || [];
  state.filteredRows = rows.filter((row, index) =>
    (!query || state.pathKeys[index].includes(query)) &&
    (selected === 'all' || row.status === selected));
  state.page = Math.min(state.page, Math.max(0, Math.ceil(state.filteredRows.length / pageSize) - 1));
  renderResults();
}

function appendCell(row, text, className = '') {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

function renderResults() {
  elements.resultsBody.replaceChildren();
  const start = state.page * pageSize;
  const visible = state.filteredRows.slice(start, start + pageSize);
  for (const item of visible) {
    const row = document.createElement('tr');
    row.dataset.status = item.status;
    appendCell(row, item.path, 'path-cell');
    appendCell(row, `${statusLabels[item.status] || item.status}${formatReason(item) ? `：${formatReason(item)}` : ''}`, `status-${item.status}`);
    const action = document.createElement('td');
    if (state.mode === 'directory' && ['different', 'same', 'left-only', 'right-only'].includes(item.status)) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'link-button'; button.textContent = '查看文本差异';
      button.addEventListener('click', () => showTextDetail(item));
      action.append(button);
    } else action.textContent = '—';
    row.append(action);
    elements.resultsBody.append(row);
  }
  const totalPages = Math.max(1, Math.ceil(state.filteredRows.length / pageSize));
  elements.pageLabel.textContent = `${state.filteredRows.length ? state.page + 1 : 0} / ${state.filteredRows.length ? totalPages : 0}`;
  elements.previousPage.disabled = state.page === 0;
  elements.nextPage.disabled = state.page + 1 >= totalPages;
}

function summarize(result) {
  const counts = result.counts;
  if (!counts || result.reason === 'directory-limit') return result.reason ? reasonLabels[result.reason] || result.reason : result.status;
  return `共 ${result.rows.length.toLocaleString()} 项 · 相同 ${counts.same} · 有差异 ${counts.different} · 仅左 ${counts['left-only']} · 仅右 ${counts['right-only']} · 未比较 ${counts.uncompared} · 错误 ${counts.error}`;
}

async function compare() {
  const [leftInput, rightInput] = getModeInputs();
  if (state.task || (!state.leftFiles.length && !state.rightFiles.length)) return;
  const token = beginTask('compare');
  resetResults();
  resetDetail(null, token);
  elements.detail.hidden = true;
  setStatus('正在读取并比较…');
  const operation = state.mode === 'directory' ? 'directory' : 'text';
  const left = operation === 'directory' ? state.leftFiles : state.leftFiles[0]?.file || null;
  const right = operation === 'directory' ? state.rightFiles : state.rightFiles[0]?.file || null;
  const result = await client.start(operation, left, right, {
    ignoreWhitespace: elements.ignoreWhitespace.checked,
    ignoreEol: elements.ignoreEol.checked,
    onProgress: progress => {
      if (token !== state.generation) return;
      if (progress.type === 'files') setStatus(`正在比较文件 ${progress.completed.toLocaleString()} / ${progress.total.toLocaleString()}…`);
      if (progress.type === 'bytes') setStatus(`正在比较 ${progress.path}…`);
    },
  });
  if (!finishTask(token)) return;
  state.result = result;
  if (operation === 'directory') {
    state.pathKeys = (result.rows || []).map(row => row.path.toLocaleLowerCase());
    state.page = 0; applyFilters(); elements.results.hidden = false;
    elements.summary.textContent = summarize(result);
    setStatus(result.status === 'complete' ? '比较完成。' : `比较结束：${reasonLabels[result.reason] || result.status}。`, result.status === 'complete' ? '' : 'error');
  } else {
    setStatus(result.status === 'ok' ? `文本比较完成：${result.differenceCount} 个差异区块。` : `文本无法比较：${reasonLabels[result.reason] || result.reason}。`, result.status === 'ok' ? '' : 'error');
    state.detail = { ...result, token, path: state.detailPath };
    state.detailPage = 0;
    renderTextDetail();
    elements.detail.hidden = false;
  }
  leftInput.blur(); rightInput.blur();
}

function showTextDetail(row) {
  if (state.task && state.task.kind !== 'detail') return;
  const left = state.leftByPath.get(row.path) || null;
  const right = state.rightByPath.get(row.path) || null;
  const token = beginTask('detail');
  resetDetail(row.path, token, `正在读取 ${row.path}…`);
  elements.detail.hidden = false;
  client.start('text', left, right, {
    ignoreWhitespace: elements.ignoreWhitespace.checked,
    ignoreEol: elements.ignoreEol.checked,
  }).then(result => {
    if (!finishTask(token) || state.detailPath !== row.path) return;
    state.detail = { ...result, token, path: row.path };
    renderTextDetail();
  });
}

function renderTextDetail() {
  const result = state.detail?.token === state.detailToken && state.detail?.path === state.detailPath
    ? state.detail : null;
  elements.diffBody.replaceChildren();
  if (!result || result.status !== 'ok') {
    elements.detailStatus.textContent = result ? `文本无法比较：${reasonLabels[result.reason] || result.reason}。` : state.detailMessage;
    elements.diffPageLabel.textContent = '';
    elements.previousDiffPage.disabled = true;
    elements.nextDiffPage.disabled = true;
    return;
  }
  elements.detailStatus.textContent = `${result.differenceCount} 个差异区块 · ${result.left.encoding || '空文件'} / ${result.right.encoding || '空文件'}`;
  state.detailPage = Math.max(0, Math.min(state.detailPage, Math.max(0, Math.ceil(result.rows.length / detailPageSize) - 1)));
  const start = state.detailPage * detailPageSize;
  for (const item of result.rows.slice(start, start + detailPageSize)) {
    const row = document.createElement('tr');
    row.className = `diff-${item.kind}`;
    appendCell(row, item.left?.raw || '', 'diff-value');
    appendCell(row, item.right?.raw || '', 'diff-value');
    elements.diffBody.append(row);
  }
  const totalPages = Math.max(1, Math.ceil(result.rows.length / detailPageSize));
  elements.diffPageLabel.textContent = `${result.rows.length ? state.detailPage + 1 : 0} / ${result.rows.length ? totalPages : 0}`;
  elements.previousDiffPage.disabled = state.detailPage === 0;
  elements.nextDiffPage.disabled = state.detailPage + 1 >= totalPages;
}

function runSelfTest() {
  if (state.task) return;
  const token = beginTask('self-test');
  setStatus('正在运行内存自检…');
  client.start('directory', [{ path: '自检.txt', file: new File(['abc'], 'left.txt') }],
    [{ path: '自检.txt', file: new File(['abd'], 'right.txt') }]).then(result => {
      if (!finishTask(token)) return;
      setStatus(result.status === 'complete' && result.counts.different === 1
        ? '自检通过：Worker 已检出字节差异。' : `自检未通过：${reasonLabels[result.reason] || result.status}`, result.status === 'complete' ? '' : 'error');
    });
}

document.querySelectorAll('input[name="mode"]').forEach(input => input.addEventListener('change', () => setMode(input.value)));
elements.leftFile.addEventListener('change', () => readInput(elements.leftFile, 'leftFiles'));
elements.rightFile.addEventListener('change', () => readInput(elements.rightFile, 'rightFiles'));
elements.leftDirectory.addEventListener('change', () => readInput(elements.leftDirectory, 'leftFiles'));
elements.rightDirectory.addEventListener('change', () => readInput(elements.rightDirectory, 'rightFiles'));
elements.compare.addEventListener('click', compare);
elements.cancel.addEventListener('click', cancelTask);
elements.pathFilter.addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => { state.page = 0; applyFilters(); }, 80);
});
elements.statusFilter.addEventListener('change', () => { state.page = 0; applyFilters(); });
elements.previousPage.addEventListener('click', () => { state.page--; renderResults(); });
elements.nextPage.addEventListener('click', () => { state.page++; renderResults(); });
elements.previousDiffPage.addEventListener('click', () => { state.detailPage--; renderTextDetail(); });
elements.nextDiffPage.addEventListener('click', () => { state.detailPage++; renderTextDetail(); });
const refreshDetail = () => {
  if (state.task?.kind === 'self-test') return;
  if (state.detailPath && state.mode === 'directory') showTextDetail({ path: state.detailPath });
  else if (state.mode === 'file' && state.leftFiles.length + state.rightFiles.length) {
    stopTask();
    compare();
  }
};
elements.ignoreWhitespace.addEventListener('change', refreshDetail);
elements.ignoreEol.addEventListener('change', refreshDetail);
elements.selfTest.addEventListener('click', runSelfTest);
window.addEventListener('pagehide', () => {
  clearTimeout(filterTimer);
  filterTimer = undefined;
  cancelTask();
  client.dispose();
});
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  if (client.disposed) client = new CompareClient();
  // A cached page keeps its DOM and inputs, but never resumes an unfinished job.
  if (state.mode === 'directory' && state.result) applyFilters();
  updateTaskControls();
  setStatus('页面已恢复，可继续比较。');
});

setMode('file');
document.documentElement.dataset.ready = 'true';
