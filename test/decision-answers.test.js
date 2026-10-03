const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { recommendedOptionFor, sanitizeQuestions, sanitizeEvent } = require('../src/server/events');
const { DashboardState } = require('../src/server/state');
const {
  ANSWER_WAIT_MS,
  MAX_ASK_POLL_GAP_MS,
  DecisionAnswerDelivery,
  askAnswerOutput,
  canAnswerDecision,
  decisionAnswerText,
  denyAnswerOutput,
} = require('../src/server/decision-answers');
const { runAnswerHook, runAskQuestion, runStop } = require('../src/hooks/answer');
const { makeHookEvent } = require('../src/hooks/event');
const { startServer } = require('../src/server/server');

const NOW = Date.UTC(2026, 9, 2, 1, 2, 3);
const QUESTIONS = [{
  question: 'どの形式にしますか。',
  header: '形式',
  multiSelect: false,
  options: [
    { label: 'JSON (推奨)', description: '既存 API と一致する。' },
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
    maxAskPollGapMs: options.maxAskPollGapMs || MAX_ASK_POLL_GAP_MS,
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

test('推奨は label の括弧付き指定か MCP の明示指定だけを単一選択から決める', () => {
  const fromLabel = recommendedOptionFor({ multiSelect: false, options: [{ label: 'JSON (推奨)', description: '' }] });
  const fromFullWidthJapaneseLabel = recommendedOptionFor({ multiSelect: false, options: [{ label: '（推奨）JSON', description: '' }] });
  const fromFullWidthLabel = recommendedOptionFor({ multiSelect: false, options: [{ label: '（Recommended）REST', description: '' }] });
  const fromDescription = recommendedOptionFor({ multiSelect: false, options: [{ label: 'CSV', description: 'recommended for spreadsheets' }] });
  const falseJapaneseMatch = recommendedOptionFor({ multiSelect: false, options: [{ label: '非推奨: JSON', description: '' }] });
  const falseEnglishMatch = recommendedOptionFor({ multiSelect: false, options: [{ label: 'not recommended', description: '' }] });
  const fromFlag = recommendedOptionFor({ multiSelect: false, options: [{ label: 'REST', description: '', recommended: true }] });
  const twoMatches = recommendedOptionFor({
    multiSelect: false,
    options: [{ label: 'JSON (推奨)', description: '' }, { label: '(Recommended) CSV', description: '' }],
  });
  const multiple = recommendedOptionFor({ multiSelect: true, options: [{ label: '推奨 JSON', description: '' }] });

  assert.equal(fromLabel.label, 'JSON (推奨)');
  assert.equal(fromFullWidthJapaneseLabel.label, '（推奨）JSON');
  assert.equal(fromFullWidthLabel.label, '（Recommended）REST');
  assert.equal(fromDescription, null);
  assert.equal(falseJapaneseMatch, null);
  assert.equal(falseEnglishMatch, null);
  assert.equal(fromFlag.label, 'REST');
  assert.equal(twoMatches, null);
  assert.equal(multiple, null);
  assert.equal(sanitizeQuestions(QUESTIONS)[0].options[0].recommended, true);
});

test('「保留中」の件数は未解決判断事項だけを数える', () => {
  const html = fsSync.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const helper = html.match(/function isHeldDecision\(decision\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper);
  const isHeldDecision = vm.runInNewContext(`(${helper})`);

  assert.equal(isHeldDecision({ state: 'waiting', answer: { choice: 'hold' } }), true);
  assert.equal(isHeldDecision({ state: 'provisional', answer: { choice: 'hold' } }), true);
  assert.equal(isHeldDecision({ state: 'resolved', answer: { choice: 'hold' } }), false);
  assert.equal(isHeldDecision({ state: 'withdrawn', answer: { choice: 'hold' } }), false);
});

test('タイトル、外したセッション、読み上げは回答前の waiting だけを数える', () => {
  const html = fsSync.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const helper = html.match(/function isPendingDecision\(decision\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper);
  const isPendingDecision = vm.runInNewContext(`(${helper})`, {
    hasEffectiveAnswer: (decision) => Boolean(decision.answer?.sentAt && !decision.answer.ignoredAt),
  });

  assert.equal(isPendingDecision({ state: 'waiting', answer: null }), true);
  assert.equal(isPendingDecision({ state: 'waiting', answer: { sentAt: new Date(NOW).toISOString() } }), false);
  assert.equal(isPendingDecision({ state: 'provisional', answer: null }), false);
});

test('種類別の並び順の札には、外すセッションがあるプロダクトにだけ閉じるボタンを表示する', () => {
  const html = fsSync.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const closeButton = html.match(/function productCloseButton\(product, describedById\) \{[\s\S]*?\n\}/)?.[0];
  const productOrder = html.match(/function kindProductOrder\(products\) \{[\s\S]*?\n\}/)?.[0];
  const kindSections = html.match(/function renderKindSections\(products\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(closeButton);
  assert.ok(productOrder);
  assert.match(kindSections, /const productOrder = kindProductOrder\(products\);/);
  assert.match(kindSections, /const sections = \[productOrder\]/);
  assert.doesNotMatch(kindSections, /kindSection\('あなたの判断が必要なこと[^\n]*, productOrder\)/);

  const createElement = (tagName, className, textContent) => ({
    tagName, className, textContent, dataset: {}, attributes: {}, children: [],
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attributes[name] = value; },
  });
  const rendered = vm.runInNewContext(`(() => {
    ${closeButton}
    ${productOrder}
    return kindProductOrder([
      { key: 'product-key', name: 'agent-cockpit', sessions: [{ session_id: 'session-1' }] },
      { key: 'pull-request-only', name: 'PR のみ', sessions: [] },
    ]);
  })()`, { element: createElement });
  const [item, pullRequestOnlyItem] = rendered.children;
  const [tag, close] = item.children;
  assert.equal(pullRequestOnlyItem.children.length, 1);

  assert.equal(rendered.className, 'order product-order kind-order');
  assert.equal(tag.textContent, '1. agent-cockpit');
  assert.equal(tag.title, 'agent-cockpit');
  assert.equal(close.textContent, '×');
  assert.equal(close.type, 'button');
  assert.equal(close.dataset.productAction, 'close');
  assert.equal(close.dataset.productKey, 'product-key');
  assert.equal(close.attributes['aria-label'], 'このプロダクトを閉じる');
  assert.equal(close.attributes['aria-describedby'], tag.id);
  assert.equal(close.title, 'このプロダクトを閉じる');
});

test('種類別の並び順の札は省略表示し、モックでは title にエスケープした名前を入れる', () => {
  const html = fsSync.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const mock = fsSync.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8');
  const mockOrder = mock.match(/const orderBar = `[^\n]*`;/)?.[0];
  assert.match(html, /\.product-order-item \.prod-tag \{ display: inline-block;[^}]*line-height: 20px;[^}]*text-overflow: ellipsis;/);
  assert.match(mock, /\.product-order-item \.prod-tag \{ display: inline-block;[^}]*line-height: 20px;[^}]*text-overflow: ellipsis;/);
  assert.match(mockOrder, /title="\$\{esc\(p\.name\)\}"/);
});

test('推奨案で OK は推奨 label を使い、指示と保留の文脈を添える', () => {
  const decision = { id: 'ask-1', questions: sanitizeQuestions(QUESTIONS) };
  const ok = askAnswerOutput(decision, { choice: 'ok', note: '' });
  const okWithNote = askAnswerOutput(decision, { choice: 'ok', note: '理由を記録する。' });
  const hold = askAnswerOutput(decision, { choice: 'hold', note: '' });

  assert.equal(ok.hookSpecificOutput.permissionDecision, 'allow');
  assert.deepEqual(ok.hookSpecificOutput.updatedInput.answers, { 'どの形式にしますか。': 'JSON (推奨)' });
  assert.deepEqual(ok.hookSpecificOutput.updatedInput.questions[0].options, [
    { label: 'JSON (推奨)', description: '既存 API と一致する。' },
    { label: 'CSV', description: '表計算で開ける。' },
  ]);
  assert.match(okWithNote.hookSpecificOutput.additionalContext, /開発者の指示: 理由を記録する。/);
  assert.match(hold.hookSpecificOutput.additionalContext, /開発者が判断を保留した。推奨のまま進め/);
  assert.deepEqual(hold.hookSpecificOutput.updatedInput.answers, { 'どの形式にしますか。': 'JSON (推奨)' });
});

test('選択肢の回答は選択した label と未選択質問の推奨または指示を answers に入れる', () => {
  const questions = sanitizeQuestions([
    { question: '形式を決める', header: '', multiSelect: false, options: [
      { label: 'JSON (推奨)', description: '' }, { label: 'CSV', description: '' },
    ] },
    { question: '追加する確認を選ぶ', header: '', multiSelect: true, options: [
      { label: 'lint', description: '' }, { label: '型検査', description: '' },
    ] },
    { question: '出力形式を選ぶ', header: '', multiSelect: false, options: [
      { label: 'JSON (Recommended)', description: '' }, { label: 'YAML', description: '' },
    ] },
    { question: '保存先を決める', header: '', multiSelect: false, options: [
      { label: '専用領域', description: '' }, { label: '一時領域', description: '' },
    ] },
  ]);
  const decision = { id: 'ask-pick', questions };
  const answer = {
    choice: 'pick',
    picks: [['CSV'], ['lint', '型検査'], [], []],
    note: '保存先は既定値を使う。',
  };
  const output = askAnswerOutput(decision, answer).hookSpecificOutput;

  assert.deepEqual(output.updatedInput.answers, {
    '形式を決める': 'CSV',
    '追加する確認を選ぶ': 'lint, 型検査',
    '出力形式を選ぶ': 'JSON (Recommended)',
    '保存先を決める': '保存先は既定値を使う。',
  });
  assert.equal(output.additionalContext, '開発者の指示: 保存先は既定値を使う。');
});

test('選択肢の回答を届ける文には、選ばなかった質問も推奨か指示で埋めて全質問を含める', () => {
  const decision = {
    id: 'ask-pick',
    title: '形式を決める',
    questions: sanitizeQuestions([
      { question: '形式を決める', header: '', multiSelect: false, options: [
        { label: 'JSON (推奨)', description: '' }, { label: 'CSV', description: '' },
      ] },
      { question: '追加する確認を選ぶ', header: '', multiSelect: true, options: [
        { label: 'lint', description: '' }, { label: '型検査', description: '' },
      ] },
      { question: '後で決める項目', header: '', multiSelect: false, options: [
        { label: '既定', description: '' }, { label: '変更', description: '' },
      ] },
    ]),
    answer: { choice: 'pick', picks: [[], ['lint', '型検査'], []], note: '最後の項目は既定にする。' },
  };

  assert.match(
    decisionAnswerText(decision),
    /選択肢を選んだ\(「形式を決める」は推奨の「JSON \(推奨\)」、「追加する確認を選ぶ」は「lint, 型検査」、「後で決める項目」は指示のとおり\)/,
  );
});

test('仮適用中に送った選択肢の回答を作業コンテキストへ届ける', () => {
  const sessionId = 'session-provisional-pick';
  const state = new DashboardState();
  state.addEvent({ session_id: sessionId, hook_event_name: 'SessionStart', hookAt: NOW });
  const decision = state.addDecision(sessionId, {
    title: '形式を決める', context: '', state: 'provisional',
    options: [{ label: 'JSON', description: '' }, { label: 'CSV', description: '' }],
  }, NOW);
  const delivery = new DecisionAnswerDelivery({
    state, away: { snapshot: () => ({ enabled: false }) }, now: () => NOW,
  });

  const submitted = delivery.submitAnswer(sessionId, decision.id, 'pick', '', [['CSV']]);

  assert.deepEqual(submitted.answer.picks, [['CSV']]);
  assert.match(delivery.deliverPending(sessionId), /選択肢を選んだ\(「形式を決める」は「CSV」\)/);
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

test('MCP の recommended true は label の文言にかかわらず推奨として扱う', () => {
  const state = new DashboardState();
  state.addEvent({ session_id: 'session-mcp-recommended', hook_event_name: 'SessionStart', hookAt: NOW });
  const decision = state.addDecision('session-mcp-recommended', {
    title: 'どの形式にしますか。', context: '', state: 'provisional',
    options: [{ label: 'JSON', description: '互換性がある。', recommended: true }],
  }, NOW);

  assert.equal(decision.questions[0].options[0].recommended, true);
  assert.deepEqual(askAnswerOutput(decision, { choice: 'ok', note: '' }).hookSpecificOutput.updatedInput.answers, {
    'どの形式にしますか。': 'JSON',
  });
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

test('推奨の無い質問で保留を送った後に離席中を解除するとダイアログへ戻す', async () => {
  const fixture = makeFixture({ questions: [{
    question: 'どの形式にしますか。', header: '', multiSelect: false,
    options: [{ label: 'JSON', description: '' }],
  }] });
  const { delivery, away, state, sessionId, toolUseId, registration } = fixture;

  delivery.submitAnswer(sessionId, registration.decisionId, 'hold', 'あとで決める。');
  away.enabled = false;

  const { outcome } = await delivery.waitForAsk({ sessionId, toolUseId });
  assert.equal(outcome, 'released');
  assert.deepEqual(delivery.finishAsk({ sessionId, toolUseId, outcome }), { outcome: 'released', hookOutput: null });
  assert.equal(state.decisionFor(sessionId, registration.decisionId).state, 'waiting');
  assert.equal(state.decisionFor(sessionId, registration.decisionId).answer, null);
  assert.equal(delivery.deliverPending(sessionId), null);
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
  assert.equal(state.decisionLifecycles.get(sessionId).get(registration.decisionId).state, null);
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
    options: [{ label: 'TOML（Recommended）', description: 'configuration' }, { label: 'CSV', description: '' }],
  }];
  state.setDecisionLifecycle(sessionId, registration.decisionId, {
    answer: { choice: 'hold', note: '前の質問への回答', sentAt: new Date(clock.now()).toISOString() },
    state: 'provisional',
    awaitingAnswerUntil: new Date(clock.now() + 10_000).toISOString(),
  }, clock.now());
  const bundled = delivery.registerAsk({ sessionId, toolUseId: 'ask-2', questions: revisedQuestions });

  assert.equal(bundled.decisionId, registration.decisionId);
  assert.equal(state.decisionIdForToolUse(sessionId, 'ask-2'), registration.decisionId);
  assert.equal(state.decisionsFor(sessionId).length, 1);
  assert.equal(state.decisionFor(sessionId, registration.decisionId).answer, null);
  assert.equal(state.decisionFor(sessionId, registration.decisionId).state, 'waiting');
  assert.equal(state.decisionFor(sessionId, registration.decisionId).questions[0].options[0].label, 'TOML（Recommended）');
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

test('締切前の回答は同時に起きた離席中の解除より優先する', async () => {
  const fixture = makeFixture();
  const { delivery, away, sessionId, toolUseId, registration } = fixture;
  delivery.submitAnswer(sessionId, registration.decisionId, 'ok', '締切前に送った回答');
  away.enabled = false;

  assert.deepEqual(await delivery.waitForAsk({ sessionId, toolUseId }), { outcome: 'answered' });
});

test('long-poll が 30 秒届かない回答待ちは解除する', async () => {
  const fixture = makeFixture({ maxAskPollGapMs: 30_000 });
  const { clock, delivery, state, sessionId, toolUseId, registration } = fixture;
  delivery.submitAnswer(sessionId, registration.decisionId, 'ok', 'ダイアログへ戻した後は使わない。');

  clock.advance(30_000);

  assert.deepEqual(await delivery.waitForAsk({ sessionId, toolUseId }), { outcome: 'released' });
  assert.equal(state.decisionFor(sessionId, registration.decisionId).awaitingAnswerUntil, undefined);
  assert.equal(state.decisionFor(sessionId, registration.decisionId).state, 'waiting');
  assert.equal(state.decisionFor(sessionId, registration.decisionId).answer, null);
  assert.equal(delivery.deliverPending(sessionId), null);
});

test('常駐サーバーの終了時に質問待ちのタイマーをすべて解除する', () => {
  const fixture = makeFixture();

  assert.equal(fixture.clock.timers.size, 2);
  fixture.delivery.close();
  assert.equal(fixture.clock.timers.size, 0);
});

test('PostToolUseFailure は待機中の lifecycle とタイマーを解除し、provisional は維持する', async () => {
  const waiting = makeFixture();
  const askPending = waiting.delivery.waitForAsk({ sessionId: waiting.sessionId, toolUseId: waiting.toolUseId });
  const waitingEvent = {
    session_id: waiting.sessionId,
    hook_event_name: 'PostToolUseFailure',
    hookAt: waiting.clock.now() + 1,
    tool_name: 'AskUserQuestion',
    tool_use_id: waiting.toolUseId,
  };
  waiting.state.addEvent(waitingEvent);
  waiting.delivery.afterEvent(sanitizeEvent(waitingEvent));
  assert.deepEqual(await askPending, { outcome: 'released' });
  assert.deepEqual(waiting.delivery.askWaits.get(`${waiting.sessionId}\0${waiting.toolUseId}`).result, {
    outcome: 'released', hookOutput: null,
  });
  assert.equal(waiting.clock.timers.size, 0);
  const withdrawn = waiting.state.decisionFor(waiting.sessionId, waiting.registration.decisionId);
  assert.equal(withdrawn.state, 'withdrawn');
  assert.equal(withdrawn.awaitingAnswerUntil, undefined);

  const held = makeFixture();
  held.delivery.submitAnswer(held.sessionId, held.registration.decisionId, 'hold', 'あとで見る。');
  const result = await held.delivery.waitForAsk({ sessionId: held.sessionId, toolUseId: held.toolUseId });
  held.delivery.finishAsk({ ...result, sessionId: held.sessionId, toolUseId: held.toolUseId });
  const failedEvent = {
    session_id: held.sessionId,
    hook_event_name: 'PostToolUseFailure',
    hookAt: held.clock.now() + 1,
    tool_name: 'AskUserQuestion',
    tool_use_id: held.toolUseId,
  };
  held.state.addEvent(failedEvent);
  held.delivery.afterEvent(sanitizeEvent(failedEvent));
  const provisional = held.state.decisionFor(held.sessionId, held.registration.decisionId);
  assert.equal(provisional.state, 'provisional');
  assert.equal(provisional.awaitingAnswerUntil, undefined);
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

test('作業イベントは古い Stop を終え、回答待ちの質問を Stop から配信しない', async () => {
  const state = new DashboardState();
  const delivery = new DecisionAnswerDelivery({ state, away: { snapshot: () => ({ enabled: false }) }, now: () => NOW });
  const generation = delivery.startStop('session-stop-work', 'stop-1', NOW);
  const waiting = delivery.waitForStopAnswer('session-stop-work', generation);
  delivery.afterEvent(sanitizeEvent({
    session_id: 'session-stop-work', hook_event_name: 'PreToolUse', hookAt: NOW + 1,
    tool_name: 'Read', tool_use_id: 'read-1',
  }));
  assert.deepEqual(await waiting, { stderrText: null, done: true });

  const fixture = makeFixture();
  const stopGeneration = fixture.delivery.startStop(fixture.sessionId, 'stop-answer', NOW);
  const stopWaiting = fixture.delivery.waitForStopAnswer(fixture.sessionId, stopGeneration);
  fixture.delivery.submitAnswer(fixture.sessionId, fixture.registration.decisionId, 'ok', 'PreToolUse に渡す回答');
  assert.equal(fixture.delivery.deliverPending(fixture.sessionId), null);
  assert.deepEqual(await stopWaiting, { stderrText: null, done: false });
  assert.equal(fixture.delivery.deliverPrompt(fixture.sessionId, 'prompt-answer', NOW + 2), null);
});

test('古い Stop は世代を進めずに開始を拒否する', () => {
  const delivery = new DecisionAnswerDelivery({
    state: new DashboardState(), away: { snapshot: () => ({ enabled: false }) }, now: () => NOW,
  });
  delivery.afterEvent(sanitizeEvent({
    session_id: 'session-stale-stop', hook_event_name: 'PostToolUse', hookAt: NOW + 10,
    tool_name: 'Read', tool_use_id: 'read-1',
  }));

  assert.equal(delivery.startStop('session-stale-stop', 'stop-old', NOW), null);
  assert.equal(delivery.stopGenerations.get('session-stale-stop'), 1);
  assert.equal(delivery.startStop('session-stale-stop', 'stop-new', NOW + 11), 2);
});

test('古い Stop のフックはサーバーへ再接続せずに終了する', async (t) => {
  const { homeDir } = await temporaryHome(t);
  await fs.writeFile(path.join(homeDir, 'server.json'), JSON.stringify({ port: 47824, secret: 'hook-secret', pid: 1, startedAt: 'now' }));
  const actions = [];
  const result = await runStop({ hook_event_name: 'Stop', session_id: 'session-stale-hook' }, {
    homeDir,
    now: () => NOW,
    parentPid: 1,
    isParentAlive: () => true,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      actions.push(body.action);
      return { ok: true, json: async () => ({ generation: null }) };
    },
  });

  assert.deepEqual(result, { exitCode: 0, stderrText: null });
  assert.deepEqual(actions, ['stop-start']);
});

test('SessionStart の compact は lifecycle 時刻を保ち startup、resume、clear は消す', () => {
  const delivery = new DecisionAnswerDelivery({
    state: new DashboardState(), away: { snapshot: () => ({ enabled: false }) }, now: () => NOW,
  });
  let hookAt = NOW + 1;
  for (const source of ['compact', 'startup', 'resume', 'clear']) {
    delivery.handleLifecycleEvent('session-source', 'Stop', `stop-${source}`, hookAt);
    const hookEvent = makeHookEvent({
      session_id: 'session-source', hook_event_name: 'SessionStart', source,
    }, hookAt + 1);
    assert.equal(hookEvent.source, source);
    delivery.afterEvent(sanitizeEvent(hookEvent));
    if (source === 'compact') assert.equal(delivery.lastLifecycleAt.get('session-source'), hookAt);
    else assert.equal(delivery.lastLifecycleAt.has('session-source'), false);
    hookAt += 2;
  }
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

test('server-lost の finish が出力を返さなくても登録時の fallback を使う', async (t) => {
  const { homeDir } = await temporaryHome(t);
  await fs.writeFile(path.join(homeDir, 'server.json'), JSON.stringify({ port: 47822, secret: 'hook-secret', pid: 1, startedAt: 'now' }));
  const output = await runAskQuestion({
    session_id: 'session-lost-finish', tool_use_id: 'ask-lost-finish', tool_name: 'AskUserQuestion',
    tool_input: { questions: QUESTIONS },
  }, {
    homeDir,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'ask-finish') throw new Error('server unavailable');
      const responses = {
        'ask-register': { awaiting: true, decisionId: 'ask-lost-finish', fallbackOutput: denyAnswerOutput('ask-lost-finish') },
        'ask-poll': { outcome: 'server-lost' },
      };
      return { ok: true, json: async () => responses[body.action] };
    },
  });

  assert.deepEqual(output, denyAnswerOutput('ask-lost-finish'));
});

test('server-lost の後で released が返ったらダイアログへ戻す', async (t) => {
  const { homeDir } = await temporaryHome(t);
  await fs.writeFile(path.join(homeDir, 'server.json'), JSON.stringify({ port: 47824, secret: 'hook-secret', pid: 1, startedAt: 'now' }));
  const output = await runAskQuestion({
    session_id: 'session-released-finish', tool_use_id: 'ask-released-finish', tool_name: 'AskUserQuestion',
    tool_input: { questions: QUESTIONS },
  }, {
    homeDir,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const responses = {
        'ask-register': { awaiting: true, decisionId: 'ask-released-finish' },
        'ask-poll': { outcome: 'server-lost' },
        'ask-finish': { outcome: 'released', hookOutput: null },
      };
      return { ok: true, json: async () => responses[body.action] };
    },
  });

  assert.equal(output, null);
});

test('回答後に離席を解除しても server-lost finish は回答を返す', async (t) => {
  const { homeDir } = await temporaryHome(t);
  await fs.writeFile(path.join(homeDir, 'server.json'), JSON.stringify({ port: 47826, secret: 'hook-secret', pid: 1, startedAt: 'now' }));
  const fixture = makeFixture({ sessionId: 'session-lost-answer', toolUseId: 'ask-lost-answer' });
  const toolInput = { questions: QUESTIONS, extension: { preserved: true } };
  const output = await runAskQuestion({
    session_id: fixture.sessionId, tool_use_id: fixture.toolUseId, tool_name: 'AskUserQuestion', tool_input: toolInput,
  }, {
    homeDir,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'ask-poll') {
        fixture.delivery.submitAnswer(fixture.sessionId, fixture.registration.decisionId, 'ok', '締切前の回答');
        fixture.away.enabled = false;
        return { ok: true, json: async () => ({ outcome: 'server-lost' }) };
      }
      if (body.action === 'ask-finish') {
        const result = fixture.delivery.finishAsk({
          sessionId: fixture.sessionId,
          toolUseId: fixture.toolUseId,
          decisionId: fixture.registration.decisionId,
          outcome: 'server-lost',
        });
        return { ok: true, json: async () => result };
      }
      return { ok: true, json: async () => ({ awaiting: true, decisionId: fixture.registration.decisionId }) };
    },
  });

  assert.deepEqual(output.hookSpecificOutput.updatedInput, {
    ...toolInput,
    answers: { 'どの形式にしますか。': 'JSON (推奨)' },
  });
  assert.equal(fixture.state.decisionFor(fixture.sessionId, fixture.registration.decisionId).state, 'waiting');
});

test('poll 応答が途絶えた後で finish の released が返ったらダイアログへ戻す', async (t) => {
  const { homeDir } = await temporaryHome(t);
  await fs.writeFile(path.join(homeDir, 'server.json'), JSON.stringify({ port: 47825, secret: 'hook-secret', pid: 1, startedAt: 'now' }));
  const output = await runAskQuestion({
    session_id: 'session-released-poll', tool_use_id: 'ask-released-poll', tool_name: 'AskUserQuestion',
    tool_input: { questions: QUESTIONS },
  }, {
    homeDir,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'ask-poll') throw new Error('poll response unavailable');
      const responses = {
        'ask-register': { awaiting: true, decisionId: 'ask-released-poll' },
        'ask-finish': { outcome: 'released', hookOutput: null },
      };
      return { ok: true, json: async () => responses[body.action] };
    },
  });

  assert.equal(output, null);
});

test('PreToolUse の回答は元の tool_input を保って answers を加える', async (t) => {
  const { homeDir } = await temporaryHome(t);
  await fs.writeFile(path.join(homeDir, 'server.json'), JSON.stringify({ port: 47823, secret: 'hook-secret', pid: 1, startedAt: 'now' }));
  const toolInput = { questions: QUESTIONS, extension: { preserved: true } };
  const output = await runAskQuestion({
    session_id: 'session-original-input', tool_use_id: 'ask-original-input', tool_name: 'AskUserQuestion', tool_input: toolInput,
  }, {
    homeDir,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const responses = {
        'ask-register': { awaiting: true, decisionId: 'ask-original-input' },
        'ask-poll': { outcome: 'answered' },
        'ask-finish': { hookOutput: {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { questions: [{ question: 'server copy' }], answers: { 'どの形式にしますか。': 'JSON (推奨)' } },
          },
        } },
      };
      return { ok: true, json: async () => responses[body.action] };
    },
  });

  assert.deepEqual(output.hookSpecificOutput.updatedInput, {
    ...toolInput,
    answers: { 'どの形式にしますか。': 'JSON (推奨)' },
  });
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

test('待ちの記録がある server-lost でも離席解除後は released で質問を戻す', () => {
  const fixture = makeFixture();
  fixture.away.enabled = false;
  const result = fixture.delivery.finishAsk({
    sessionId: fixture.sessionId,
    toolUseId: fixture.toolUseId,
    decisionId: fixture.registration.decisionId,
    outcome: 'server-lost',
  });

  assert.deepEqual(result, { outcome: 'released', hookOutput: null });
  assert.equal(fixture.state.decisionFor(fixture.sessionId, fixture.registration.decisionId).awaitingAnswerUntil, undefined);
});

test('record がなくても離席中の server-lost は deny で進める', () => {
  const fixture = makeFixture();
  fixture.delivery.askWaits.delete(`${fixture.sessionId}\0${fixture.toolUseId}`);
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
  assert.deepEqual(askOutput.output.hookSpecificOutput.updatedInput.answers, { 'どの形式にしますか。': 'JSON (推奨)' });

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
  const persistedText = (await Promise.all((await fs.readdir(homeDir))
    .filter((name) => name !== 'store.json')
    .map((name) => fs.readFile(path.join(homeDir, name), 'utf8')))).join('\n');
  assert.doesNotMatch(persistedText, /UI からの回答本文|他セッションだけに渡す本文/);
  const stored = JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8'));
  assert.equal(stored.decisionLifecycles['session-ui'], undefined);
  assert.equal(stored.decisionLifecycles['session-other'][privateDecision.id].answer.note, '他セッションだけに渡す本文');
});

test('選択肢の回答 API は label と質問ごとの選択数を検査して回答を渡す', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'session-pick', hook_event_name: 'SessionStart', hookAt: NOW });
  const away = {
    snapshot: () => ({ enabled: true, since: NOW }),
    setEnabled: async (enabled) => ({ enabled, since: enabled ? NOW : null }),
  };
  const runtime = await startServer({ homeDir, claudeHome, port: 0, state, away });
  t.after(() => runtime.close());
  const questions = [
    { question: '形式を決める', header: '', multiSelect: false, options: [
      { label: 'JSON (推奨)', description: '' }, { label: 'CSV', description: '' },
    ] },
    { question: '追加する確認を選ぶ', header: '', multiSelect: true, options: [
      { label: 'lint', description: '' }, { label: '型検査', description: '' },
    ] },
    { question: '出力形式を選ぶ', header: '', multiSelect: false, options: [
      { label: 'JSON (Recommended)', description: '' }, { label: 'YAML', description: '' },
    ] },
    { question: '保存先を決める', header: '', multiSelect: false, options: [
      { label: '専用領域', description: '' }, { label: '一時領域', description: '' },
    ] },
  ];
  const registration = runtime.answerDelivery.registerAsk({ sessionId: 'session-pick', toolUseId: 'ask-pick', questions });
  const pathName = `/api/decisions/${encodeURIComponent(registration.decisionId)}/answer`;
  const origin = `http://127.0.0.1:${runtime.info.port}`;
  const headers = { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin };
  const post = (body) => request(runtime.info.port, {
    method: 'POST', path: pathName, body: JSON.stringify(body), headers,
  });
  const base = { session_id: 'session-pick', choice: 'pick', note: '', picks: [[], [], [], []] };

  assert.equal((await post({ ...base, picks: undefined })).status, 400);
  assert.equal((await post({ ...base, choice: 'ok', picks: [] })).status, 400);
  assert.equal((await post({ ...base, picks: [['未登録の label'], [], [], []] })).status, 400);
  assert.equal((await post({ ...base, note: '未選択の質問はすべて補う。' })).status, 400);
  assert.equal((await post({ ...base, note: '保存先を補う。', picks: [['CSV', 'JSON (推奨)'], [], [], []] })).status, 400);
  assert.equal((await post({ ...base, picks: [['CSV'], ['lint'], [], []] })).status, 400);

  const sent = await post({
    ...base,
    note: '保存先は既定値を使う。',
    picks: [['CSV'], ['lint', '型検査'], [], []],
  });
  assert.equal(sent.status, 200);
  const decision = state.decisionFor('session-pick', registration.decisionId);
  assert.deepEqual(decision.answer.picks, [['CSV'], ['lint', '型検査'], [], []]);
  const snapshotDecision = state.snapshot().sessions.find((session) => session.session_id === 'session-pick').decisions[0];
  assert.deepEqual(snapshotDecision.answer.picks, decision.answer.picks);
  snapshotDecision.answer.picks[0].push('snapshot-only');
  assert.deepEqual(decision.answer.picks[0], ['CSV']);

  const asked = await runAnswerHook({
    session_id: 'session-pick', tool_use_id: 'ask-pick', hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion', tool_input: { questions },
  }, { homeDir });
  assert.deepEqual(asked.output.hookSpecificOutput.updatedInput.answers, {
    '形式を決める': 'CSV',
    '追加する確認を選ぶ': 'lint, 型検査',
    '出力形式を選ぶ': 'JSON (Recommended)',
    '保存先を決める': '保存先は既定値を使う。',
  });
  assert.equal(asked.output.hookSpecificOutput.additionalContext, '開発者の指示: 保存先は既定値を使う。');
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
  state.addEvent({ session_id: 'session-delivery', hook_event_name: 'PreToolUse', hookAt: NOW, tool_name: 'Bash', tool_use_id: 'blocked-main-tool' });
  state.addEvent({ session_id: 'session-delivery', hook_event_name: 'PreToolUse', hookAt: NOW, agent_id: 'agent-1', tool_name: 'Read', tool_use_id: 'agent-tool' });
  const batch = await runAnswerHook({ hook_event_name: 'PostToolBatch', session_id: 'session-delivery' }, { homeDir });
  assert.match(batch.output.hookSpecificOutput.additionalContext, /期限を 1 日にする。/);
  assert.ok(state.decisionFor('session-delivery', batchDecision.id).answer.deliveredAt);
  assert.deepEqual(state.snapshot().sessions.find((session) => session.session_id === 'session-delivery').tools.map((tool) => tool.tool_use_id), ['agent-tool']);

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
