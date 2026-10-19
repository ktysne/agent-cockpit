const test = require('node:test');
const assert = require('node:assert/strict');
const { DashboardState } = require('../src/server/state');
const { DecisionAnswerDelivery } = require('../src/server/decision-answers');
const { runAnswerHook } = require('../src/hooks/answer');
const { hookHeaders, request, startTestServer, uiHeaders } = require('./support/server');

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fixture(t, { sessionId = 'hook-delivery', provider = 'claude', answerNote = '最初の回答。', notify = true } = {}) {
  const now = Date.now();
  const state = new DashboardState();
  const away = { snapshot: () => ({ enabled: false, since: null }) };
  const server = await startTestServer(t, { state, away });
  state.addEvent({ session_id: sessionId, provider, hook_event_name: 'SessionStart', hookAt: now });
  const decision = state.addDecision(sessionId, {
    title: '回答をどう扱いますか。', context: '', state: 'provisional', options: [],
  }, now);
  if (answerNote !== null) server.runtime.answerDelivery.submitAnswer(sessionId, decision.id, null, answerNote);
  if (notify) server.runtime.answerDelivery.notifySessions([sessionId], 'PR の通知。');
  return { ...server, sessionId, decision, state, now };
}

function fetchToServer(server, {
  loseFirstDeliveryJson = false,
  loseFirstAcknowledgementJson = false,
  failAcknowledgement = false,
  deliveryAction = 'post-tool-batch',
  calls = [],
} = {}) {
  let lost = false;
  let lostAcknowledgement = false;
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const path = new URL(url).pathname;
    if (body.action === 'delivery-ack' && failAcknowledgement) {
      calls.push({ body, response: null });
      return { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) };
    }
    const response = await request(server.info.port, {
      method: init.method,
      path,
      headers: init.headers,
      body: init.body,
    });
    const payload = response.status === 200 ? JSON.parse(response.body) : null;
    calls.push({ body, response: payload, status: response.status });
    if (body.action === deliveryAction && loseFirstDeliveryJson && !lost) {
      lost = true;
      return { ok: response.status === 200, status: response.status, json: async () => { throw new Error('injected JSON loss'); } };
    }
    if (body.action === 'delivery-ack' && loseFirstAcknowledgementJson && !lostAcknowledgement) {
      lostAcknowledgement = true;
      return { ok: response.status === 200, status: response.status, json: async () => { throw new Error('injected ACK JSON loss'); } };
    }
    return { ok: response.status === 200, status: response.status, json: async () => payload };
  };
}

function scheduledFetchToServer(server, { deliveryDelayMs, acknowledgementDelayMs, attempts = [], calls = [] }) {
  const scheduledActions = new Set();
  const waiters = new Map();
  const waitForAction = (action) => {
    if (scheduledActions.has(action)) return Promise.resolve();
    return new Promise((resolve) => waiters.set(action, resolve));
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    attempts.push(body.action);
    scheduledActions.add(body.action);
    const waiter = waiters.get(body.action);
    waiters.delete(body.action);
    waiter?.();
    await delay(body.action === 'delivery-ack' ? acknowledgementDelayMs : deliveryDelayMs);
    if (init.signal.aborted) throw new Error('request aborted');
    const response = await request(server.info.port, {
      method: init.method,
      path: new URL(url).pathname,
      headers: init.headers,
      body: init.body,
    });
    const payload = response.status === 200 ? JSON.parse(response.body) : null;
    calls.push({ body, response: payload, status: response.status });
    return { ok: response.status === 200, status: response.status, json: async () => payload };
  };
  return { fetchImpl, waitForAction };
}

