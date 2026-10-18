const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { callTool } = require('../src/mcp/server');
const { DashboardState } = require('../src/server/state');
const { startTestServer, request, jsonBody, uiHeaders, hookHeaders } = require('./support/server');

const INPUT = {
  title: '入力欄を確認してください', context: '小数を入力できるようにした', state: 'waiting',
  options: [
    { label: '確認した。コミットして PR を作る', description: '確認して進める', recommended: true, next: 'PR の欄に出ます。' },
    { label: '直してほしい点がある', description: '直す点を書く', recommended: false, next: '直したら再び届きます。' },
  ],
  verify: { steps: [{ cmd: 'npm start', note: '小数を入力する' }] },
};

async function setup(t, options = {}) {
  const server = await startTestServer(t, options);
  const { info, runtime } = server;
  const post = (url, body, headers = uiHeaders(info, `http://127.0.0.1:${info.port}`)) => request(info.port, {
    method: 'POST', path: url, headers, body: JSON.stringify(body),
  });
  const sessionId = 'verify-session';
  await post('/api/events', { session_id: sessionId, hook_event_name: 'SessionStart', cwd: server.homeDir }, hookHeaders(info.secret));
  const mcp = (name, args) => callTool(name, args, {
    environment: { CLAUDE_CODE_SESSION_ID: sessionId },
    ensureServerRunning: async () => info, readServerInfo: async () => info,
  });
  const add = async (input = INPUT) => {
    const result = await mcp('cockpit_add_decision', input);
    assert.equal(result.isError, undefined, result.content[0].text);
    return runtime.state.decisionsFor(sessionId).at(-1);
  };
  return { ...server, post, mcp, add, sessionId };
}

test('MCP の確認依頼、選択肢の次の案内、起動先と依頼時刻を保存して復元する', async t => {
  const s = await setup(t);
  const decision = await s.add();
  assert.deepEqual(decision.verify, INPUT.verify);
  const body = { decision_id: decision.id, session_id: s.sessionId };
  assert.equal((await s.post('/api/verify/launch', body)).status, 200);
  const result = await s.mcp('cockpit_report_launch', { id: decision.id, url: 'http://127.0.0.1:3000/' });
  assert.equal(result.isError, undefined);
  await s.runtime.state.flushPersistence();
  const loaded = await DashboardState.load(s.homeDir);
  t.after(() => loaded.flushPersistence());
  const saved = loaded.decisionsFor(s.sessionId)[0];
  assert.equal(saved.state, 'waiting');
  assert.equal(saved.verify.launched.url, 'http://127.0.0.1:3000/');
  assert.ok(saved.launchRequestedAt);
  assert.equal(saved.questions[0].options[0].next, INPUT.options[0].next);
});

test('MCP の確認手順の未知の項目と上限超過、起動先の危険な URL と二重指定を拒否する', async t => {
  const s = await setup(t);
  for (const verify of [
    { steps: [] }, { steps: Array(11).fill(INPUT.verify.steps[0]) },
    { steps: [{ cmd: 'a'.repeat(501), note: '' }] }, { steps: [{ cmd: 'npm start', note: 'a'.repeat(501) }] },
    { steps: [{ ...INPUT.verify.steps[0], extra: true }] }, { ...INPUT.verify, path: 'C:/arbitrary' },
  ]) assert.equal((await s.mcp('cockpit_add_decision', { ...INPUT, verify })).isError, true);
  assert.equal((await s.mcp('cockpit_add_decision', { ...INPUT, options: [{ ...INPUT.options[0], next: 'a'.repeat(2001) }] })).isError, true);
  const { id } = await s.add();
  for (const target of [{ url: 'javascript:alert(1)' }, { url: 'file:///C:/app' }, { url: 'https://example.com', process: 'app' }, {}, { process: 'a'.repeat(501) }]) {
    assert.equal((await s.mcp('cockpit_report_launch', { id, ...target })).isError, true);
    assert.equal((await s.post(`/api/sessions/${s.sessionId}/plan`, {
      kind: 'report_launch', id, ...target, ppid: process.pid, claudeCodeSessionId: s.sessionId,
    }, hookHeaders(s.info.secret))).status, 400);
  }
});

