const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createFakeClock, installFakeClock } = require('../tools/manual/fake-clock');
const { createFakeGh, sha } = require('../tools/manual/fake-gh');
const { startDemoServer, parseDemoArguments, BASE_TIME_MS } = require('../tools/manual/demo-server');
const { request } = require('./support/server');

function run(gh, args, file = 'gh') {
  return new Promise((resolve) => gh.execFileImpl(file, args, {}, (error, stdout) => resolve({ error, stdout })));
}

function ghDefinition() {
  return {
    repositories: {
      'example-team/app': {
        defaultBranch: 'main',
        pullRequests: [
          { number: 1, title: '親', head: 'feature/a', createdAt: '2026-10-06T00:00:00.000Z', checks: 'pass' },
          { number: 2, title: '子', head: 'feature/b', base: 'feature/a', createdAt: '2026-10-06T00:01:00.000Z', checks: 'pending', parentCommits: [sha('example-team/app#9')] },
          { number: 9, title: '済', head: 'feature/old', createdAt: '2026-10-05T00:00:00.000Z', state: 'MERGED', mergedAt: '2026-10-05T01:00:00.000Z' },
        ],
      },
    },
  };
}

test('固定した時計は引数なしの Date だけを固定し、進めても戻せない', () => {
  const { FakeDate, clock } = createFakeClock(Date, Date.UTC(2026, 9, 6, 5, 30));
  assert.equal(FakeDate.now(), Date.UTC(2026, 9, 6, 5, 30));
  assert.equal(new FakeDate().toISOString(), '2026-10-06T05:30:00.000Z');
  assert.equal(new FakeDate(0).getTime(), 0);
  assert.equal(FakeDate.parse('2026-10-06T05:31:00Z'), Date.UTC(2026, 9, 6, 5, 31));

  clock.advance(90_000);
  assert.equal(FakeDate.now(), Date.UTC(2026, 9, 6, 5, 31, 30));
  assert.throws(() => clock.set(Date.UTC(2026, 9, 6, 5, 0)), /戻せません/);
  assert.throws(() => createFakeClock(Date, Number.NaN), /初期値/);
});

test('実時間に合わせた時計は、合わせた時点の値から単調な時間の経過だけ進み、手では動かせない', () => {
  let monotonic = 1000;
  const { FakeDate, clock } = createFakeClock(Date, Date.UTC(2026, 9, 6, 5, 30));
  clock.followRealTime(() => monotonic);
  assert.equal(FakeDate.now(), Date.UTC(2026, 9, 6, 5, 30));
  monotonic += 61_000;
  assert.equal(FakeDate.now(), Date.UTC(2026, 9, 6, 5, 31, 1));
  assert.equal(new FakeDate().getTime(), Date.UTC(2026, 9, 6, 5, 31, 1));
  assert.throws(() => clock.advance(1), /手で動かせません/);
});

test('固定した時計は取り外すと本物の Date に戻り、二重には入らない', () => {
  const real = globalThis.Date;
  const clock = installFakeClock(Date.UTC(2026, 9, 6, 5, 30));
  try {
    assert.equal(Date.now(), Date.UTC(2026, 9, 6, 5, 30));
    assert.throws(() => installFakeClock(0), /すでに/);
  } finally {
    clock.uninstall();
  }
  assert.equal(globalThis.Date, real);
});

test('偽の gh は PR の定義から一覧、詳細、設定、比較に答える', async () => {
  const gh = createFakeGh(ghDefinition());
  const fields = 'number,title,url,headRefName,baseRefName,headRefOid,isCrossRepository,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,createdAt';

  const open = JSON.parse((await run(gh, ['pr', 'list', '-R', 'example-team/app', '--state', 'open', '--limit', '500', '--json', fields])).stdout);
  assert.deepEqual(open.map((pr) => pr.number), [1, 2]);
  assert.equal(open[1].baseRefName, 'feature/a');
  assert.equal(open[0].url, 'https://github.com/example-team/app/pull/1');
  assert.equal(open[1].statusCheckRollup[0].status, 'IN_PROGRESS');

  const merged = JSON.parse((await run(gh, ['pr', 'list', '-R', 'example-team/app', '--state', 'merged', '--limit', '1000', '--search', 'merged:>=2026-10-05', '--json', 'number,headRefOid,mergedAt'])).stdout);
  assert.deepEqual(merged, [{ number: 9, headRefOid: sha('example-team/app#9'), mergedAt: '2026-10-05T01:00:00.000Z' }]);

  const view = JSON.parse((await run(gh, ['pr', 'view', '9', '-R', 'example-team/app', '--json', `${fields},state,mergedAt`])).stdout);
  assert.equal(view.state, 'MERGED');

  const config = JSON.parse((await run(gh, ['api', 'repos/example-team/app'])).stdout);
  assert.equal(config.default_branch, 'main');
  assert.equal(config.allow_squash_merge, true);

  const head = open[1].headRefOid;
  const compare = JSON.parse((await run(gh, ['api', `repos/example-team/app/compare/main...${head}`])).stdout);
  assert.deepEqual(compare.commits.map((commit) => commit.sha), [sha('example-team/app#9'), head]);
  assert.equal(compare.ahead_by, 2);
  assert.deepEqual(gh.unexpectedCalls(), []);
});

