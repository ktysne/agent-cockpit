const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { functionSource } = require('./support/page-context');
const web = fs.readFileSync('src/web/index.html', 'utf8');
const mock = fs.readFileSync('mock/index.html', 'utf8');

test('画面の取得と保存の失敗は ID とクエリーとエラー文を伏せ、診断失敗を再送しない', async () => {
  const sent = [];
  const context = vm.createContext({ AbortSignal,
    document: { querySelector: () => ({ content: 'test-secret' }) },
    fetch: async (url, init) => {
      if (url === '/api/diagnostics') { sent.push(JSON.parse(init.body)); throw new Error('private-diagnostic'); }
      if (init?.method === 'POST') throw new Error('private-message');
      return { ok: false, status: 503 };
    },
  });
  vm.runInContext(['reportWebFailure', 'fetchUi', 'postUiAction'].map(name => functionSource(web, name)).join('\n'), context);
  assert.equal((await context.fetchUi('/api/sessions/private-id/context?secret=private-query')).status, 503);
  await assert.rejects(context.postUiAction('/api/decisions/private-id/answer', { answer: 'private-answer' }), /private-message/);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, [{ entries: [{ msg: 'web.failed', data: { operation: 'fetch', path: '/api/sessions/:id/context', status: 503 } }] },
    { entries: [{ msg: 'web.failed', data: { operation: 'save', path: '/api/decisions/:id/answer' } }] }]);
  assert.doesNotMatch(JSON.stringify(sent), /private|test-secret/);
});

function diagnosticPage({ runs = [{ id: '20261013T000000Z-1', current: true, startedAt: '2026-10-13T00:00:00Z', count: 2, sources: ['server'] }],
  entriesByRun = {}, failedRuns = [], fetchImpl } = {}) {
  const nodes = new Map();
  const requests = [];
  const appended = [];
  const entries = [{ ts: 1, level: 'mark', tag: 'server', msg: 'server.start', data: { pid: 1 } },
    { ts: 2, level: 'debug', tag: 'server', msg: 'request.failed', data: {} }];
  const allEntries = { [runs.find(run => run.current)?.id]: entries, ...entriesByRun };
  const makeNode = () => ({ value: '', textContent: '', disabled: false, hidden: false, open: false,
    listeners: {}, attributes: {}, addEventListener(name, callback) { this.listeners[name] = callback; },
    replaceChildren(...children) { this.children = children; },
    append(child) { appended.push(child); }, setAttribute(name, value) { this.attributes[name] = value; }, select() { this.selected = true; },
    click() { this.clicked = true; }, remove() { this.removed = true; }, focus() {},
    showModal() { this.open = true; }, close() { this.open = false; }, style: {},
  });
  const node = id => { if (!nodes.has(id)) nodes.set(id, makeNode()); return nodes.get(id); };
  const context = vm.createContext({ document: { getElementById: node, createElement: makeNode, execCommand: () => true },
    diagnosticsLevelSelect: node('diagnostics-level'),
    navigator: {}, Blob, URL, setTimeout: callback => callback(),
    displayPreferences: { diagnosticsLevel: 'info' },
    saveDisplayPreferences: async changes => { requests.push({ route: '/api/display', body: changes }); Object.assign(context.displayPreferences, changes); return true; },
    postUiAction: async (route, body) => { requests.push({ route, body }); return { ok: true }; },
    fetch: async (route, init) => {
      requests.push({ route });
      if (fetchImpl) return fetchImpl(route, init);
      const runId = new URL(route, 'http://localhost').searchParams.get('run');
      if (runId !== null) return { ok: !failedRuns.includes(runId), json: async () => ({ entries: allEntries[runId] || [] }) };
      return { ok: true, json: async () => ({ runs, version: '1.2.3' }) };
    },
  });
  vm.runInContext(web.slice(web.indexOf('const DIAGNOSTIC_LEVEL_ORDER'), web.indexOf('async function postUiAction')), context);
  return { context, node, requests, appended, entries, runs };
}

test('設定の診断ログリンクはマニュアルの右にあり、ダイアログの内容はモックと一致する', () => {
  assert.match(web, /settings-resource-links[^]*?>マニュアル<\/a><a[^]*?id="diagnostics-open"[^]*?>診断ログ<\/a>/);
  const dialogs = html => html.slice(html.indexOf('<dialog class="diagnostics-dialog"'),
    html.indexOf('</dialog>', html.indexOf('<dialog class="diagnostics-policy-dialog"')) + 9);
  assert.equal(dialogs(web), dialogs(mock));
  new vm.Script(web.match(/<script>([^]*?)<\/script>/)[1]);
});