test('起動報告は process も受け、他のセッションと確認依頼以外と解決済みへの報告を拒否する', async t => {
  const s = await setup(t);
  const { id } = await s.add();
  assert.equal((await s.mcp('cockpit_report_launch', { id, process: 'Rec Studio.exe' })).isError, undefined);
  assert.equal(s.runtime.state.decisionFor(s.sessionId, id).verify.launched.process, 'Rec Studio.exe');
  const other = s.runtime.state.addDecision('another-session', INPUT);
  assert.equal((await s.mcp('cockpit_report_launch', { id: other.id, process: 'app' })).isError, true);
  const plain = await s.add({ ...INPUT, verify: undefined });
  assert.equal((await s.mcp('cockpit_report_launch', { id: plain.id, process: 'app' })).isError, true);
  await s.mcp('cockpit_update_decision', { id, state: 'resolved', chosen: INPUT.options[0].label, note: '' });
  assert.equal((await s.mcp('cockpit_report_launch', { id, process: 'app' })).isError, true);
});

test('確認依頼の書き込み口は UI 秘密値と Origin を照合し、パスと自由文を受けない', async t => {
  const s = await setup(t);
  const { id } = await s.add();
  for (const [route, body] of [
    ['/api/verify/launch', { session_id: s.sessionId, decision_id: id }],
    ['/api/worktree/terminal', { decision_id: id }],
  ]) {
    for (const headers of [{}, hookHeaders(s.info.secret), uiHeaders(s.info), uiHeaders(s.info, 'https://evil.example')]) {
      assert.ok([401, 403].includes((await s.post(route, body, headers)).status));
    }
    assert.equal((await s.post(route, { ...body, path: 'C:/arbitrary' })).status, 400);
    assert.equal((await s.post(route, { ...body, message: '自由文' })).status, 400);
  }
});

test('起動依頼は固定文の通知を配信し、未配達なら 409 にして回答を保持する', async t => {
  const s = await setup(t);
  const { id } = await s.add();
  assert.equal((await s.post(`/api/decisions/${id}/answer`, { session_id: s.sessionId, choice: 'ok', note: '' })).status, 200);
  const before = s.runtime.state.decisionFor(s.sessionId, id).answer;
  const body = { decision_id: id, session_id: s.sessionId };
  assert.equal((await s.post('/api/verify/launch', body)).status, 200);
  assert.equal((await s.post('/api/verify/launch', body)).status, 409);
  const output = await s.post('/api/hooks/answers', { session_id: s.sessionId, action: 'post-tool-batch', event_name: 'PostToolBatch', id: 'batch-1' }, hookHeaders(s.info.secret));
  assert.match(jsonBody(output).hookOutput.hookSpecificOutput.additionalContext, new RegExp(`cockpit_report_launch.*${id}`));
  assert.deepEqual(s.runtime.state.decisionFor(s.sessionId, id).answer.sentAt, before.sentAt);
  const deliveryId = jsonBody(output).deliveryId;
  assert.ok(deliveryId);
  await s.post('/api/hooks/answers', { session_id: s.sessionId, action: 'delivery-ack', delivery_id: deliveryId, id: 'ack-1' }, hookHeaders(s.info.secret));
  assert.equal((await s.post('/api/verify/launch', body)).status, 200);
});

test('MCP の waiting だけダイアログなしで回答でき、ask の waiting は拒否する', async t => {
  const s = await setup(t);
  const { id } = await s.add();
  const answer = { session_id: s.sessionId, choice: 'ok', note: '' };
  assert.equal((await s.post(`/api/decisions/${id}/answer`, answer)).status, 200);
  await s.post('/api/events', { session_id: s.sessionId, hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
    tool_use_id: 'ask-dialog', questions: [{ question: '確認してください', options: INPUT.options, multiSelect: false }] }, hookHeaders(s.info.secret));
  const ask = s.runtime.state.decisionsFor(s.sessionId).find(item => item.source === 'ask');
  assert.ok(ask);
  assert.equal((await s.post(`/api/decisions/${ask.id}/answer`, answer)).status, 409);
});

