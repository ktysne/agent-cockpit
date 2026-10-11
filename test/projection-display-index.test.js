'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ProjectionDisplayIndex = require('../src/server/projection-display-index');
const { DashboardState } = require('../src/server/state');

function key(provider, sessionId) {
  return `${provider}\0${sessionId}`;
}

function fullScan(records, sessionId) {
  return [...records.values()]
    .filter((record) => record.session_id === sessionId)
    .map((record) => ({ ...record }));
}

function internalStore(projectionDisplaySettings) {
  return {
    display: null,
    deletedSessions: new Map(),
    plans: new Map(),
    askDecisionBindings: new Map(),
    decisionLifecycles: new Map(),
    seenAtByProduct: new Map(),
    ciFailures: [],
    closedTasks: [],
    hiddenSessions: [],
    projectionDisplaySettings,
    prs: [],
    relatedPrs: [],
    retargetedPrs: [],
    mergedPrs: [],
    mergeReservations: [],
    mergeIntents: [],
    lastPullRequestMethods: new Map(),
    crossReviewSkips: [],
  };
}

test('session index は旧全件走査の順序とcopy境界を保ち、更新・削除後にbucketを合わせる', () => {
  const index = new ProjectionDisplayIndex();
  const baseline = new Map();
  const set = (record) => {
    const recordKey = key(record.provider, record.session_id);
    index.set(recordKey, record);
    baseline.set(recordKey, { ...record });
    for (const sessionId of ['session-a', 'session-b', 'session-c']) {
      assert.deepEqual(index.recordsForSession(sessionId), fullScan(baseline, sessionId));
    }
  };
  const remove = (recordKey) => {
    assert.equal(index.delete(recordKey), baseline.delete(recordKey));
    for (const sessionId of ['session-a', 'session-b', 'session-c']) {
      assert.deepEqual(index.recordsForSession(sessionId), fullScan(baseline, sessionId));
    }
  };

  set({ provider: 'claude', session_id: 'session-a', hiddenAt: '2026-10-01T00:00:00.000Z' });
  set({ provider: 'codex', session_id: 'session-a', deletedAt: '2026-10-02T00:00:00.000Z' });
  set({ provider: 'claude', session_id: 'session-b', hiddenAt: '2026-10-03T00:00:00.000Z' });
  set({ provider: 'claude', session_id: 'session-c', hiddenAt: '2026-10-04T00:00:00.000Z' });
  set({ provider: 'codex', session_id: 'session-b', deletedAt: '2026-10-04T12:00:00.000Z' });

  const claudeA = key('claude', 'session-a');
  set({ provider: 'claude', session_id: 'session-a', hiddenAt: '2026-10-05T00:00:00.000Z' });
  assert.deepEqual([...index.entries()].map(([recordKey]) => recordKey), [...baseline.keys()]);
  assert.deepEqual([...index.values()], [...baseline.values()]);

  const records = index.recordsForSession('session-a');
  records[0].hiddenAt = 'mutated';
  records.pop();
  const found = index.get(claudeA);
  found.hiddenAt = 'mutated';
  const entries = [...index.entries()];
  entries[0][1].hiddenAt = 'mutated';
  const snapshot = index.snapshot();
  snapshot.delete(claudeA);
  snapshot.get(key('codex', 'session-a')).deletedAt = 'mutated';
  assert.deepEqual(index.recordsForSession('session-a'), fullScan(baseline, 'session-a'));

  remove(key('codex', 'session-a'));
  remove(key('claude', 'session-b'));
  assert.deepEqual(index.recordsForSession('session-b'), fullScan(baseline, 'session-b'));
  set({ provider: 'claude', session_id: 'session-b', hiddenAt: '2026-10-06T00:00:00.000Z' });
  assert.deepEqual(index.recordsForSession('session-b').map((record) => record.provider), ['codex', 'claude']);
  remove(key('claude', 'session-b'));
  remove(key('codex', 'session-b'));
  assert.deepEqual(index.recordsForSession('session-b'), []);
  assert.deepEqual([...index.entries()].map(([recordKey]) => recordKey), [...baseline.keys()]);
  assert.throws(() => index.set(claudeA, {
    provider: 'claude', session_id: 'session-b', hiddenAt: '2026-10-07T00:00:00.000Z',
  }), /cannot change session/);
  assert.deepEqual(index.recordsForSession('session-a'), fullScan(baseline, 'session-a'));
});