async function postHookRequest(server, body) {
  const response = await request(server.info.port, {
    method: 'POST',
    path: '/api/hooks/answers',
    headers: { 'x-cockpit-secret': server.info.secret },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: response.status === 200 ? JSON.parse(response.body) : null };
}

test('JSON 取得に失敗しても同じフック要求から回答と通知を回復する', async (t) => {
  const c = await fixture(t);
  const calls = [];
  const result = await runAnswerHook({ session_id: c.sessionId, hook_event_name: 'PostToolBatch' }, {
    homeDir: c.homeDir,
    fetchImpl: fetchToServer(c, { loseFirstDeliveryJson: true, loseFirstAcknowledgementJson: true, calls }),
  });

  const deliveryCalls = calls.filter(({ body }) => body.action === 'post-tool-batch');
  assert.equal(deliveryCalls.length, 2);
  assert.equal(deliveryCalls[0].body.id, deliveryCalls[1].body.id);
  assert.equal(deliveryCalls[0].response.deliveryId, deliveryCalls[1].response.deliveryId);
  const acknowledgementCalls = calls.filter(({ body }) => body.action === 'delivery-ack');
  assert.equal(acknowledgementCalls.length, 2);
  assert.equal(acknowledgementCalls[0].body.id, acknowledgementCalls[1].body.id);
  assert.equal(acknowledgementCalls[0].body.delivery_id, deliveryCalls[0].response.deliveryId);
  assert.match(deliveryCalls[0].response.hookOutput.hookSpecificOutput.additionalContext, /最初の回答。/);
  assert.match(deliveryCalls[0].response.hookOutput.hookSpecificOutput.additionalContext, /PR の通知。/);
  assert.match(result.output.hookSpecificOutput.additionalContext, /最初の回答。/);
  assert.match(result.output.hookSpecificOutput.additionalContext, /PR の通知。/);
  const answer = c.state.decisionFor(c.sessionId, c.decision.id).answer;
  assert.ok(answer.deliveredAt);
  assert.equal(answer.reflectedAt, null);
  assert.equal(c.runtime.answerDelivery.sessionNotifications.has(c.sessionId), false);
});

test('非対話の PostToolBatch はタスク催促を抑えつつ回答と通知を配信する', async (t) => {
  const c = await fixture(t);
  const base = c.now + 1;
  const send = (hook_event_name, hookAt, values = {}) => request(c.info.port, {
    method: 'POST', path: '/api/events', headers: hookHeaders(c.info.secret),
    body: JSON.stringify({ session_id: c.sessionId, hook_event_name, hookAt, ...values }),
  });
  await send('UserPromptSubmit', base);
  for (let index = 1; index <= 5; index += 1) await send('PreToolUse', base + index, { tool_name: 'Read' });
  const calls = [];
  const result = await runAnswerHook({ session_id: c.sessionId, hook_event_name: 'PostToolBatch' }, {
    noninteractive: true,
    homeDir: c.homeDir,
    fetchImpl: fetchToServer(c, { calls }),
  });

  const batch = calls.find(({ body }) => body.action === 'post-tool-batch');
  assert.equal(batch.body.suppress_task_reminder, true);
  assert.match(result.output.hookSpecificOutput.additionalContext, /最初の回答。/);
  assert.match(result.output.hookSpecificOutput.additionalContext, /PR の通知。/);
  assert.doesNotMatch(result.output.hookSpecificOutput.additionalContext, /タスクが登録されていない/);
});

test('Codex PostToolUse は同じ要求の再送で回答と通知を回復する', async (t) => {
  const c = await fixture(t, { sessionId: 'codex-hook-delivery', provider: 'codex' });
  const calls = [];
  const result = await runAnswerHook({ session_id: c.sessionId, hook_event_name: 'PostToolUse' }, {
    provider: 'codex',
    homeDir: c.homeDir,
    fetchImpl: fetchToServer(c, { deliveryAction: 'post-tool-use', loseFirstDeliveryJson: true, calls }),
  });

  const deliveryCalls = calls.filter(({ body }) => body.action === 'post-tool-use');
  assert.equal(deliveryCalls.length, 2);
  assert.equal(deliveryCalls[0].body.id, deliveryCalls[1].body.id);
  assert.equal(deliveryCalls[0].response.deliveryId, deliveryCalls[1].response.deliveryId);
  assert.match(result.output.hookSpecificOutput.additionalContext, /最初の回答。/);
  assert.match(result.output.hookSpecificOutput.additionalContext, /PR の通知。/);
  assert.ok(c.state.decisionFor(c.sessionId, c.decision.id).answer.deliveredAt);
  assert.equal(c.runtime.answerDelivery.sessionNotifications.has(c.sessionId), false);
});

test('Codex Stop-check は初回応答本文の喪失後も同じ世代の回答と通知を返す', async (t) => {
  const c = await fixture(t, { sessionId: 'codex-stop-delivery', provider: 'codex' });
  const calls = [];
  const result = await runAnswerHook({ session_id: c.sessionId, hook_event_name: 'Stop' }, {
    provider: 'codex',
    homeDir: c.homeDir,
    fetchImpl: fetchToServer(c, { deliveryAction: 'stop-check', loseFirstDeliveryJson: true, calls }),
  });

  const deliveryCalls = calls.filter(({ body }) => body.action === 'stop-check');
  assert.equal(deliveryCalls.length, 2);
  assert.equal(deliveryCalls[0].body.id, deliveryCalls[1].body.id);
  assert.equal(deliveryCalls[0].response.deliveryId, deliveryCalls[1].response.deliveryId);
  assert.equal(deliveryCalls[0].response.generation, deliveryCalls[1].response.generation);
  assert.match(result.output.reason, /最初の回答。/);
  assert.match(result.output.reason, /PR の通知。/);
  assert.ok(c.state.decisionFor(c.sessionId, c.decision.id).answer.deliveredAt);
  assert.equal(c.runtime.answerDelivery.sessionNotifications.has(c.sessionId), false);
});

test('ACK に失敗しても本文を取得済みのフック出力を返す', async (t) => {
  const c = await fixture(t, { notify: false });
  const calls = [];
  const result = await runAnswerHook({ session_id: c.sessionId, hook_event_name: 'PostToolBatch' }, {
    homeDir: c.homeDir,
    fetchImpl: fetchToServer(c, { failAcknowledgement: true, calls }),
  });

  assert.match(result.output.hookSpecificOutput.additionalContext, /最初の回答。/);
  assert.equal(calls.filter(({ body }) => body.action === 'delivery-ack').length, 1);
  assert.equal(c.state.decisionFor(c.sessionId, c.decision.id).answer.deliveredAt, null);
});

test('遅い配信応答の後も追加 ACK 予算内で本文を返し、受領を記録する', async (t) => {
  const c = await fixture(t, { notify: false });
  const attempts = [];
  const calls = [];
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: c.now });
  const transport = scheduledFetchToServer(c, { deliveryDelayMs: 850, acknowledgementDelayMs: 200, attempts, calls });
  const pending = runAnswerHook({ session_id: c.sessionId, hook_event_name: 'UserPromptSubmit' }, {
    homeDir: c.homeDir, now: Date.now, fetchImpl: transport.fetchImpl,
  });
  await transport.waitForAction('user-prompt-submit');
  t.mock.timers.tick(850);
  await transport.waitForAction('delivery-ack');
  t.mock.timers.tick(200);
  const result = await pending;

  assert.deepEqual(attempts, ['user-prompt-submit', 'delivery-ack']);
  assert.equal(calls.filter(({ body }) => body.action === 'delivery-ack').length, 1);
  assert.match(result.output.hookSpecificOutput.additionalContext, /最初の回答。/);
  assert.ok(c.state.decisionFor(c.sessionId, c.decision.id).answer.deliveredAt);
});

