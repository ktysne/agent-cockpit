'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createProjectionRecords,
  createReadRouteHarness,
  createStoreJson,
  createTemporaryRoot,
  loadStateFromStoreJson,
} = require('../tools/manual/projection-display-baseline');

const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const T1 = T0 + 1_000;
const T2 = T0 + 2_000;

async function withFixture(run) {
  const temporary = await createTemporaryRoot();
  const states = [];
  const load = async (storeJson) => {
    const result = await loadStateFromStoreJson(storeJson, temporary.root);
    states.push(result);
    return result.state;
  };
  try {
    await run({ temporary, load });
  } finally {
    try {
      for (const { state, filesystemCalls } of states) {
        await state.flushPersistence();
        assert.equal(state.storeWritePending, false);
        assert.equal(filesystemCalls.rename, 0);
        assert.deepEqual(filesystemCalls.rejected, []);
        assert.equal(filesystemCalls.readFile, 1);
      }
    } finally {
      await temporary.cleanup();
    }
  }
}

function record(provider, sessionId, field, at) {
  return { provider, session_id: sessionId, [field]: new Date(at).toISOString() };
}

function projectionFor(provider, sessionId, seed) {
  const projections = createProjectionRecords({
    seed,
    providerMode: provider,
    sessions: 1,
    projections: 1,
    tombstones: 0,
    churn: 0,
  });
  projections.questions[0].sessionId = sessionId;
  return projections;
}

function emptyProjections() {
  return { questions: [], instructions: [], orphanedCommonQuestions: [], unmatchedInstructions: 0 };
}

function addSessionRow(state, sessionId, provider) {
  state.sessions.set(sessionId, {
    session_id: sessionId,
    provider,
    title: `row-${sessionId}`,
    product: null,
    status: '待機中',
    tools: [],
    agents: [],
    permissionWaits: [],
    decisions: [],
    tasks: [],
    tasksUpdatedAt: null,
  });
}

async function routeRead(temporary, state, projections) {
  const route = createReadRouteHarness(state, projections, temporary.webPath);
  const result = await route.readState();
  assert.equal(result.statusCode, 200);
  return result.body;
}

function sessionRow(body, sessionId) {
  return body.sessions.find((session) => session.session_id === sessionId) || null;
}

function jsonWithoutDisplayRecords(state, keep) {
  const store = state.serializeStore();
  store.projectionDisplaySettings = store.projectionDisplaySettings.filter(keep);
  return JSON.stringify(store);
}

test('R01 両providerで新しい同provider writeだけが対象墓標を解除し相手を保つ', async () => {
  await withFixture(async ({ load }) => {
    for (const provider of ['claude', 'codex']) {
      const otherProvider = provider === 'claude' ? 'codex' : 'claude';
      const sessionId = `retention-r01-${provider}`;
      const state = await load(createStoreJson([
        record(provider, sessionId, 'deletedAt', T0),
        record(otherProvider, sessionId, 'deletedAt', T0),
      ]));

      assert.equal(state.clearProjectionDeletionAfterVerifiedWrite(provider, sessionId, T1), true);
      assert.equal(state.projectionDisplayFor(provider, sessionId), null);
      assert.deepEqual(state.projectionDisplayFor(otherProvider, sessionId),
        record(otherProvider, sessionId, 'deletedAt', T0));
    }
  });
});

test('R02 両providerで古い・同時刻・別provider writeは墓標を解除しない', async () => {
  await withFixture(async ({ load }) => {
    for (const provider of ['claude', 'codex']) {
      const otherProvider = provider === 'claude' ? 'codex' : 'claude';
      const sessionId = `retention-r02-${provider}`;
      const state = await load(createStoreJson([record(provider, sessionId, 'deletedAt', T0)]));

      assert.equal(state.clearProjectionDeletionAfterVerifiedWrite(provider, sessionId, T0 - 1), false);
      assert.equal(state.clearProjectionDeletionAfterVerifiedWrite(provider, sessionId, T0), false);
      assert.equal(state.clearProjectionDeletionAfterVerifiedWrite(otherProvider, sessionId, T1), false);
      assert.deepEqual(state.projectionDisplayFor(provider, sessionId),
        record(provider, sessionId, 'deletedAt', T0));
    }
  });
});