test('DashboardState の全mutatorとrestoreがrecordsとsession indexを同期する', () => {
  const state = new DashboardState();
  const now = Date.parse('2026-10-08T00:00:00.000Z');
  assert.equal(state.setProjectionHidden('claude', 'index-hidden', true, now), true);
  assert.equal(state.setProjectionHidden('codex', 'index-hidden', true, now + 1), true);
  assert.deepEqual(state.projectionDisplayRecordsForSession('index-hidden'), [
    { provider: 'claude', session_id: 'index-hidden', hiddenAt: new Date(now).toISOString() },
    { provider: 'codex', session_id: 'index-hidden', hiddenAt: new Date(now + 1).toISOString() },
  ]);

  const diagnostic = state.projectionDisplaySettings;
  diagnostic.clear();
  assert.equal(state.projectionDisplayFor('claude', 'index-hidden')?.hiddenAt, new Date(now).toISOString());
  const diagnosticRecord = state.projectionDisplaySettings.get(key('claude', 'index-hidden'));
  diagnosticRecord.hiddenAt = 'mutated';
  assert.equal(state.projectionDisplayFor('claude', 'index-hidden')?.hiddenAt, new Date(now).toISOString());

  assert.equal(state.setProjectionHidden('claude', 'index-hidden', false, now + 2), true);
  assert.deepEqual(state.projectionDisplayRecordsForSession('index-hidden'), [
    { provider: 'codex', session_id: 'index-hidden', hiddenAt: new Date(now + 1).toISOString() },
  ]);
  assert.equal(state.deleteProjectionDisplay('codex', 'index-hidden', now + 3), true);
  assert.equal(state.clearProjectionDeletionAfterVerifiedWrite('codex', 'index-hidden', now + 3), false);
  assert.equal(state.projectionDisplayRecordsForSession('index-hidden').length, 1);
  assert.equal(state.clearProjectionDeletionAfterVerifiedWrite('codex', 'index-hidden', now + 4), true);
  assert.deepEqual(state.projectionDisplayRecordsForSession('index-hidden'), []);

  assert.equal(state.setProjectionHidden('claude', 'clear-hidden', true, now), true);
  assert.equal(state.clearHiddenSessions(), 1);
  assert.deepEqual(state.projectionDisplayRecordsForSession('clear-hidden'), []);

  state.restoreStore(internalStore([
    { provider: 'claude', session_id: 'restore-old', hiddenAt: new Date(now).toISOString() },
    { provider: 'codex', session_id: 'legacy-both', hiddenAt: new Date(now).toISOString(), deletedAt: new Date(now + 1).toISOString() },
  ]), now);
  assert.equal(state.projectionDisplayRecordsForSession('restore-old').length, 1);
  assert.equal(state.clearHiddenSessions(), 2);
  assert.deepEqual(state.projectionDisplayRecordsForSession('restore-old'), []);
  assert.deepEqual(state.projectionDisplayFor('codex', 'legacy-both'), {
    provider: 'codex', session_id: 'legacy-both', deletedAt: new Date(now + 1).toISOString(),
  });

  state.restoreStore(internalStore([
    { provider: 'claude', session_id: 'restore-new', deletedAt: new Date(now + 2).toISOString() },
  ]), now + 2);
  assert.deepEqual(state.projectionDisplayRecordsForSession('restore-old'), []);
  assert.deepEqual(state.projectionDisplayRecordsForSession('legacy-both'), []);
  assert.deepEqual(state.projectionDisplayRecordsForSession('restore-new'), [
    { provider: 'claude', session_id: 'restore-new', deletedAt: new Date(now + 2).toISOString() },
  ]);
});