test('配信応答が早くても ACK は応答受領後 300 ms で打ち切る', async (t) => {
  const c = await fixture(t, { notify: false });
  const attempts = [];
  const calls = [];
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: c.now });
  const transport = scheduledFetchToServer(c, { deliveryDelayMs: 0, acknowledgementDelayMs: 400, attempts, calls });
  const pending = runAnswerHook({ session_id: c.sessionId, hook_event_name: 'PostToolBatch' }, {
    homeDir: c.homeDir, now: Date.now, fetchImpl: transport.fetchImpl,
  });
  await transport.waitForAction('post-tool-batch');
  t.mock.timers.tick(0);
  await transport.waitForAction('delivery-ack');
  t.mock.timers.tick(300);
  const result = await pending;

  assert.deepEqual(attempts, ['post-tool-batch', 'delivery-ack']);
  assert.equal(calls.filter(({ body }) => body.action === 'delivery-ack').length, 0);
  assert.match(result.output.hookSpecificOutput.additionalContext, /最初の回答。/);
  assert.equal(c.state.decisionFor(c.sessionId, c.decision.id).answer.deliveredAt, null);
});

test('呼び出し元が指定した絶対期限は ACK の追加予算で延長しない', async (t) => {
  const c = await fixture(t, { notify: false });
  const attempts = [];
  const calls = [];
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: c.now });
  const transport = scheduledFetchToServer(c, { deliveryDelayMs: 850, acknowledgementDelayMs: 200, attempts, calls });
  const pending = runAnswerHook({ session_id: c.sessionId, hook_event_name: 'UserPromptSubmit' }, {
    homeDir: c.homeDir, now: Date.now, deadline: Date.now() + 1_000, fetchImpl: transport.fetchImpl,
  });
  await transport.waitForAction('user-prompt-submit');
  t.mock.timers.tick(850);
  await transport.waitForAction('delivery-ack');
  t.mock.timers.tick(150);
  const result = await pending;

  assert.deepEqual(attempts, ['user-prompt-submit', 'delivery-ack']);
  assert.equal(calls.filter(({ body }) => body.action === 'delivery-ack').length, 0);
  assert.match(result.output.hookSpecificOutput.additionalContext, /最初の回答。/);
  assert.equal(c.state.decisionFor(c.sessionId, c.decision.id).answer.deliveredAt, null);
});