async function linkedWorktree(s) {
  const root = path.join(s.homeDir, 'linked');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, '.git'), 'gitdir: ../git/worktrees/linked');
  await s.post('/api/events', { session_id: 'linked-session', hook_event_name: 'SessionStart', cwd: root }, hookHeaders(s.info.secret));
  return root;
}

test('HTTP snapshot は root ごとに実行中の git を共有し、更新後と失敗時にキャッシュを返す', async t => {
  let now = Date.now();
  let fail = false;
  const calls = [];
  const pending = [];
  const s = await setup(t, { stateCacheNow: () => now, worktreeOptions: { now: () => now,
    execFile(file, args, options, callback) {
      calls.push({ file, args, options });
      if (fail) { callback(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); return; }
      const command = args.slice(2).join(' ');
      if (command.includes('HEAD') && command.includes('--short')) pending.push(() => callback(null, 'feature/verify\n'));
      else callback(null, command.startsWith('status') ? ' M file\0R  new\0old\0' : command.startsWith('rev-list') ? '2\n' : 'refs/remotes/origin/main\n');
    } } });
  const root = await linkedWorktree(s);
  s.runtime.state.addDecision('linked-session', INPUT);
  await s.post('/api/events', { session_id: 'second-linked', hook_event_name: 'SessionStart', cwd: root }, hookHeaders(s.info.secret));
  s.runtime.state.addDecision('second-linked', INPUT);
  const first = jsonBody(await request(s.info.port, { path: '/api/state' }));
  assert.equal(first.sessions.find(item => item.session_id === 'linked-session').worktree.branch, undefined);
  assert.equal(pending.length, 1);
  pending.shift()();
  await new Promise(resolve => setImmediate(resolve));
  const read = async () => jsonBody(await request(s.info.port, { path: '/api/state' })).sessions.find(item => item.session_id === 'linked-session').worktree;
  const value = await read();
  assert.deepEqual(value, { path: root, missing: false, branch: 'feature/verify', base: 'main', ahead: 2, uncommitted: 2 });
  const count = calls.length;
  await read();
  assert.equal(calls.length, count);
  fail = true;
  now += 6000;
  assert.deepEqual(await read(), value);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await read(), value);
  assert.ok(calls.every(call => call.file === 'git' && call.args[0] === '-C' && call.args[1] === root &&
    call.options.windowsHide && call.options.timeout > 0 && call.options.env.GIT_TERMINAL_PROMPT === '0' && !call.options.shell));
});

test('確認依頼のない linked worktree は git を呼ばず、通常 checkout を表示せず、削除済みを示す', async t => {
  let calls = 0;
  const s = await setup(t, { worktreeOptions: { execFile() { calls += 1; } } });
  const root = await linkedWorktree(s);
  const checkout = path.join(s.homeDir, 'checkout');
  await fs.mkdir(path.join(checkout, '.git'), { recursive: true });
  await s.post('/api/events', { session_id: 'checkout-session', hook_event_name: 'SessionStart', cwd: checkout }, hookHeaders(s.info.secret));
  const snapshot = s.runtime.state.snapshot();
  assert.deepEqual(snapshot.sessions.find(item => item.session_id === 'linked-session').worktree, { path: root, missing: false });
  assert.equal(snapshot.sessions.find(item => item.session_id === 'checkout-session').worktree, undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  await fs.unlink(path.join(root, '.git'));
  assert.equal(s.runtime.state.snapshot().sessions.find(item => item.session_id === 'linked-session').worktree.missing, true);
  const response = await s.post('/api/worktree/terminal', { session_id: 'linked-session' });
  assert.equal(response.status, 404);
  assert.match(jsonBody(response).error, /削除済み/);
});

test('ターミナルは絶対パスの wt.exe に root だけを渡し、連打を間引く', async t => {
  const calls = [];
  const s = await setup(t);
  const root = await linkedWorktree(s);
  const localAppData = path.join(s.homeDir, 'local-app-data');
  const executable = path.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe');
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, '');
  Object.assign(s.runtime.state.worktreeInfo, { platform: 'win32', environment: { LOCALAPPDATA: localAppData },
    spawn(file, args, options) {
      calls.push({ file, args, options });
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    } });
  assert.equal((await s.post('/api/worktree/terminal', { session_id: 'linked-session' })).status, 200);
  assert.deepEqual(calls, [{ file: executable, args: ['-w', 'new', '-d', root], options: { detached: true, windowsHide: true, shell: false, stdio: 'ignore' } }]);
  assert.equal((await s.post('/api/worktree/terminal', { session_id: 'linked-session' })).status, 429);
});