test('偽の gh はマージ、base の付け替え、ブランチの削除を状態に反映する', async () => {
  const gh = createFakeGh(ghDefinition(), { now: () => Date.UTC(2026, 9, 6, 5, 30) });
  const repository = gh.repository('example-team/app');
  const head = repository.pullRequests[0].headRefOid;

  assert.equal((await run(gh, ['pr', 'merge', '1', '-R', 'example-team/app', '--squash', '--match-head-commit', sha('other')])).error.code, 'DEMO_UNEXPECTED_GH');
  assert.equal((await run(gh, ['pr', 'edit', '2', '-R', 'example-team/app', '--base', 'main'])).error, null);
  assert.equal(repository.pullRequests[1].base, 'main');
  assert.equal((await run(gh, ['pr', 'merge', '1', '-R', 'example-team/app', '--squash', '--match-head-commit', head])).error, null);
  assert.equal(repository.pullRequests[0].state, 'MERGED');
  assert.equal(repository.pullRequests[0].mergedAt, '2026-10-06T05:30:00.000Z');
  assert.equal((await run(gh, ['api', '-X', 'DELETE', 'repos/example-team/app/git/refs/heads/feature/a'])).error, null);
  assert.deepEqual(repository.deletedBranches, ['feature/a']);
});

test('偽の gh は定義に無い呼び出しをエラーにして記録する', async () => {
  const seen = [];
  const gh = createFakeGh(ghDefinition(), { onUnexpected: (message) => seen.push(message) });
  const cases = [
    ['pr', 'list', '-R', 'example-team/unknown', '--state', 'open', '--json', 'number'],
    ['pr', 'list', '-R', 'example-team/app', '--state', 'open', '--json', 'number,labels'],
    ['pr', 'view', '77', '-R', 'example-team/app', '--json', 'number'],
    ['api', 'repos/example-team/app/compare/main...0000000000000000000000000000000000000000'],
    ['api', 'user'],
    ['issue', 'list'],
  ];
  for (const args of cases) {
    const { error } = await run(gh, args);
    assert.equal(error?.code, 'DEMO_UNEXPECTED_GH', args.join(' '));
  }
  assert.equal((await run(gh, ['pr', 'list'], 'curl')).error?.code, 'DEMO_UNEXPECTED_GH');
  assert.equal(gh.unexpectedCalls().length, cases.length + 1);
  assert.equal(seen.length, cases.length + 1);
});

test('偽の gh は unavailable を指定されると、どの呼び出しも起動の失敗で返し、定義に無い呼び出しとは数えない', async () => {
  const gh = createFakeGh({ unavailable: 'ENOENT', repositories: {} });
  const { error } = await run(gh, ['pr', 'list', '-R', 'example-team/app', '--state', 'open', '--json', 'number']);
  assert.equal(error.code, 'ENOENT');
  assert.deepEqual(gh.unexpectedCalls(), []);
});

test('gh が無いシナリオでは、登録した PR の枠にエラーだけが載る', async () => {
  const demo = await startDemoServer({ scenario: 'no-gh' });
  try {
    demo.assertHealthy();
    const state = await demo.getState();
    assert.equal(state.pullRequests.length, 1);
    assert.match(state.pullRequests[0].error, /gh コマンドが見つかりません/);
    assert.deepEqual(state.pullRequests[0].trees, []);
  } finally {
    await demo.close();
  }
});