test('回答訂正後の同一要求は固定した旧本文を返し、旧 ACK は新しい版を確定しない', async (t) => {
  const c = await fixture(t, { notify: false });
  const requestBody = {
    action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: c.sessionId, id: 'fixed-request',
  };
  const first = await postHookRequest(c, requestBody);
  assert.equal(first.status, 200);
  const oldVersion = c.state.decisionFor(c.sessionId, c.decision.id).answer.version;
  const oldDeliveryId = first.json.deliveryId;

  const correction = await request(c.info.port, {
    method: 'POST',
    path: `/api/decisions/${c.decision.id}/answer`,
    headers: uiHeaders(c.info, `http://127.0.0.1:${c.info.port}`),
    body: JSON.stringify({ session_id: c.sessionId, choice: null, note: '訂正後の回答。' }),
  });
  assert.equal(correction.status, 200);
  const corrected = c.state.decisionFor(c.sessionId, c.decision.id).answer;
  assert.notEqual(corrected.version, oldVersion);

  const replay = await postHookRequest(c, requestBody);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.deliveryId, oldDeliveryId);
  assert.match(replay.json.hookOutput.hookSpecificOutput.additionalContext, /最初の回答。/);
  assert.doesNotMatch(replay.json.hookOutput.hookSpecificOutput.additionalContext, /訂正後の回答。/);

  const acknowledgement = await postHookRequest(c, {
    action: 'delivery-ack', event_name: 'DeliveryAck', session_id: c.sessionId, id: 'old-ack', delivery_id: oldDeliveryId,
  });
  assert.deepEqual(acknowledgement, { status: 200, json: { acknowledged: true } });
  const afterOldAck = c.state.decisionFor(c.sessionId, c.decision.id).answer;
  assert.equal(afterOldAck.version, corrected.version);
  assert.equal(afterOldAck.deliveredAt, null);
  assert.equal(afterOldAck.reflectedAt, null);

  const next = await postHookRequest(c, { ...requestBody, id: 'new-request' });
  assert.match(next.json.hookOutput.hookSpecificOutput.additionalContext, /訂正後の回答。/);
});

test('配信記録の期限後も未 ACK の回答と通知を同じ要求へ再配信する', async (t) => {
  const c = await fixture(t);
  const requestBody = {
    action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: c.sessionId, id: 'expired-request',
  };
  const first = await postHookRequest(c, requestBody);
  assert.equal(first.status, 200);
  c.runtime.answerDelivery.now = () => c.now + 11 * 60_000;

  const replay = await postHookRequest(c, requestBody);
  assert.equal(replay.status, 200);
  assert.notEqual(replay.json.deliveryId, first.json.deliveryId);
  assert.match(replay.json.hookOutput.hookSpecificOutput.additionalContext, /最初の回答。/);
  assert.match(replay.json.hookOutput.hookSpecificOutput.additionalContext, /PR の通知。/);
  assert.equal(c.state.decisionFor(c.sessionId, c.decision.id).answer.deliveredAt, null);
  assert.equal(c.runtime.answerDelivery.sessionNotifications.has(c.sessionId), true);
});

test('未 ACK 配信記録の上限超過を拒み、既存要求は再生する', async (t) => {
  const c = await fixture(t, { notify: false });
  const retainedBody = {
    action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: c.sessionId, id: 'capacity-retained',
  };
  const retained = await postHookRequest(c, retainedBody);
  assert.equal(retained.status, 200);
  for (let index = 1; index < 128; index += 1) {
    const body = {
      action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: c.sessionId, id: `capacity-${index}`,
    };
    await postHookRequest(c, body);
  }
  const blockedBody = {
    action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: c.sessionId, id: 'capacity-blocked',
  };
  assert.deepEqual(await postHookRequest(c, blockedBody), { status: 503, json: null });

  const replay = await postHookRequest(c, retainedBody);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.deliveryId, retained.json.deliveryId);
  assert.match(replay.json.hookOutput.hookSpecificOutput.additionalContext, /最初の回答。/);
});

test('古い Stop 世代の配信記録は要求から再生しない', async (t) => {
  const c = await fixture(t, { sessionId: 'stop-replay', answerNote: null, notify: false });
  const delivery = c.runtime.answerDelivery;
  const generation = delivery.startStop(c.sessionId, 'stop-one');
  delivery.recordHookDelivery({
    sessionId: c.sessionId, action: 'stop-poll', requestId: 'stop-one', requestGeneration: generation, generation,
    response: { stderrText: '古い Stop の通知。', done: true },
  });
  delivery.startStop(c.sessionId, 'stop-two');

  const response = await postHookRequest(c, {
    action: 'stop-poll', event_name: 'Stop', session_id: c.sessionId, id: 'stop-one', generation, parent_alive: true,
  });
  assert.deepEqual(response, { status: 200, json: { stderrText: null, done: true } });
});