test('診断ログの更新は選択中の起動だけを取得し、出どころは一覧から作る', async () => {
  const current = { id: '20261013T000000Z-1', current: true, startedAt: '2026-10-13T00:00:00Z', count: 2, sources: ['server'] };
  const previous = { id: '20261012T000000Z-1', current: false, startedAt: '2026-10-12T00:00:00Z', count: 1, sources: ['hook'] };
  const { context, node, requests } = diagnosticPage({ runs: [current, previous], entriesByRun: { [previous.id]: [
    { ts: 3, level: 'info', tag: 'hook', msg: 'hook.input', data: {} },
  ] } });
  await context.refreshDiagnostics();
  assert.match(node('diagnostics-list').textContent, /server.start/);
  assert.doesNotMatch(node('diagnostics-list').textContent, /request.failed/);
  assert.deepEqual(requests.filter(item => item.route.includes('?run=')).map(item => item.route), [
    '/api/diagnostics?run=20261013T000000Z-1',
  ]);
  assert.deepEqual(node('diagnostics-source').children.map(option => option.value), ['', 'server', 'hook']);
  node('diagnostics-level').value = 'debug';
  await node('diagnostics-level').listeners.change();
  assert.match(node('diagnostics-list').textContent, /request.failed/);
  assert.equal(JSON.stringify(requests.at(-1)), JSON.stringify({ route: '/api/display', body: { diagnosticsLevel: 'debug' } }));
});

test('別の起動を選ぶと、その起動の記録を取得して表示する', async () => {
  const previous = { id: '20261012T000000Z-1', current: false, startedAt: '2026-10-12T00:00:00Z', count: 1, sources: ['hook'] };
  const { context, node, requests } = diagnosticPage({ runs: [
    { id: '20261013T000000Z-1', current: true, startedAt: '2026-10-13T00:00:00Z', count: 2, sources: ['server'] }, previous,
  ], entriesByRun: { [previous.id]: [{ ts: 3, level: 'info', tag: 'hook', msg: 'hook.input', data: {} }] } });
  await context.refreshDiagnostics();
  node('diagnostics-run').value = previous.id;
  await node('diagnostics-run').listeners.change();
  assert.match(node('diagnostics-list').textContent, /hook\.input/);
  assert.doesNotMatch(node('diagnostics-list').textContent, /server\.start/);
  assert.ok(requests.some(item => item.route === `/api/diagnostics?run=${previous.id}`));
});

test('更新後も起動の選択を保ち、選択中だけを読み直す', async () => {
  const current = { id: '20261013T000000Z-1', current: true, startedAt: '2026-10-13T00:00:00Z', count: 2, sources: ['server'] };
  const previous = { id: '20261012T000000Z-1', current: false, startedAt: '2026-10-12T00:00:00Z', count: 1, sources: ['hook'] };
  const { context, node, requests } = diagnosticPage({ runs: [current, previous], entriesByRun: { [previous.id]: [
    { ts: 3, level: 'info', tag: 'hook', msg: 'hook.input', data: {} },
  ] } });
  await context.refreshDiagnostics();
  node('diagnostics-run').value = previous.id;
  await node('diagnostics-run').listeners.change();
  await context.refreshDiagnostics();
  assert.equal(node('diagnostics-run').value, previous.id);
  assert.match(node('diagnostics-list').textContent, /hook\.input/);
  assert.deepEqual(requests.filter(item => item.route.includes('?run=')).map(item => item.route), [
    `/api/diagnostics?run=${current.id}`, `/api/diagnostics?run=${previous.id}`, `/api/diagnostics?run=${previous.id}`,
  ]);
  assert.deepEqual(Array.from(vm.runInContext('diagnosticRuns.map(run => Array.isArray(run.entries))', context)), [false, true]);
});

