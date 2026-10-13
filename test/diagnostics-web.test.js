const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { functionSource } = require('./support/page-context');
const web = fs.readFileSync('src/web/index.html', 'utf8');
const mock = fs.readFileSync('mock/index.html', 'utf8');

function diagnosticPage() {
  const nodes = new Map();
  const requests = [];
  const appended = [];
  const entries = [{ ts: 1, level: 'mark', tag: 'server', msg: 'server.start', data: { pid: 1 } },
    { ts: 2, level: 'debug', tag: 'server', msg: 'request.failed', data: {} }];
  const makeNode = () => ({ value: '', textContent: '', disabled: false, hidden: false, open: false,
    listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; },
    replaceChildren(...children) { this.children = children; },
    append(child) { appended.push(child); }, setAttribute() {}, select() { this.selected = true; },
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
    fetch: async route => { requests.push({ route }); return { ok: true, json: async () => route.includes('?')
      ? { entries } : { runs: [{ id: '20261013T000000Z-1', current: true, startedAt: '2026-10-13T00:00:00Z', count: 2 }], version: '1.2.3' } }; },
  });
  vm.runInContext(web.slice(web.indexOf('const DIAGNOSTIC_LEVEL_ORDER'), web.indexOf('async function postUiAction')), context);
  return { context, node, requests, appended, entries };
}

test('設定の診断ログリンクはマニュアルの右にあり、ダイアログの内容はモックと一致する', () => {
  assert.match(web, /settings-resource-links[^]*?>マニュアル<\/a><a[^]*?id="diagnostics-open"[^]*?>診断ログ<\/a>/);
  const dialogs = html => html.slice(html.indexOf('<dialog class="diagnostics-dialog"'),
    html.indexOf('</dialog>', html.indexOf('<dialog class="diagnostics-policy-dialog"')) + 9);
  assert.equal(dialogs(web), dialogs(mock));
  new vm.Script(web.match(/<script>([^]*?)<\/script>/)[1]);
});

test('診断ログの更新は起動と記録を取得し、レベルの変更は表示設定へ保存する', async () => {
  const { context, node, requests } = diagnosticPage();
  await context.refreshDiagnostics();
  assert.match(node('diagnostics-list').textContent, /server.start/);
  assert.doesNotMatch(node('diagnostics-list').textContent, /request.failed/);
  node('diagnostics-level').value = 'debug';
  await node('diagnostics-level').listeners.change();
  assert.match(node('diagnostics-list').textContent, /request.failed/);
  assert.equal(JSON.stringify(requests.at(-1)), JSON.stringify({ route: '/api/display', body: { diagnosticsLevel: 'debug' } }));
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
