const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { recommendedOptionFor, sanitizeQuestions, sanitizeEvent } = require('../src/server/events');
const { DashboardState } = require('../src/server/state');
const {
  ANSWER_WAIT_MS,
  DecisionAnswerDelivery,
  askAnswerOutput,
  canAnswerDecision,
  denyAnswerOutput,
} = require('../src/server/decision-answers');
const { runAnswerHook, runAskQuestion } = require('../src/hooks/answer');
const { startServer } = require('../src/server/server');

const NOW = Date.UTC(2026, 9, 2, 1, 2, 3);
const QUESTIONS = [{
  question: 'どの形式にしますか。',
  header: '形式',
  multiSelect: false,
  options: [
    { label: 'JSON', description: 'recommended: 既存 API と一致する。' },
    { label: 'CSV', description: '表計算で開ける。' },
  ],
}];

class FakeClock {
  constructor(now = NOW) {
    this.value = now;
    this.sequence = 0;
    this.timers = new Map();
  }

  now() {
    return this.value;
  }

  setTimeout(callback, milliseconds) {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.value + milliseconds, callback });
    return id;
  }

  clearTimeout(id) {
    this.timers.delete(id);
  }

  advance(milliseconds) {
    const target = this.value + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      this.value = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.value = target;
  }
}

function makeFixture(options = {}) {
  const clock = new FakeClock(options.now ?? NOW);
  const state = new DashboardState();
  const sessionId = options.sessionId || 'session-a';
  const toolUseId = options.toolUseId || 'ask-1';
  const questions = options.questions || QUESTIONS;
  const away = {
    enabled: options.awayEnabled !== false,
    snapshot() {
      return { enabled: this.enabled, since: this.enabled ? NOW : null };
    },
  };
  state.addEvent({ session_id: sessionId, hook_event_name: 'SessionStart', hookAt: clock.now() });
  const delivery = new DecisionAnswerDelivery({
    state,
    away,
    now: () => clock.now(),
    setTimeoutImpl: (callback, milliseconds) => clock.setTimeout(callback, milliseconds),
    clearTimeoutImpl: (id) => clock.clearTimeout(id),
    answerWaitMs: options.answerWaitMs || ANSWER_WAIT_MS,
    maxLongPollMs: options.maxLongPollMs || 25_000,
  });
  const registration = delivery.registerAsk({ sessionId, toolUseId, questions });
  return { clock, state, away, delivery, registration, sessionId, toolUseId };
}

async function temporaryHome(testContext) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-answer-test-'));
  testContext.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  return { homeDir, claudeHome: path.join(homeDir, '.claude') };
}