test('空のポーリング応答を記録せず、同じ要求 ID で後から届いた回答を返す', async (t) => {
  const c = await fixture(t, { answerNote: null, notify: false });
  const requestBody = {
    action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: c.sessionId, id: 'empty-request',
  };
  const empty = await postHookRequest(c, requestBody);
  assert.deepEqual(empty, { status: 200, json: { hookOutput: null } });

  c.runtime.answerDelivery.submitAnswer(c.sessionId, c.decision.id, null, '後から届いた回答。');
  const delivered = await postHookRequest(c, requestBody);
  assert.match(delivered.json.hookOutput.hookSpecificOutput.additionalContext, /後から届いた回答。/);
  assert.equal(typeof delivered.json.deliveryId, 'string');
});

test('未 ACK 通知と上限超過の理由を store.json から復元する', async (t) => {
  const c = await fixture(t, { answerNote: null, notify: false });
  for (let index = 0; index < 20; index += 1) c.runtime.answerDelivery.notifySessions([c.sessionId], `通知 ${index}`);
  assert.equal(c.runtime.answerDelivery.notifySessions([c.sessionId], '上限後の通知'), false);
  await c.state.flushPersistence();

  const restored = await DashboardState.load(c.homeDir);
  const pending = restored.pendingSessionNotifications.get(c.sessionId);
  assert.equal(pending.length, 20);
  assert.equal(restored.pendingSessionNotificationOverflow.get(c.sessionId).count, 1);
  const delivery = new DecisionAnswerDelivery({ state: restored, away: { snapshot: () => ({ enabled: false }) } });
  assert.match(delivery.deliverSessionNotifications(c.sessionId), /1 件の通知は、未受領通知の上限に達したため登録されませんでした/);
  assert.equal(delivery.sessionNotifications.get(c.sessionId).length, 20);
});

test('明示削除したセッションの配信内容は同じ ID の再開後に再生しない', async (t) => {
  const c = await fixture(t);
  const requestBody = {
    action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: c.sessionId, id: 'deleted-session-request',
  };
  const first = await postHookRequest(c, requestBody);
  assert.match(first.json.hookOutput.hookSpecificOutput.additionalContext, /最初の回答。/);
  assert.equal(c.state.pendingHookDeliveries.has(c.sessionId), true);

  const deletion = await request(c.info.port, {
    method: 'POST', path: '/api/record-deletions',
    headers: uiHeaders(c.info, `http://127.0.0.1:${c.info.port}`),
    body: JSON.stringify({ session_ids: [c.sessionId] }),
  });
  assert.equal(deletion.status, 200);
  assert.equal(c.state.pendingHookDeliveries.has(c.sessionId), false);
  assert.equal(c.state.pendingSessionNotifications.has(c.sessionId), false);

  c.state.addEvent({ session_id: c.sessionId, provider: 'claude', hook_event_name: 'SessionStart', hookAt: Date.now() });
  const reopened = await postHookRequest(c, requestBody);
  assert.deepEqual(reopened.json, { hookOutput: null });
});

test('store 整理で期限切れ配信記録と14日を過ぎた通知だけの保存セッションを削除する', async (t) => {
  const c = await fixture(t, { answerNote: null });
  const response = await postHookRequest(c, {
    action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: c.sessionId, id: 'prune-request',
  });
  assert.match(response.json.hookOutput.hookSpecificOutput.additionalContext, /PR の通知/);

  const oldAt = new Date(c.now - 15 * 24 * 60 * 60 * 1000).toISOString();
  c.state.pendingSessionNotifications.get(c.sessionId)[0].createdAt = oldAt;
  const [delivery] = c.state.pendingHookDeliveries.get(c.sessionId).values();
  delivery.expiresAt = oldAt;
  c.state.plans.delete(c.sessionId);
  c.state.touch();
  c.state.requestStoreWrite(true);
  await c.state.flushPersistence();

  const restored = await DashboardState.load(c.homeDir, { now: c.now });
  assert.equal(restored.pendingHookDeliveries.has(c.sessionId), false);
  assert.equal(restored.pendingSessionNotifications.get(c.sessionId).length, 1);
  restored.pruneExpiredStoreRecords(c.now + 10 * 60 * 1000 + 1);
  assert.equal(restored.pendingSessionNotifications.has(c.sessionId), false);
});