test('選択中の起動が一覧から消えたら、現在の起動を選び直す', async () => {
  const current = { id: '20261013T000000Z-1', current: true, startedAt: '2026-10-13T00:00:00Z', count: 1, sources: ['server'] };
  const previous = { id: '20261012T000000Z-1', current: false, startedAt: '2026-10-12T00:00:00Z', count: 1, sources: ['hook'] };
  let listCount = 0;
  const { context, node } = diagnosticPage({ fetchImpl: async route => {
    const runId = new URL(route, 'http://localhost').searchParams.get('run');
    if (runId !== null) return { ok: true, json: async () => ({ entries: [{ ts: 1, level: 'mark', tag: runId === current.id ? 'server' : 'hook',
      msg: runId === current.id ? 'server.start' : 'hook.input', data: {} }] }) };
    listCount += 1;
    return { ok: true, json: async () => ({ runs: listCount === 1 ? [current, previous] : [current], version: '1.2.3' }) };
  } });
  await context.refreshDiagnostics();
  node('diagnostics-run').value = previous.id;
  await node('diagnostics-run').listeners.change();
  await context.refreshDiagnostics();
  assert.equal(node('diagnostics-run').value, current.id);
  assert.match(node('diagnostics-list').textContent, /server\.start/);
  assert.doesNotMatch(node('diagnostics-list').textContent, /hook\.input/);
});

test('古い起動の応答が遅れても、現在選択中の記録を上書きしない', async () => {
  const current = { id: '20261013T000000Z-1', current: true, startedAt: '2026-10-13T00:00:00Z', count: 1, sources: ['server'] };
  const previous = { id: '20261012T000000Z-1', current: false, startedAt: '2026-10-12T00:00:00Z', count: 1, sources: ['hook'] };
  let respondToPrevious;
  const { context, node } = diagnosticPage({ runs: [current, previous], fetchImpl: async route => {
    const runId = new URL(route, 'http://localhost').searchParams.get('run');
    if (runId === previous.id) return new Promise(resolve => { respondToPrevious = resolve; });
    return { ok: true, json: async () => route.includes('?')
      ? { entries: [{ ts: 1, level: 'mark', tag: 'server', msg: 'server.start', data: {} }] }
      : { runs: [current, previous], version: '1.2.3' } };
  } });
  await context.refreshDiagnostics();
  node('diagnostics-run').value = previous.id;
  const previousLoad = node('diagnostics-run').listeners.change();
  node('diagnostics-run').value = current.id;
  await node('diagnostics-run').listeners.change();
  respondToPrevious({ ok: true, json: async () => ({ entries: [{ ts: 2, level: 'info', tag: 'hook', msg: 'hook.input', data: {} }] }) });
  await previousLoad;
  assert.match(node('diagnostics-list').textContent, /server\.start/);
  assert.doesNotMatch(node('diagnostics-list').textContent, /hook\.input/);
  assert.equal(node('diagnostics-list').attributes['aria-busy'], 'false');
});

test('選択中の起動を取得できない場合は再試行を案内し、コピーと書き出しを行わない', async () => {
  const previous = { id: '20261012T000000Z-1', current: false, startedAt: '2026-10-12T00:00:00Z', count: 1, sources: ['hook'] };
  const { context, node, appended } = diagnosticPage({ runs: [
    { id: '20261013T000000Z-1', current: true, startedAt: '2026-10-13T00:00:00Z', count: 2, sources: ['server'] }, previous,
  ], failedRuns: [previous.id] });
  await context.refreshDiagnostics();
  node('diagnostics-run').value = previous.id;
  await node('diagnostics-run').listeners.change();
  assert.match(node('diagnostics-status').textContent, /選んだ起動の記録を読み込めませんでした.*更新.*やり直してください/);
  await node('diagnostics-copy').listeners.click();
  node('diagnostics-export-run').listeners.click();
  assert.equal(appended.length, 0);
});

test('全起動の書き出しは実行時に全起動を取得し、取得中の多重実行を防ぐ', async () => {
  const current = { id: '20261013T000000Z-1', current: true, startedAt: '2026-10-13T00:00:00Z', count: 1, sources: ['server'] };
  const previous = { id: '20261012T000000Z-1', current: false, startedAt: '2026-10-12T00:00:00Z', count: 1, sources: ['hook'] };
  let exporting = false;
  const pending = [];
  const { context, node, requests, appended } = diagnosticPage({ runs: [current, previous], fetchImpl: async route => {
    const runId = new URL(route, 'http://localhost').searchParams.get('run');
    if (runId === null) return { ok: true, json: async () => ({ runs: [current, previous], version: '1.2.3' }) };
    if (exporting) return new Promise(resolve => pending.push({ runId, resolve }));
    return { ok: true, json: async () => ({ entries: [{ ts: 1, level: 'mark', tag: 'server', msg: 'server.start', data: {} }] }) };
  } });
  await context.refreshDiagnostics();
  assert.deepEqual(requests.filter(item => item.route.includes('?run=')).map(item => item.route), [
    `/api/diagnostics?run=${current.id}`,
  ]);
  exporting = true;
  const button = node('diagnostics-export-all');
  const exportRequest = button.listeners.click({ currentTarget: button });
  assert.equal(button.disabled, true);
  assert.match(node('diagnostics-status').textContent, /すべての起動の記録を読み込んでいます/);
  await button.listeners.click({ currentTarget: button });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].runId, current.id);
  pending[0].resolve({ ok: true, json: async () => ({ entries: [{ ts: 1, level: 'mark', tag: 'server', msg: 'server.start', data: {} }] }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 2);
  assert.equal(pending[1].runId, previous.id);
  pending[1].resolve({ ok: true, json: async () => ({ entries: [{ ts: 2, level: 'info', tag: 'hook', msg: 'hook.input', data: {} }] }) });
  await exportRequest;
  assert.equal(button.disabled, false);
  assert.ok(appended.some(link => link.download === 'agent-cockpit-diagnostics-all.txt'));
  assert.match(node('diagnostics-status').textContent, /すべての起動を書き出しました/);
});