async function request(port, options = {}) {
  const body = options.body || '';
  const headers = { ...options.headers };
  if (body && headers['content-length'] === undefined) headers['content-length'] = Buffer.byteLength(body);
  if (headers.host === undefined) headers.host = `127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const client = http.request({
      host: '127.0.0.1',
      port,
      path: options.path || '/',
      method: options.method || 'GET',
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    client.once('error', reject);
    client.end(body);
  });
}

function responseJson(response) {
  return JSON.parse(response.body);
}

test('推奨は label と description の日本語・英語を見て単一選択の一つだけに決める', () => {
  const fromLabel = recommendedOptionFor({ multiSelect: false, options: [{ label: '推奨: JSON', description: '' }] });
  const fromDescription = recommendedOptionFor({ multiSelect: false, options: [{ label: 'CSV', description: 'recommended for spreadsheets' }] });
  const fromFlag = recommendedOptionFor({ multiSelect: false, options: [{ label: 'REST', description: '', recommended: true }] });
  const twoMatches = recommendedOptionFor({
    multiSelect: false,
    options: [{ label: '推奨 JSON', description: '' }, { label: 'CSV', description: 'recommended' }],
  });
  const multiple = recommendedOptionFor({ multiSelect: true, options: [{ label: '推奨 JSON', description: '' }] });

  assert.equal(fromLabel.label, '推奨: JSON');
  assert.equal(fromDescription.label, 'CSV');
  assert.equal(fromFlag.label, 'REST');
  assert.equal(twoMatches, null);
  assert.equal(multiple, null);
  assert.equal(sanitizeQuestions(QUESTIONS)[0].options[0].recommended, true);
});

test('推奨案で OK は推奨 label を使い、指示と保留の文脈を添える', () => {
  const decision = { id: 'ask-1', questions: sanitizeQuestions(QUESTIONS) };
  const ok = askAnswerOutput(decision, { choice: 'ok', note: '' });
  const okWithNote = askAnswerOutput(decision, { choice: 'ok', note: '理由を記録する。' });
  const hold = askAnswerOutput(decision, { choice: 'hold', note: '' });

  assert.equal(ok.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(ok.hookSpecificOutput.updatedInput.answers, { 'どの形式にしますか。': 'JSON' });
  assert.deepEqual(ok.hookSpecificOutput.updatedInput.questions[0].options, [
    { label: 'JSON', description: 'recommended: 既存 API と一致する。' },
    { label: 'CSV', description: '表計算で開ける。' },
  ]);
  assert.match(okWithNote.hookSpecificOutput.additionalContext, /開発者の指示: 理由を記録する。/);
  assert.match(hold.hookSpecificOutput.additionalContext, /開発者が判断を保留した。推奨のまま進め/);
  assert.deepEqual(hold.hookSpecificOutput.updatedInput.answers, { 'どの形式にしますか。': 'JSON' });
});

test('指示だけの回答は指示文を answers に入れる', () => {
  const decision = { id: 'ask-1', questions: sanitizeQuestions(QUESTIONS) };
  const output = askAnswerOutput(decision, { choice: null, note: 'CSV を選んでください。' });

  assert.equal(output.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(output.hookSpecificOutput.updatedInput.answers, { 'どの形式にしますか。': 'CSV を選んでください。' });
  assert.equal(output.hookSpecificOutput.additionalContext, undefined);
});

test('推奨がない質問の OK と保留は拒否結末と同じ出力になる', () => {
  const decision = {
    id: 'ask-no-recommendation',
    questions: sanitizeQuestions([{ ...QUESTIONS[0], options: [{ label: 'JSON', description: '' }] }]),
  };

  assert.deepEqual(askAnswerOutput(decision, { choice: 'ok', note: '' }), denyAnswerOutput(decision.id));
  assert.deepEqual(askAnswerOutput(decision, { choice: 'hold', note: '' }), denyAnswerOutput(decision.id));
});

test('推奨が無い質問の OK は送れず、保留は締切として処理して後から再配信しない', async () => {
  const fixture = makeFixture({ questions: [{
    question: 'どの形式にしますか。', header: '', multiSelect: false,
    options: [{ label: 'JSON', description: '' }],
  }] });
  const { delivery, state, sessionId, toolUseId, registration } = fixture;

  assert.equal(delivery.submitAnswer(sessionId, registration.decisionId, 'ok', ''), false);
  delivery.submitAnswer(sessionId, registration.decisionId, 'hold', 'あとで決める。');
  const { outcome } = await delivery.waitForAsk({ sessionId, toolUseId });
  assert.equal(outcome, 'timeout');
  delivery.finishAsk({ sessionId, toolUseId, outcome });
  assert.equal(state.decisionFor(sessionId, registration.decisionId).state, 'provisional');
  assert.ok(state.decisionFor(sessionId, registration.decisionId).answer.ignoredAt);
  assert.equal(delivery.deliverPending(sessionId), null);
  delivery.afterDecisionUpdate(sessionId, registration.decisionId);
  assert.equal(state.decisionFor(sessionId, registration.decisionId).answer.reflectedAt, null);
});

test('同じ質問文が重複する判断事項はダッシュボードから回答できない', () => {
  const question = sanitizeQuestions(QUESTIONS)[0];
  assert.equal(canAnswerDecision({
    state: 'waiting', questions: [question, { ...question, header: '別の見出し' }],
  }), false);
});

test('重複質問は待機期限を付けず、デスクトップアプリのダイアログへ通す', () => {
  const state = new DashboardState();
  state.addEvent({ session_id: 'session-duplicate', hook_event_name: 'SessionStart', hookAt: NOW });
  const delivery = new DecisionAnswerDelivery({ state, away: { snapshot: () => ({ enabled: true }) }, now: () => NOW });
  const repeated = [{ ...QUESTIONS[0], question: '同じ質問。' }, { ...QUESTIONS[0], question: '同じ質問。' }];
  const registration = delivery.registerAsk({ sessionId: 'session-duplicate', toolUseId: 'ask-duplicate', questions: repeated });
  const decision = state.decisionFor('session-duplicate', 'ask-duplicate');

  assert.deepEqual(registration, { awaiting: false, hookOutput: null });
  assert.equal(decision.state, 'waiting');
  assert.equal(decision.awaitingAnswerUntil, undefined);
  assert.equal(delivery.askWaits.size, 0);
});

test('最初に常駐サーバーへ届かないときは AskUserQuestion を止めない', async (t) => {
  const { homeDir } = await temporaryHome(t);
  let requests = 0;
  const output = await runAskQuestion({
    session_id: 'session-offline', tool_use_id: 'ask-offline', tool_name: 'AskUserQuestion',
    tool_input: { questions: QUESTIONS },
  }, { homeDir, fetchImpl: async () => { requests += 1; throw new Error('unavailable'); } });

  assert.equal(output, null);
  assert.equal(requests, 0);
});

test('同じ tool_use_id の登録は冪等で、束ね直した質問では前の回答を使わない', async () => {
  const fixture = makeFixture();
  const { delivery, state, clock, sessionId, toolUseId, registration } = fixture;
  const version = state.version;
  const repeated = delivery.registerAsk({ sessionId, toolUseId, questions: QUESTIONS });
  assert.equal(repeated.decisionId, registration.decisionId);
  assert.equal(repeated.deadline, registration.deadline);
  assert.equal(state.version, version);
  fixture.away.enabled = false;
  assert.equal(delivery.registerAsk({ sessionId, toolUseId, questions: QUESTIONS }).decisionId, registration.decisionId);
  fixture.away.enabled = true;

  assert.ok(delivery.submitAnswer(sessionId, registration.decisionId, 'ok', '前回の回答'));
  const { outcome } = await delivery.waitForAsk({ sessionId, toolUseId });
  const finished = delivery.finishAsk({ sessionId, toolUseId, outcome });
  assert.ok(delivery.submitAnswer(sessionId, registration.decisionId, 'ok', '送り直した回答'));
  assert.equal(state.decisionFor(sessionId, registration.decisionId).answer.note, '送り直した回答');
  const afterFinishVersion = state.version;
  const finishedRegistration = delivery.registerAsk({ sessionId, toolUseId, questions: QUESTIONS });
  assert.equal(finishedRegistration.decisionId, registration.decisionId);
  assert.equal(state.version, afterFinishVersion);
  assert.deepEqual(delivery.finishAsk({ sessionId, toolUseId, outcome: 'timeout' }), finished);

  clock.advance(1_000);
  const revisedQuestions = [{
    ...QUESTIONS[0],
    options: [{ label: 'TOML', description: 'recommended for configuration' }, { label: 'CSV', description: '' }],
  }];
  const bundled = delivery.registerAsk({ sessionId, toolUseId: 'ask-2', questions: revisedQuestions });

  assert.equal(bundled.decisionId, registration.decisionId);
  assert.equal(state.decisionIdForToolUse(sessionId, 'ask-2'), registration.decisionId);
  assert.equal(state.decisionsFor(sessionId).length, 1);
  assert.equal(state.decisionFor(sessionId, registration.decisionId).answer, null);
  assert.equal(state.decisionFor(sessionId, registration.decisionId).questions[0].options[0].label, 'TOML');
  assert.equal(state.decisionFor(sessionId, registration.decisionId).questions[0].options[0].recommended, true);
  assert.equal(state.decisionFor(sessionId, registration.decisionId).awaitingAnswerUntil, new Date(clock.now() + ANSWER_WAIT_MS).toISOString());
});

test('締切は注入した時計で管理され、未回答の質問を推奨で進める結末にする', () => {
  const fixture = makeFixture({ answerWaitMs: 500 });
  const { clock, delivery, state, sessionId, toolUseId, registration } = fixture;
  clock.advance(499);
  assert.equal(state.decisionFor(sessionId, registration.decisionId).state, 'waiting');

  clock.advance(1);
  const polled = delivery.waitForAsk({ sessionId, toolUseId });
  return polled.then(({ outcome }) => {
    assert.equal(outcome, 'timeout');
    const finished = delivery.finishAsk({ sessionId, toolUseId, outcome });
    assert.deepEqual(finished.hookOutput, denyAnswerOutput(registration.decisionId));
    assert.equal(state.decisionFor(sessionId, registration.decisionId).state, 'provisional');
    assert.equal(state.decisionFor(sessionId, registration.decisionId).awaitingAnswerUntil, undefined);
  });
});

test('回答待ちの long-poll は 25 秒を上限にし、回答で起きる', async () => {
  const fixture = makeFixture({ answerWaitMs: 60_000, maxLongPollMs: 25_000 });
  const { clock, delivery, sessionId, toolUseId, registration } = fixture;
  const waiting = delivery.waitForAsk({ sessionId, toolUseId });
  assert.ok([...clock.timers.values()].some((timer) => timer.at - clock.now() === 25_000));

  clock.advance(25_000);
  assert.deepEqual(await waiting, { outcome: 'waiting' });
  const nextPoll = delivery.waitForAsk({ sessionId, toolUseId });
  delivery.submitAnswer(sessionId, registration.decisionId, 'ok', '');
  assert.deepEqual(await nextPoll, { outcome: 'answered' });
});

test('離席中の解除は待機中の質問をダイアログへ戻す', async () => {
  const fixture = makeFixture();
  const { delivery, away, state, sessionId, toolUseId, registration } = fixture;
  const waiting = delivery.waitForAsk({ sessionId, toolUseId });
  away.enabled = false;
  delivery.signalAll();

  assert.deepEqual(await waiting, { outcome: 'released' });
  assert.deepEqual(delivery.finishAsk({ sessionId, toolUseId, outcome: 'released' }), { outcome: 'released', hookOutput: null });
  assert.equal(state.decisionFor(sessionId, registration.decisionId).state, 'waiting');
  assert.equal(state.decisionFor(sessionId, registration.decisionId).awaitingAnswerUntil, undefined);
});

test('保留の回答は PostToolUse 後も provisional に残し、通常の回答は resolved にする', async () => {
  const held = makeFixture();
  const heldId = held.registration.decisionId;
  held.delivery.submitAnswer(held.sessionId, heldId, 'hold', 'あとで見直す。');
  const holdOutcome = await held.delivery.waitForAsk({ sessionId: held.sessionId, toolUseId: held.toolUseId });
  held.delivery.finishAsk({ ...holdOutcome, sessionId: held.sessionId, toolUseId: held.toolUseId });
  held.state.addEvent({
    session_id: held.sessionId, hook_event_name: 'PostToolUse', hookAt: held.clock.now() + 10,
    tool_name: 'AskUserQuestion', tool_use_id: held.toolUseId,
    decisionResolution: { chosen: ['JSON'], note: '' },
  });
  held.delivery.afterEvent(sanitizeEvent({
    session_id: held.sessionId, hook_event_name: 'PostToolUse', hookAt: held.clock.now() + 10,
    tool_name: 'AskUserQuestion', tool_use_id: held.toolUseId,
  }));

  const holdDecision = held.state.decisionFor(held.sessionId, heldId);
  assert.equal(holdDecision.state, 'provisional');
  assert.ok(holdDecision.answer.reflectedAt);

  const answered = makeFixture({ sessionId: 'session-b', toolUseId: 'ask-b' });
  const answeredId = answered.registration.decisionId;
  answered.delivery.submitAnswer(answered.sessionId, answeredId, 'ok', '');
  const outcome = await answered.delivery.waitForAsk({ sessionId: answered.sessionId, toolUseId: answered.toolUseId });
  answered.delivery.finishAsk({ ...outcome, sessionId: answered.sessionId, toolUseId: answered.toolUseId });
  answered.state.addEvent({
    session_id: answered.sessionId, hook_event_name: 'PostToolUse', hookAt: answered.clock.now() + 10,
    tool_name: 'AskUserQuestion', tool_use_id: answered.toolUseId,
    decisionResolution: { chosen: ['JSON'], note: '' },
  });
  answered.delivery.afterEvent(sanitizeEvent({
    session_id: answered.sessionId, hook_event_name: 'PostToolUse', hookAt: answered.clock.now() + 10,
    tool_name: 'AskUserQuestion', tool_use_id: answered.toolUseId,
  }));
  assert.equal(answered.state.decisionFor(answered.sessionId, answeredId).state, 'resolved');
});

test('PostToolBatch は回答文を追加コンテキストで一度だけ渡す', () => {
  const state = new DashboardState();
  const away = { snapshot: () => ({ enabled: true }) };
  const delivery = new DecisionAnswerDelivery({ state, away, now: () => NOW });
  const decision = state.addDecision('session-batch', {
    title: 'どの方式にしますか。', context: '通信方式', state: 'provisional',
    options: [{ label: '推奨: REST', description: '単純。' }],
  }, NOW);
  delivery.submitAnswer('session-batch', decision.id, null, '期限付きで進める。');

  const context = delivery.deliverPending('session-batch');
  const updated = state.decisionFor('session-batch', decision.id);
  assert.match(context, new RegExp(`判断事項 ${decision.id}`));
  assert.match(context, /指示のみ/);
  assert.match(context, /期限付きで進める。/);
  assert.ok(updated.answer.deliveredAt);
  assert.equal(delivery.deliverPending('session-batch'), null);
});

test('UserPromptSubmit は未反映の回答を最大 3 回差し込み、反映後は止める', () => {
  const state = new DashboardState();
  const away = { snapshot: () => ({ enabled: false }) };
  const delivery = new DecisionAnswerDelivery({ state, away, now: () => NOW });
  const decision = state.addDecision('session-prompt', {
    title: 'ログを残すか。', context: '', state: 'provisional', options: [],
  }, NOW);
  delivery.submitAnswer('session-prompt', decision.id, null, 'ログを残す。');

  assert.match(delivery.deliverPrompt('session-prompt', 'prompt-1', NOW + 1), /ログを残す。/);
  assert.match(delivery.deliverPrompt('session-prompt', 'prompt-2', NOW + 2), /ログを残す。/);
  assert.match(delivery.deliverPrompt('session-prompt', 'prompt-3', NOW + 3), /ログを残す。/);
  assert.equal(delivery.state.decisionFor('session-prompt', decision.id).answer.promptDeliveries, 3);
  assert.equal(delivery.deliverPrompt('session-prompt', 'prompt-4', NOW + 4), null);

  delivery.afterDecisionUpdate('session-prompt', decision.id);
  assert.ok(state.decisionFor('session-prompt', decision.id).answer.reflectedAt);
  assert.equal(delivery.deliverPrompt('session-prompt', 'prompt-5', NOW + 5), null);
});

test('後続の Stop、UserPromptSubmit、SessionEnd、親の終了で Stop の待機を終える', async () => {
  for (const ending of ['Stop', 'UserPromptSubmit', 'SessionEnd']) {
    const state = new DashboardState();
    const away = { snapshot: () => ({ enabled: false }) };
    const delivery = new DecisionAnswerDelivery({ state, away, now: () => NOW });
    const generation = delivery.startStop('session-stop', 'stop-1', NOW);
    const waiting = delivery.waitForStopAnswer('session-stop', generation);
    if (ending === 'Stop') delivery.startStop('session-stop', 'stop-2', NOW + 1);
    else delivery.handleLifecycleEvent('session-stop', ending, `${ending}-1`, NOW + 1);
    assert.deepEqual(await waiting, { stderrText: null, done: true });
  }

  const delivery = new DecisionAnswerDelivery({
    state: new DashboardState(), away: { snapshot: () => ({ enabled: false }) }, now: () => NOW,
  });
  assert.deepEqual(await delivery.waitForStopAnswer('session-parent', 0, false), { stderrText: null, done: true });
});

test('Stop の long-poll は 25 秒で再待機できる状態を返す', async () => {
  const clock = new FakeClock();
  const delivery = new DecisionAnswerDelivery({
    state: new DashboardState(),
    away: { snapshot: () => ({ enabled: false }) },
    now: () => clock.now(),
    setTimeoutImpl: (callback, milliseconds) => clock.setTimeout(callback, milliseconds),
    clearTimeoutImpl: (id) => clock.clearTimeout(id),
    maxLongPollMs: 25_000,
  });
  const generation = delivery.startStop('session-stop-poll', 'stop-1', NOW);
  const poll = delivery.waitForStopAnswer('session-stop-poll', generation);
  assert.ok([...clock.timers.values()].some((timer) => timer.at - clock.now() === 25_000));

  clock.advance(25_000);
  assert.deepEqual(await poll, { stderrText: null, done: false });
});

test('サブエージェントの answer フックはイベント種別にかかわらず通信しない', async () => {
  let requests = 0;
  const options = { fetchImpl: async () => { requests += 1; throw new Error('unexpected network request'); } };
  for (const hookEventName of ['PostToolBatch', 'Stop', 'UserPromptSubmit']) {
    const result = await runAnswerHook({ hook_event_name: hookEventName, session_id: 'session-agent', agent_id: 'agent-1' }, options);
    assert.equal(result.output || result.stderrText, null);
  }
  assert.equal(requests, 0);
});

test('離席中のサブエージェント質問は deny し、判断事項を作らない', () => {
  const state = new DashboardState();
  state.addEvent({ session_id: 'session-agent-ask', hook_event_name: 'SessionStart', hookAt: NOW });
  const delivery = new DecisionAnswerDelivery({ state, away: { snapshot: () => ({ enabled: true }) }, now: () => NOW });
  const result = delivery.registerAsk({
    sessionId: 'session-agent-ask',
    toolUseId: 'agent-ask',
    questions: QUESTIONS,
    agentId: 'agent-1',
  });

  assert.deepEqual(result.hookOutput, denyAnswerOutput('agent-ask'));
  assert.deepEqual(state.decisionsFor('session-agent-ask'), []);
});

test('回答待ち中の再接続失敗は server-lost の deny 出力を返す', async (t) => {
  const { homeDir } = await temporaryHome(t);
  await fs.writeFile(path.join(homeDir, 'server.json'), JSON.stringify({ port: 47821, secret: 'hook-secret', pid: 1, startedAt: 'now' }));
  let first = true;
  const requests = [];
  const output = await runAskQuestion({
    session_id: 'session-lost', tool_use_id: 'ask-lost', tool_name: 'AskUserQuestion',
    tool_input: { questions: QUESTIONS },
  }, {
    homeDir,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      const body = JSON.parse(init.body);
      if (first && body.action === 'ask-register') {
        first = false;
        return { ok: true, json: async () => ({ awaiting: true, decisionId: 'ask-lost' }) };
      }
      throw new Error('server unavailable');
    },
  });

  assert.deepEqual(output, denyAnswerOutput('ask-lost'));
  assert.equal(requests[0].init.headers['x-cockpit-secret'], 'hook-secret');
  assert.equal(requests[0].init.headers.origin, undefined);
  assert.equal(requests[0].url, 'http://127.0.0.1:47821/api/hooks/answers');
});

test('server-lost の結末は判断事項を provisional にする', () => {
  const fixture = makeFixture();
  const result = fixture.delivery.finishAsk({
    sessionId: fixture.sessionId,
    toolUseId: fixture.toolUseId,
    decisionId: fixture.registration.decisionId,
    outcome: 'server-lost',
  });

  assert.deepEqual(result.hookOutput, denyAnswerOutput(fixture.registration.decisionId));
  assert.equal(fixture.state.decisionFor(fixture.sessionId, fixture.registration.decisionId).state, 'provisional');
});

test('UI 回答の Origin と秘密値を照合し、回答を別セッションへ渡さない', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'session-ui', hook_event_name: 'SessionStart', hookAt: NOW });
  const away = {
    snapshot: () => ({ enabled: true, since: NOW }),
    setEnabled: async (enabled) => ({ enabled, since: enabled ? NOW : null }),
  };
  const runtime = await startServer({ homeDir, claudeHome, port: 0, state, away });
  t.after(() => runtime.close());
  runtime.answerDelivery.registerAsk({ sessionId: 'session-ui', toolUseId: 'ask-ui', questions: QUESTIONS });
  const url = `/api/decisions/ask-ui/answer`;
  const body = JSON.stringify({ session_id: 'session-ui', choice: 'ok', note: 'UI からの回答本文' });
  const origin = `http://127.0.0.1:${runtime.info.port}`;
  const uiHeaders = { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin };

  const missingOrigin = await request(runtime.info.port, {
    method: 'POST', path: url, body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret },
  });
  assert.equal(missingOrigin.status, 403);
  const foreignOrigin = await request(runtime.info.port, {
    method: 'POST', path: url, body, headers: { ...uiHeaders, origin: 'https://other.example' },
  });
  assert.equal(foreignOrigin.status, 403);
  const wrongFetchSite = await request(runtime.info.port, {
    method: 'POST', path: url, body, headers: { ...uiHeaders, 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(wrongFetchSite.status, 403);
  const wrongSecret = await request(runtime.info.port, {
    method: 'POST', path: url, body, headers: { ...uiHeaders, 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(wrongSecret.status, 401);
  const otherSession = await request(runtime.info.port, {
    method: 'POST', path: url,
    body: JSON.stringify({ session_id: 'session-other', choice: 'ok', note: '混ぜない' }),
    headers: uiHeaders,
  });
  assert.equal(otherSession.status, 404);

  const sent = await request(runtime.info.port, { method: 'POST', path: url, body, headers: uiHeaders });
  assert.equal(sent.status, 200);
  assert.equal(state.decisionFor('session-ui', 'ask-ui').answer.note, 'UI からの回答本文');

  const askOutput = await runAnswerHook({
    session_id: 'session-ui', tool_use_id: 'ask-ui', hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS },
  }, { homeDir });
  assert.deepEqual(askOutput.output.hookSpecificOutput.updatedInput.answers, { 'どの形式にしますか。': 'JSON' });

  const hookWithUiSecret = await request(runtime.info.port, {
    method: 'POST', path: '/api/hooks/answers', body: JSON.stringify({
      action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: 'session-ui', id: 'hook-1',
    }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret },
  });
  assert.equal(hookWithUiSecret.status, 401);
  const hookWithOrigin = await request(runtime.info.port, {
    method: 'POST', path: '/api/hooks/answers', body: JSON.stringify({
      action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: 'session-ui', id: 'hook-2',
    }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret, origin },
  });
  assert.equal(hookWithOrigin.status, 403);

  const privateDecision = state.addDecision('session-other', {
    title: '他セッションの設定', context: '', state: 'provisional', options: [],
  }, NOW);
  runtime.answerDelivery.submitAnswer('session-other', privateDecision.id, null, '他セッションだけに渡す本文');
  const isolated = await runAnswerHook({ hook_event_name: 'PostToolBatch', session_id: 'session-ui' }, { homeDir });
  assert.equal(isolated.output, null);
  const delivered = await runAnswerHook({ hook_event_name: 'PostToolBatch', session_id: 'session-other' }, { homeDir });
  assert.match(delivered.output.hookSpecificOutput.additionalContext, /他セッションだけに渡す本文/);
  assert.doesNotMatch(delivered.output.hookSpecificOutput.additionalContext, /UI からの回答本文/);
  const persistedText = (await Promise.all((await fs.readdir(homeDir)).map((name) => (
    fs.readFile(path.join(homeDir, name), 'utf8')
  )))).join('\n');
  assert.doesNotMatch(persistedText, /UI からの回答本文|他セッションだけに渡す本文/);
});

test('PostToolBatch、Stop asyncRewake、MCP 更新が配信と反映の印を付ける', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const state = new DashboardState();
  const away = {
    snapshot: () => ({ enabled: false, since: null }),
    setEnabled: async (enabled) => ({ enabled, since: enabled ? NOW : null }),
  };
  const runtime = await startServer({ homeDir, claudeHome, port: 0, state, away });
  t.after(() => runtime.close());

  const batchDecision = state.addDecision('session-delivery', {
    title: '期限をどうしますか。', context: '', state: 'provisional', options: [],
  }, NOW);
  runtime.answerDelivery.submitAnswer('session-delivery', batchDecision.id, null, '期限を 1 日にする。');
  const batch = await runAnswerHook({ hook_event_name: 'PostToolBatch', session_id: 'session-delivery' }, { homeDir });
  assert.match(batch.output.hookSpecificOutput.additionalContext, /期限を 1 日にする。/);
  assert.ok(state.decisionFor('session-delivery', batchDecision.id).answer.deliveredAt);

  const stopDecision = state.addDecision('session-stop', {
    title: '削除方法を決める。', context: '', state: 'provisional', options: [],
  }, NOW);
  runtime.answerDelivery.submitAnswer('session-stop', stopDecision.id, null, '退避後に削除する。');
  const stop = await runAnswerHook({ hook_event_name: 'Stop', session_id: 'session-stop' }, {
    homeDir, parentPid: process.pid, isParentAlive: () => true,
  });
  assert.equal(stop.exitCode, 2);
  assert.match(stop.stderrText, /退避後に削除する。/);
  assert.ok(state.decisionFor('session-stop', stopDecision.id).answer.deliveredAt);

  const updateDecision = state.addDecision('session-update', {
    title: '状態を決める。', context: '', state: 'provisional', options: [],
  }, NOW);
  runtime.answerDelivery.submitAnswer('session-update', updateDecision.id, null, '状態を固定する。');
  assert.match(runtime.answerDelivery.deliverPending('session-update'), /状態を固定する。/);
  const update = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/session-update/plan',
    body: JSON.stringify({ kind: 'update_decision', id: updateDecision.id, state: 'resolved', chosen: [], note: '' }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(update.status, 200);
  const reflected = state.decisionFor('session-update', updateDecision.id);
  assert.equal(reflected.state, 'resolved');
  assert.ok(reflected.answer.reflectedAt);

  const promptDecision = state.addDecision('session-prompt-hook', {
    title: '保存方法を選ぶ。', context: '', state: 'provisional', options: [],
  }, NOW);
  runtime.answerDelivery.submitAnswer('session-prompt-hook', promptDecision.id, null, '暗号化して保存する。');
  const prompt = await runAnswerHook({ hook_event_name: 'UserPromptSubmit', session_id: 'session-prompt-hook' }, { homeDir });
  assert.match(prompt.output.hookSpecificOutput.additionalContext, /暗号化して保存する。/);
  assert.equal(state.decisionFor('session-prompt-hook', promptDecision.id).answer.promptDeliveries, 1);

  const parentGone = await runAnswerHook({ hook_event_name: 'Stop', session_id: 'session-empty' }, {
    homeDir, parentPid: 0, isParentAlive: () => false,
  });
  assert.deepEqual(parentGone, { exitCode: 0, stderrText: null });
});