test('wt.exe が無ければ絶対パスの cmd と PowerShell で worktree を新しいコンソールに開き、パスはコマンド行に入れない', async t => {
  const calls = [];
  const s = await setup(t);
  const root = await linkedWorktree(s);
  const systemRoot = path.join(s.homeDir, 'windows');
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cmd = path.join(systemRoot, 'System32', 'cmd.exe');
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, '');
  await fs.writeFile(cmd, '');
  Object.assign(s.runtime.state.worktreeInfo, {
    platform: 'win32',
    environment: { LOCALAPPDATA: path.join(s.homeDir, 'no-terminal'), ProgramFiles: path.join(s.homeDir, 'no-pwsh'), SystemRoot: systemRoot },
    spawn(file, args, options) {
      calls.push({ file, args, options });
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  assert.equal((await s.post('/api/worktree/terminal', { session_id: 'linked-session' })).status, 200);
  assert.deepEqual(calls, [{ file: cmd, args: [`/d /c start "worktree" "${executable}" -NoExit`],
    options: { detached: true, windowsHide: true, shell: false, stdio: 'ignore', cwd: root, windowsVerbatimArguments: true } }]);
});

test('ターミナルが使えない OS と wt.exe のない環境は理由付きの 4xx を返す', async t => {
  const s = await setup(t);
  await linkedWorktree(s);
  const tracker = s.runtime.state.worktreeInfo;
  tracker.platform = 'linux';
  let response = await s.post('/api/worktree/terminal', { session_id: 'linked-session' });
  assert.equal(response.status, 400);
  assert.match(jsonBody(response).error, /Windows/);
  tracker.platform = 'win32';
  tracker.environment = { LOCALAPPDATA: path.join(s.homeDir, 'no-terminal') };
  response = await s.post('/api/worktree/terminal', { session_id: 'linked-session' });
  assert.equal(response.status, 404);
  assert.match(jsonBody(response).error, /wt.exe/);
});

test('base は origin HEAD が無いと main に戻し、main も無いと先行数を出さない', async t => {
  let hasMain = true;
  let now = Date.now();
  const s = await setup(t, { stateCacheNow: () => now, worktreeOptions: { now: () => now,
    execFile(file, args, options, callback) {
      const command = args.slice(2).join(' ');
      if (command === 'symbolic-ref -q refs/remotes/origin/HEAD' || (command.startsWith('show-ref') && !hasMain)) {
        callback(Object.assign(new Error('not found'), { code: 1 }));
      } else callback(null, command.startsWith('status') ? '' : command.startsWith('rev-list') ? '1\n' : 'feature/verify\n');
    } } });
  const root = await linkedWorktree(s);
  const gitDirectory = path.join(s.homeDir, 'git/worktrees/linked');
  await fs.mkdir(gitDirectory, { recursive: true });
  await fs.writeFile(path.join(gitDirectory, 'HEAD'), 'ref: refs/heads/feature/verify\n');
  s.runtime.state.addDecision('linked-session', INPUT);
  const read = async () => jsonBody(await request(s.info.port, { path: '/api/state' })).sessions.find(item => item.session_id === 'linked-session').worktree;
  assert.equal((await read()).branch, 'feature/verify');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await read()).base, 'main');
  assert.equal((await read()).ahead, 1);
  hasMain = false;
  now += 6000;
  await read();
  await new Promise(resolve => setImmediate(resolve));
  const refreshed = await read();
  assert.equal(refreshed.path, root);
  assert.equal(refreshed.base, undefined);
  assert.equal(refreshed.ahead, undefined);
});