test('全起動の一部を取得できない場合は書き出さない', async () => {
  const previous = { id: '20261012T000000Z-1', current: false, startedAt: '2026-10-12T00:00:00Z', count: 1, sources: ['hook'] };
  const { context, node, appended } = diagnosticPage({ runs: [
    { id: '20261013T000000Z-1', current: true, startedAt: '2026-10-13T00:00:00Z', count: 2, sources: ['server'] }, previous,
  ], failedRuns: [previous.id] });
  await context.refreshDiagnostics();
  const button = node('diagnostics-export-all');
  await button.listeners.click({ currentTarget: button });
  assert.equal(appended.length, 0);
  assert.match(node('diagnostics-status').textContent, /すべての起動を書き出せませんでした/);
  assert.equal(button.disabled, false);
});

test('全起動の書き出しの途中で削除が終わると、取得済みの記録を書き出さない', async () => {
  const current = { id: '20261013T000000Z-1', current: true, startedAt: '2026-10-13T00:00:00Z', count: 1, sources: ['server'] };
  const previous = { id: '20261012T000000Z-1', current: false, startedAt: '2026-10-12T00:00:00Z', count: 1, sources: ['hook'] };
  let respondToPrevious;
  const { context, node, appended } = diagnosticPage({ runs: [current, previous], fetchImpl: async route => {
    const runId = new URL(route, 'http://localhost').searchParams.get('run');
    if (runId === null) return { ok: true, json: async () => ({ runs: [current, previous], version: '1.2.3' }) };
    if (runId === previous.id) return new Promise(resolve => { respondToPrevious = resolve; });
    return { ok: true, json: async () => ({ entries: [{ ts: 1, level: 'mark', tag: 'server', msg: 'server.start', data: {} }] }) };
  } });
  await context.refreshDiagnostics();
  const button = node('diagnostics-export-all');
  const exportRequest = button.listeners.click({ currentTarget: button });
  await new Promise(resolve => setImmediate(resolve));
  node('diagnostics-delete-all').listeners.click();
  await node('diagnostics-delete-confirm').listeners.click();
  respondToPrevious({ ok: true, json: async () => ({ entries: [{ ts: 2, level: 'info', tag: 'hook', msg: 'hook.input', data: {} }] }) });
  await exportRequest;
  assert.equal(appended.some(link => link.download === 'agent-cockpit-diagnostics-all.txt'), false);
  assert.match(node('diagnostics-status').textContent, /書き出しを取りやめました/);
  assert.equal(button.disabled, false);
});

test('出どころとレベルの絞り込みは mark と error を残し、silent は表示を空にする', () => {
  const context = vm.createContext({ diagnosticsLevelSelect: { value: 'error' }, diagnosticsSourceSelect: { value: 'server' },
    DIAGNOSTIC_LEVEL_ORDER: ['error', 'warn', 'info', 'debug'] });
  vm.runInContext(functionSource(web, 'filteredDiagnosticEntries'), context);
  const run = { entries: ['mark', 'error', 'debug'].map((level, ts) => ({ level, ts, tag: 'server' })) };
  assert.deepEqual(Array.from(context.filteredDiagnosticEntries(run), entry => entry.level), ['mark', 'error']);
  context.diagnosticsSourceSelect.value = 'hook';
  assert.equal(context.filteredDiagnosticEntries(run).length, 0);
  context.diagnosticsLevelSelect.value = 'silent';
  assert.equal(context.filteredDiagnosticEntries(run).length, 0);
});