test('R03 unknown出自履歴を忘れる候補は同じ質問snapshotを既存rowへ統合する', async () => {
  await withFixture(async ({ temporary, load }) => {
    const sessionId = 'retention-r03-unknown';
    const projections = projectionFor('claude', sessionId, 313);
    const held = await load(createStoreJson([]));
    addSessionRow(held, sessionId, 'claude');
    held.sessionProviderSourcesById.set(sessionId, new Set(['claude']));
    held.unknownSessionProviderSourceIds.add(sessionId);
    const candidate = await load(jsonWithoutDisplayRecords(held, () => true));
    addSessionRow(candidate, sessionId, 'claude');
    candidate.sessionProviderSourcesById.set(sessionId, new Set(['claude']));
    candidate.unknownSessionProviderSourceIds.add(sessionId);
    candidate.unknownSessionProviderSourceIds.delete(sessionId);

    const heldRow = sessionRow(await routeRead(temporary, held, projections), sessionId);
    const candidateRow = sessionRow(await routeRead(temporary, candidate, projections), sessionId);
    assert.ok(heldRow);
    assert.ok(candidateRow);
    assert.equal(heldRow.commonQuestions?.length || 0, 0);
    assert.equal(candidateRow.commonQuestions.length, 1);
  });
});

test('R04 Claude出自を忘れる候補はCodex questionをCodex real rowへ誤統合する', async () => {
  await withFixture(async ({ temporary, load }) => {
    const sessionId = 'retention-r04-providers';
    const projections = projectionFor('codex', sessionId, 314);
    const held = await load(createStoreJson([]));
    addSessionRow(held, sessionId, 'codex');
    held.sessionProviderSourcesById.set(sessionId, new Set(['claude', 'codex']));
    const candidate = await load(jsonWithoutDisplayRecords(held, () => true));
    addSessionRow(candidate, sessionId, 'codex');
    candidate.sessionProviderSourcesById.set(sessionId, new Set(held.sessionProviderSourcesById.get(sessionId)));
    candidate.sessionProviderSourcesById.get(sessionId).delete('claude');

    const heldRow = sessionRow(await routeRead(temporary, held, projections), sessionId);
    const candidateRow = sessionRow(await routeRead(temporary, candidate, projections), sessionId);
    assert.ok(heldRow);
    assert.ok(candidateRow);
    assert.equal(heldRow.provider, 'codex');
    assert.equal(heldRow.commonQuestions?.length || 0, 0);
    assert.equal(candidateRow.commonQuestions.length, 1);
  });
});

test('R05 古いprojection再登場は保持墓標で抑止され、墓標をJSONから落とす候補では表示される', async () => {
  await withFixture(async ({ temporary, load }) => {
    for (const provider of ['claude', 'codex']) {
      const sessionId = `retention-r05-old-snapshot-${provider}`;
      const projections = projectionFor(provider, sessionId, provider === 'claude' ? 315 : 316);
      const state = await load(createStoreJson([]));
      assert.ok(sessionRow(await routeRead(temporary, state, projections), sessionId));
      assert.equal(state.deleteProjectionDisplay(provider, sessionId, T0), true);
      assert.equal(sessionRow(await routeRead(temporary, state, projections), sessionId), null);
      assert.deepEqual(state.projectionDisplayFor(provider, sessionId),
        record(provider, sessionId, 'deletedAt', T0));

      assert.equal(sessionRow(await routeRead(temporary, state, emptyProjections()), sessionId), null);
      assert.deepEqual(state.projectionDisplayFor(provider, sessionId),
        record(provider, sessionId, 'deletedAt', T0));
      assert.equal(sessionRow(await routeRead(temporary, state, projections), sessionId), null);
      assert.deepEqual(state.projectionDisplayFor(provider, sessionId),
        record(provider, sessionId, 'deletedAt', T0));

      const candidate = await load(jsonWithoutDisplayRecords(state, () => false));
      assert.ok(sessionRow(await routeRead(temporary, candidate, projections), sessionId));
      assert.deepEqual(state.projectionDisplayFor(provider, sessionId),
        record(provider, sessionId, 'deletedAt', T0));
    }
  });
});