test('デモの起動引数はシナリオ名とポートだけを受け付ける', () => {
  assert.deepEqual(parseDemoArguments([]), { scenario: 'basic', port: 0, live: true });
  assert.deepEqual(parseDemoArguments(['basic', '--port', '47830', '--fixed']), { scenario: 'basic', port: 47830, live: false });
  assert.throws(() => parseDemoArguments(['nothing']), /シナリオがありません/);
  assert.throws(() => parseDemoArguments(['--port', '99999']), /--port/);
  assert.throws(() => parseDemoArguments(['--unknown']), /不明な引数/);
});

test('画面で試すためのデモは、流し込みの後に時計を基準時刻から進める', async (t) => {
  const demo = await startDemoServer({ followRealTime: true });
  t.after(() => demo.close());
  assert.ok(Date.now() >= BASE_TIME_MS);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(Date.now() > BASE_TIME_MS);
});

test('デモで預かった質問は、生存確認の途絶を調べるタイマーが動いても回答待ちのまま残る', async (t) => {
  const demo = await startDemoServer({ scenario: 'decisions' });
  t.after(() => demo.close());
  const awaiting = () => demo.getState().then((state) => state.sessions
    .flatMap((session) => session.decisions)
    .filter((decision) => decision.awaitingAnswerUntil));
  assert.ok((await awaiting()).length > 0);
  for (const record of [...demo.runtime.answerDelivery.askWaits.values()]) demo.runtime.answerDelivery.releaseStaleAsk(record);
  assert.ok((await awaiting()).length > 0);
});

test('デモのSessionEnd後は同じwriterでイベントを書き込めない', async (t) => {
  const demo = await startDemoServer({ scenario: 'no-gh' });
  t.after(() => demo.close());
  await demo.hook('parcel-main', { hook_event_name: 'SessionEnd' });
  await assert.rejects(
    demo.hook('parcel-main', { hook_event_name: 'Stop' }),
    /403 で失敗しました/,
  );
});

test('demo HTTPの未束縛childは適用せず、child SessionEndは親writerを終了しない', async (t) => {
  const demo = await startDemoServer({ scenario: 'no-gh' });
  t.after(() => demo.close());
  const key = 'parcel-main';
  const unboundId = 'http-only-demo-child';
  const unknown = await demo.hook(key, {
    hook_event_name: 'SubagentStart',
    agent_id: unboundId,
    agent_type: 'Explore',
  }, { bindActorFixture: false, requireApply: false });
  assert.deepEqual(unknown, { accepted: false, status: 'unknown', reason: 'actor_binding_mismatch' });
  assert.equal(demo.runtime.state.snapshot().sessions.flatMap((session) => session.agents).some((agent) => agent.agent_id === unboundId), false);

  const childId = 'trusted-demo-child-session-end';
  const started = await demo.hook(key, { hook_event_name: 'SubagentStart', agent_id: childId, agent_type: 'Explore' });
  assert.deepEqual(started, { accepted: true });
  const ended = await demo.hook(key, { hook_event_name: 'SessionEnd', agent_id: childId });
  assert.deepEqual(ended, { accepted: true });
  const parentEvent = await demo.hook(key, { hook_event_name: 'Stop' });
  assert.deepEqual(parentEvent, { accepted: true });
  const parent = demo.runtime.state.snapshot().sessions.find((session) => session.session_id === demo.sessions.get(key).id);
  assert.ok(parent);
  const child = parent.agents.find((agent) => agent.agent_id === childId);
  assert.ok(child);
  assert.equal(child.active, false);
  assert.equal(child.turnState, 'session_ended');
});

