const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DashboardState } = require('../src/server/state');
const { AtomicJsonWriter } = require('../src/server/json-storage');
const { startTestServer, request, jsonBody, uiHeaders } = require('./support/server');
const { temporaryHome } = require('./support/temp');

async function persistenceFixture(t, options = {}) {
  const control = { fail: false, onSaved: null };
  const state = new DashboardState();
  const fixture = await startTestServer(t, { state, ...options, storageOptions: {
    persistenceRetryDelaysMs: [40, 80],
    fileSystem: { ...fs, rename: async (...args) => {
      if (control.fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      await fs.rename(...args);
      control.onSaved?.();
    } },
  } });
  state.addEvent({ session_id: 'save-session', hook_event_name: 'SessionStart', cwd: fixture.homeDir });
  const decision = state.addDecision('save-session', {
    title: '保存を確認する', context: '', state: 'provisional',
    options: [{ label: '続行', description: '', recommended: true }],
  });
  await state.flushPersistence();
  const post = (url, body = {}, headers = uiHeaders(fixture.info, `http://127.0.0.1:${fixture.info.port}`)) => request(fixture.info.port, {
    method: 'POST', path: url, headers, body: JSON.stringify(body),
  });
  t.after(() => { control.fail = false; });
  return { ...fixture, state, control, post, answer: () => post(`/api/decisions/${decision.id}/answer`, {
    session_id: 'save-session', choice: 'ok', note: '保存障害でも適用する',
  }) };
}

test('回答は保存失敗を成功応答に添え、操作がなくても復旧保存して状態APIの警告を消す', async t => {
  const f = await persistenceFixture(t);
  f.control.fail = true;
  const answer = await f.answer();
  assert.equal(answer.status, 200);
  assert.equal(jsonBody(answer).decision.answer.note, '保存障害でも適用する');
  assert.equal(jsonBody(answer).persistence.status, 'failed');
  const before = await request(f.info.port, { path: '/api/state' });
  assert.equal(jsonBody(before).persistence.files[0].errorCode, 'ENOSPC');
  assert.doesNotMatch(await fs.readFile(path.join(f.homeDir, 'store.json'), 'utf8'), /保存障害でも適用する/);
  const saved = new Promise(resolve => { f.control.onSaved = resolve; });
  f.control.fail = false;
  await saved;
  await f.state.waitForPersistence();
  assert.match(await fs.readFile(path.join(f.homeDir, 'store.json'), 'utf8'), /保存障害でも適用する/);
  const after = await request(f.info.port, { path: '/api/state', headers: { 'if-none-match': before.headers.etag } });
  assert.equal(after.status, 200);
  assert.equal(jsonBody(after).persistence.status, 'saved');
});

test('再保存の口は秘密値とOriginを照合し、障害が続く間は未保存を返す', async t => {
  const f = await persistenceFixture(t);
  f.control.fail = true;
  await f.answer();
  assert.equal((await f.post('/api/persistence/retry', {}, {})).status, 401);
  assert.equal((await f.post('/api/persistence/retry', {}, uiHeaders(f.info))).status, 403);
  assert.equal((await f.post('/api/persistence/retry', {}, uiHeaders(f.info, 'https://example.com'))).status, 403);
  assert.equal(jsonBody(await f.post('/api/persistence/retry')).persistence.status, 'failed');
  f.control.fail = false;
  assert.equal(jsonBody(await f.post('/api/persistence/retry')).persistence.status, 'saved');
});

test('再起動前の保存に失敗すると未保存の理由を返して子を起動しない', async t => {
  let spawned = false;
  const f = await persistenceFixture(t, { appVersion: 'before-update', serverRestart: {
    spawnImpl() { spawned = true; throw new Error('must not spawn'); },
  } });
  await request(f.info.port, { path: '/api/state' });
  f.control.fail = true;
  await f.answer();
  const response = await f.post('/api/server/restart');
  assert.equal(response.status, 409);
  assert.equal(jsonBody(response).error, 'Unsaved changes');
  assert.equal(jsonBody(response).persistence.status, 'failed');
  assert.equal(spawned, false);
});

test('保存できず拒否した経路設定は復旧後の再保存でも採用しない', async t => {
  const f = await persistenceFixture(t);
  await f.post('/api/routing', { key: 'review', value: 'claude' });
  f.control.fail = true;
  assert.equal((await f.post('/api/routing', { key: 'review', value: 'codex' })).status, 500);
  assert.equal(jsonBody(await request(f.info.port, { path: '/api/state' })).routing.review, 'claude');
  f.control.fail = false;
  await f.post('/api/persistence/retry');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.homeDir, 'routing.json'), 'utf8')).review, 'claude');
});

test('保存中に受けた新しい版が失敗しても古い版の成功で未保存を消さない', async t => {
  const { homeDir } = temporaryHome(t, 'cockpit-save-version-');
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let writes = 0;
  const writer = new AtomicJsonWriter(homeDir, { fileSystem: { ...fs, rename: async (...args) => {
    writes += 1;
    if (writes === 1) { entered(); await blocked; }
    if (writes === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    return fs.rename(...args);
  } } });
  t.after(() => writer.close());
  const first = writer.write('store.json', { value: 'first' });
  await started;
  const second = writer.write('store.json', { value: 'latest' });
  const failed = assert.rejects(second, { code: 'ENOSPC' });
  release();
  await first;
  await failed;
  assert.equal(writer.snapshot().status, 'failed');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8')), { value: 'first' });
  await writer.flush();
  assert.equal(writer.snapshot().status, 'saved');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8')), { value: 'latest' });
});