test('R06 両providerのcold restoreは保持storeの墓標を復元し忘れたJSON候補を再表示する', async () => {
  await withFixture(async ({ temporary, load }) => {
    for (const provider of ['claude', 'codex']) {
      const sessionId = `retention-r06-${provider}`;
      const projections = projectionFor(provider, sessionId, provider === 'claude' ? 316 : 317);
      const retainedJson = createStoreJson([record(provider, sessionId, 'deletedAt', T0)]);
      const retained = await load(retainedJson);
      const forgottenJson = jsonWithoutDisplayRecords(retained, () => false);
      const candidate = await load(forgottenJson);

      assert.equal(sessionRow(await routeRead(temporary, retained, projections), sessionId), null);
      assert.ok(sessionRow(await routeRead(temporary, candidate, projections), sessionId));
      assert.deepEqual(retained.projectionDisplayFor(provider, sessionId),
        record(provider, sessionId, 'deletedAt', T0));
    }
  });
});

test('R07 同じ中間時刻writeは最新墓標を保ち、古い保存JSON候補を解除する', async () => {
  await withFixture(async ({ temporary, load }) => {
    for (const provider of ['claude', 'codex']) {
      const sessionId = `retention-r07-${provider}`;
      const projections = projectionFor(provider, sessionId, provider === 'claude' ? 318 : 319);
      const trace = await load(createStoreJson([]));
      assert.equal(trace.deleteProjectionDisplay(provider, sessionId, T0), true);
      assert.deepEqual(trace.projectionDisplayFor(provider, sessionId),
        record(provider, sessionId, 'deletedAt', T0));
      const oldStoreJson = JSON.stringify(trace.serializeStore());
      assert.equal(trace.clearProjectionDeletionAfterVerifiedWrite(provider, sessionId, T1), true);
      assert.equal(trace.projectionDisplayFor(provider, sessionId), null);
      assert.equal(trace.deleteProjectionDisplay(provider, sessionId, T2), true);
      assert.deepEqual(trace.projectionDisplayFor(provider, sessionId),
        record(provider, sessionId, 'deletedAt', T2));
      const latestStoreJson = JSON.stringify(trace.serializeStore());
      const latest = await load(latestStoreJson);
      const candidate = await load(oldStoreJson);
      const intermediateWrite = T1 + 500;

      assert.equal(latest.clearProjectionDeletionAfterVerifiedWrite(provider, sessionId, intermediateWrite), false);
      assert.equal(candidate.clearProjectionDeletionAfterVerifiedWrite(provider, sessionId, intermediateWrite), true);
      assert.equal(sessionRow(await routeRead(temporary, latest, projections), sessionId), null);
      assert.ok(sessionRow(await routeRead(temporary, candidate, projections), sessionId));
    }
  });
});

test('R08 inactive期間にhidden選好を忘れる候補は同identity再登場時に表示する', async () => {
  await withFixture(async ({ temporary, load }) => {
    for (const provider of ['claude', 'codex']) {
      const sessionId = `retention-r08-hidden-${provider}`;
      const projections = projectionFor(provider, sessionId, provider === 'claude' ? 320 : 321);
      const retained = await load(createStoreJson([record(provider, sessionId, 'hiddenAt', T0)]));
      assert.equal(sessionRow(await routeRead(temporary, retained, emptyProjections()), sessionId), null);
      const candidate = await load(jsonWithoutDisplayRecords(retained, () => false));

      const retainedRow = sessionRow(await routeRead(temporary, retained, projections), sessionId);
      const candidateRow = sessionRow(await routeRead(temporary, candidate, projections), sessionId);
      assert.ok(retainedRow);
      assert.ok(candidateRow);
      assert.equal(retainedRow.hidden, true);
      assert.notEqual(candidateRow.hidden, true);
    }
  });
});