test('登録済みデモsessionへのwriterなしplanは通常のHTTP認可で拒否する', async (t) => {
  const demo = await startDemoServer({ scenario: 'no-gh' });
  t.after(() => demo.close());
  const session = demo.sessions.get('parcel-main');
  const before = demo.runtime.state.planSummary(session.id);
  const response = await request(demo.port, {
    method: 'POST', path: `/api/sessions/${session.id}/plan`,
    headers: {
      'content-type': 'application/json',
      'x-cockpit-secret': demo.runtime.info.secret,
    },
    body: JSON.stringify({ kind: 'tasks', tasks: [] }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(demo.runtime.state.planSummary(session.id), before);
});

test('基本のシナリオを流し込むと、全体図に要る状態が隔離した保存先の常駐サーバーに揃う', async () => {
  const real = globalThis.Date;
  const demo = await startDemoServer({});
  let temporaryRoot;
  try {
    temporaryRoot = demo.temporaryRoot;
    assert.equal(demo.runtime.server.address().address, '127.0.0.1');
    assert.ok(demo.homeDir.startsWith(temporaryRoot));
    assert.equal(Date.now(), BASE_TIME_MS);
    demo.assertHealthy();

    const state = await demo.getState();
    const sessions = new Map(state.sessions.map((session) => [session.session_id, session]));
    const allDecisions = state.sessions.flatMap((session) => session.decisions);

    assert.deepEqual([...new Set(state.sessions.map((session) => session.product.name))].sort(), ['field-notes', 'parcel-api', 'shift-planner']);
    assert.equal(state.sessions.filter((session) => session.product.name === 'shift-planner').length, 2);

    const waiting = allDecisions.filter((decision) => decision.state === 'waiting');
    assert.ok(waiting.some((decision) => decision.questions[0].multiSelect === true));
    assert.ok(waiting.some((decision) => decision.context && decision.questions[0].options.some((option) => option.recommended)));
    assert.equal(allDecisions.filter((decision) => decision.state === 'provisional').length, 1);
    assert.equal(allDecisions.filter((decision) => decision.state === 'resolved').length, 1);

    const waits = state.sessions.flatMap((session) => session.permissionWaits);
    const waitMinutes = waits.map((wait) => (BASE_TIME_MS - Date.parse(wait.startedAt)) / 60_000).sort((a, b) => a - b);
    assert.deepEqual(waitMinutes, [3, 22]);

    const taskStates = new Set(state.sessions.flatMap((session) => session.tasks.map((task) => task.state)));
    assert.deepEqual([...taskStates].sort(), ['doing', 'done', 'todo']);
    const planner = sessions.get('demo-planner-main');
    assert.equal(planner.status, '作業中');
    assert.ok(planner.tools.some((tool) => tool.tool_name === 'Edit'));
    assert.equal(sessions.get('demo-notes-main').status, '待機中');

    const agents = state.sessions.flatMap((session) => session.agents);
    assert.ok(agents.some((agent) => agent.active && !agent.gpt));
    assert.ok(agents.some((agent) => agent.active && agent.gpt?.active && agent.gpt.model === 'gpt-5.5-codex'));
    assert.ok(agents.some((agent) => !agent.active && agent.gpt?.model === 'gpt-5.5-codex'));
    assert.ok(agents.some((agent) => !agent.active && !agent.gpt));

    const trees = [];
    const walk = (tree) => { trees.push(tree); tree.children.forEach(walk); };
    state.pullRequests.flatMap((group) => group.trees).forEach(walk);
    const byNumber = new Map(trees.map((tree) => [tree.number, tree]));
    assert.equal(byNumber.get(41).mergeConditionMet, true);
    assert.deepEqual(byNumber.get(118).mergeConditionWaits, ['CI 実行中', 'クロスレビュー対応中']);
    assert.match(byNumber.get(119).blocker, /^積み直し待ち/);
    assert.equal(byNumber.get(120).blocker, 'コンフリクトあり');
    assert.equal(byNumber.get(121).blocker, 'ドラフト');
    assert.deepEqual(byNumber.get(57).mergeConditionWaits, ['クロスレビュー未実施']);
    assert.equal(byNumber.get(44).crossReview.notRequired, true);
    assert.equal(byNumber.get(42).parentNumber, 41);
    assert.equal(byNumber.get(43).parentNumber, 42);

    const sinceSeen = state.sinceSeen.flatMap((entry) => entry.items.map((item) => item.text));
    assert.ok(sinceSeen.some((text) => text.includes('をマージした')));
    assert.ok(sinceSeen.some((text) => text.includes('を作成した')));
    assert.ok(sinceSeen.some((text) => text.includes('完了した')));
    assert.ok(sinceSeen.some((text) => text.includes('仮に進めた')));
    assert.equal(state.integrations.codexAgent, true);
    assert.equal(state.integrations.crossReview, true);
    assert.ok(state.sessions.some((session) => session.hidden === true));
  } finally {
    await demo.close();
  }
  assert.equal(globalThis.Date, real);
  assert.equal(fs.existsSync(temporaryRoot), false);
});

test('連携が無い画面では、デモの常駐サーバーも連携なしと答える', async () => {
  const demo = await startDemoServer({ integrations: { codexAgent: false, crossReview: false } });
  try {
    const state = await demo.getState();
    assert.deepEqual(state.integrations, { codexAgent: false, crossReview: false });
  } finally {
    await demo.close();
  }
});