test('コピーの代替要素と書き出しのリンクはモーダルの中に置く', async () => {
  const { context, appended } = diagnosticPage();
  assert.equal(await context.copyDiagnosticText('copy text'), true);
  assert.equal(appended[0].value, 'copy text');
  assert.equal(appended[0].selected, true);
  context.downloadDiagnosticText([{ id: 'run', startedAt: 1, entries: [] }], 'run');
  assert.equal(appended[1].download, 'agent-cockpit-diagnostics-run.txt');
  assert.equal(appended[1].clicked, true);
  assert.equal(appended[1].removed, true);
});

test('書き出しは絞り込み前の記録と版とレベルと起動識別子を含む', async () => {
  const { context, entries } = diagnosticPage();
  await context.refreshDiagnostics();
  const text = context.diagnosticExportText([{ id: 'run', startedAt: 1, entries }]);
  assert.match(text, /version=1.2.3 level=info run=run exported=/);
  assert.match(text, /\[debug\].*request.failed/);
});

test('削除は確認してから選んだ起動か全件を送信し、やめると要求を送らない', async () => {
  const { context, node, requests } = diagnosticPage();
  await context.refreshDiagnostics();
  context.beginDiagnosticDeletion('run');
  assert.match(node('diagnostics-delete-message').textContent, /2 件.*元に戻せません/);
  const before = requests.length;
  node('diagnostics-delete-cancel').listeners.click();
  assert.equal(requests.length, before);
  for (const scope of ['run', 'all']) {
    context.beginDiagnosticDeletion(scope);
    await node('diagnostics-delete-confirm').listeners.click();
  }
  assert.equal(JSON.stringify(requests.filter(item => item.route === '/api/diagnostics/delete').map(item => item.body)),
    JSON.stringify([{ run: '20261013T000000Z-1' }, { all: true }]));
});

test('削除確認は全起動の一覧件数と未取得の起動件数を使う', async () => {
  const previous = { id: '20261012T000000Z-1', current: false, startedAt: '2026-10-12T00:00:00Z', count: 4, sources: ['hook'] };
  const { context, node } = diagnosticPage({ runs: [
    { id: '20261013T000000Z-1', current: true, startedAt: '2026-10-13T00:00:00Z', count: 2, sources: ['server'] }, previous,
  ] });
  await context.refreshDiagnostics();
  context.beginDiagnosticDeletion('all');
  assert.match(node('diagnostics-delete-message').textContent, /6 件/);
  node('diagnostics-delete-cancel').listeners.click();
  node('diagnostics-run').value = previous.id;
  context.beginDiagnosticDeletion('run');
  assert.match(node('diagnostics-delete-message').textContent, /4 件/);
});

test('診断ログとポリシーはそれぞれ開閉の操作でモーダルを切り替える', () => {
  const { node } = diagnosticPage();
  node('diagnostics-open').listeners.click({ preventDefault() {} });
  assert.equal(node('diagnostics-dialog').open, true);
  node('diagnostics-policy-open').listeners.click();
  assert.equal(node('diagnostics-policy-dialog').open, true);
  node('diagnostics-policy-close').listeners.click();
  node('diagnostics-close').listeners.click();
  assert.equal(node('diagnostics-policy-dialog').open, false);
  assert.equal(node('diagnostics-dialog').open, false);
});

test('削除の後に一覧を読み込めなくても、削除した記録を表示に残さず、読み込めなかったことを伝える', async () => {
  const { context, node } = diagnosticPage();
  await context.refreshDiagnostics();
  context.fetch = async () => { throw new Error('offline'); };
  context.beginDiagnosticDeletion('run');
  await node('diagnostics-delete-confirm').listeners.click();
  assert.equal(context.filteredDiagnosticEntries().length, 0);
  assert.match(node('diagnostics-status').textContent, /削除しましたが、一覧を読み込めませんでした/);
});

test('削除の応答を待つ間に「やめる」を押しても、送った起動の記録を表示に残さない', async () => {
  const { context, node } = diagnosticPage();
  await context.refreshDiagnostics();
  let respond;
  context.postUiAction = () => new Promise(resolve => { respond = resolve; });
  context.fetch = async () => { throw new Error('offline'); };
  context.beginDiagnosticDeletion('run');
  const deleting = node('diagnostics-delete-confirm').listeners.click();
  node('diagnostics-delete-cancel').listeners.click();
  respond({ ok: true });
  await deleting;
  assert.equal(context.filteredDiagnosticEntries().length, 0);
});