test('session lookup は隔離realm内でもcanonical Mapを走査せず対象bucketだけ訪問する', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/server/projection-display-index.js'), 'utf8');
  const context = vm.createContext({ module: { exports: {} } });
  vm.runInContext(`
    const metrics = { enabled: false, mapIterations: 0, canonicalGets: 0, setVisits: 0, targetBucketDeletes: 0 };
    const NativeMap = Map;
    const NativeSet = Set;
    const rejectMapIteration = (iterator) => {
      if (metrics.enabled) {
        metrics.mapIterations += 1;
        throw new Error('canonical Map iteration during lookup');
      }
      return iterator;
    };
    class GuardedMap extends NativeMap {
      get(key) {
        if (metrics.enabled && typeof key === 'string' && key.includes('\\0')) metrics.canonicalGets += 1;
        return super.get(key);
      }
      delete(key) {
        if (metrics.enabled && key === 'target-session') metrics.targetBucketDeletes += 1;
        return super.delete(key);
      }
      entries() { return rejectMapIteration(super.entries()); }
      keys() { return rejectMapIteration(super.keys()); }
      values() { return rejectMapIteration(super.values()); }
      [Symbol.iterator]() { return rejectMapIteration(super[Symbol.iterator]()); }
      forEach(callback, thisArg) {
        if (metrics.enabled) {
          metrics.mapIterations += 1;
          throw new Error('canonical Map iteration during lookup');
        }
        return super.forEach(callback, thisArg);
      }
    }
    class CountedSet extends NativeSet {
      #count(iterator) {
        if (!metrics.enabled) return iterator;
        return {
          next() {
            const result = iterator.next();
            if (!result.done) metrics.setVisits += 1;
            return result;
          },
          [Symbol.iterator]() { return this; },
        };
      }
      values() { return this.#count(super.values()); }
      keys() { return this.values(); }
      entries() { return this.#count(super.entries()); }
      [Symbol.iterator]() { return this.values(); }
      forEach(callback, thisArg) {
        return super.forEach((value) => {
          if (metrics.enabled) metrics.setVisits += 1;
          callback.call(thisArg, value, value, this);
        });
      }
    }
    globalThis.Map = GuardedMap;
    globalThis.Set = CountedSet;
    globalThis.metrics = metrics;
  `, context);
  vm.runInContext(source, context, { filename: 'projection-display-index.js' });
  const RealmIndex = context.module.exports;
  const index = new RealmIndex();
  for (const [i, provider] of ['claude', 'codex'].entries()) {
    const sessionId = 'target-session';
    index.set(`${provider}\0${sessionId}`, { provider, session_id: sessionId, hiddenAt: `2026-10-0${i + 1}T00:00:00.000Z` });
  }
  for (let i = 0; i < 100; i += 1) {
    const sessionId = `unrelated-${i}`;
    index.set(`claude\0${sessionId}`, { provider: 'claude', session_id: sessionId, hiddenAt: '2026-10-01T00:00:00.000Z' });
  }

  context.metrics.enabled = true;
  const rows = index.recordsForSession('target-session');
  const missing = index.recordsForSession('missing-session');
  context.metrics.enabled = false;
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
    { provider: 'claude', session_id: 'target-session', hiddenAt: '2026-10-01T00:00:00.000Z' },
    { provider: 'codex', session_id: 'target-session', hiddenAt: '2026-10-02T00:00:00.000Z' },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(missing)), []);
  assert.equal(context.metrics.mapIterations, 0);
  assert.equal(context.metrics.canonicalGets, 2);
  assert.equal(context.metrics.setVisits, 2);

  context.metrics.enabled = true;
  assert.equal(index.delete('claude\0target-session'), true);
  assert.equal(context.metrics.targetBucketDeletes, 0);
  assert.equal(index.delete('codex\0target-session'), true);
  assert.equal(context.metrics.targetBucketDeletes, 1);

  context.metrics.enabled = false;
  index.set('claude\0target-session', {
    provider: 'claude', session_id: 'target-session', hiddenAt: '2026-10-01T00:00:00.000Z',
  });
  index.set('codex\0target-session', {
    provider: 'codex', session_id: 'target-session', hiddenAt: '2026-10-02T00:00:00.000Z',
  });
  context.metrics.mapIterations = 0;
  context.metrics.canonicalGets = 0;
  context.metrics.setVisits = 0;
  context.metrics.enabled = true;
  const restoredRows = index.recordsForSession('target-session');
  context.metrics.enabled = false;
  assert.deepEqual(JSON.parse(JSON.stringify(restoredRows)), [
    { provider: 'claude', session_id: 'target-session', hiddenAt: '2026-10-01T00:00:00.000Z' },
    { provider: 'codex', session_id: 'target-session', hiddenAt: '2026-10-02T00:00:00.000Z' },
  ]);
  assert.equal(context.metrics.mapIterations, 0);
  assert.equal(context.metrics.canonicalGets, 2);
  assert.equal(context.metrics.setVisits, 2);
});
