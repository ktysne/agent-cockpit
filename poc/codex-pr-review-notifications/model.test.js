'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const CONTRACT = require('./fixture-contract');
const { PrReviewModel, execKey } = require('./model');

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);
const CONFIG_A = { vendor: 'codex', model: 'model-a', effort: 'high', transport: 'app-server' };
const CONFIG_B = { vendor: 'claude', model: 'model-b', effort: 'medium', transport: 'cli' };
const RESULT = { resultId: 'result-event', resultDigest: HEAD_C };
const PR = { owner: 'OpenAI', repo: 'Agent-Cockpit', number: 164 };

function newModel() {
  return new PrReviewModel({ configuration: CONFIG_A });
}

function identity(name, provider = 'codex') {
  return { provider, launchId: 'launch-' + name, runId: 'run-' + name, attemptId: 'attempt-' + name };
}

function addRun(model, name, options = {}) {
  const run = identity(name, options.provider || model.routing.vendor);
  const configuration = options.configuration || (model.routing.vendor === run.provider
    ? model.routing : { ...model.routing, vendor: run.provider });
  const value = model.registerExecution({
    ...run,
    origin: options.origin || 'independent',
    purpose: options.purpose || 'work',
    ...(options.parent ? { parent: options.parent } : {}),
    configuration,
  });
  assert.deepEqual(value, run);
  return run;
}

function addPr(model, input = {}) {
  return model.registerPr({
    ...PR,
    source: input.source || 'claude_mcp',
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    ...(input.registeredBy ? { registeredBy: input.registeredBy } : {}),
  });
}

function setPrState(model, head = HEAD_A, base = 'main') {
  assert.equal(model.setPrState({ ...PR, base, head }), true);
}

function addReview(model, options = {}) {
  const run = options.run || addRun(model, 'review-' + options.round + '-' + options.roundId, { purpose: 'review' });
  const round = options.round || 1;
  const roundId = options.roundId || 'round-' + round;
  assert.ok(model.startReview({ pr: PR, branch: options.branch || 'feature', run, round, roundId }));
  if (options.conclude === false) return { run, round, roundId };
  assert.equal(model.concludeReview({
    pr: PR, branch: options.branch || 'feature', run, round, roundId,
    reviewedHead: options.reviewedHead || HEAD_A,
    conclusion: options.conclusion || 'success',
    ...(options.conclusion === 'not_required' || options.conclusion === 'failed'
      || options.conclusion === 'changes_requested' ? {} : {
        convergenceHead: options.convergenceHead || options.reviewedHead || HEAD_A,
      }),
  }), true);
  return { run, round, roundId };
}

function fakeGh(status, method) {
  return {
    kind: 'fixture',
    calls: [],
    async merge(request) {
      this.calls.push(request);
      return { status, ...(method ? { method } : {}) };
    },
  };
}

function notification(model, eventId, target) {
  return model.getNotification({ eventId, target });
}

test('notification handoff rechecks child, parent, and cancellation state immediately before delivery', () => {
  const model = newModel();
  const parent = { provider: 'claude', sessionId: 'session', agentId: 'agent', toolUseId: 'tool' };
  const closedChild = addRun(model, 'closed-child', { origin: 'delegated', parent });
  const closedEvent = { eventId: 'closed-target', type: 'merge', pr: PR, target: closedChild };
  assert.equal(model.enqueueNotification(closedEvent).accepted, true);
  assert.equal(model.confirmChildEnded(closedChild), true);
  assert.equal(model.notificationHandoff(closedEvent), false);

  const stopped = addRun(model, 'stopped-parent', {
    origin: 'delegated',
    parent: { provider: 'claude', sessionId: 's2', agentId: 'a2', toolUseId: 't2' },
  });
  const stoppedEvent = { eventId: 'stopped-target', type: 'conflict', pr: PR, target: stopped };
  assert.equal(model.enqueueNotification(stoppedEvent).accepted, true);
  assert.equal(model.setParentState(stopped, 'stopped'), true);
  assert.equal(model.notificationHandoff(stoppedEvent), false);

  const ended = addRun(model, 'ended-parent', {
    origin: 'delegated',
    parent: { provider: 'claude', sessionId: 's3', agentId: 'a3', toolUseId: 't3' },
  });
  const endedEvent = { eventId: 'ended-target', type: 'queue', pr: PR, target: ended };
  assert.equal(model.enqueueNotification(endedEvent).accepted, true);
  assert.equal(model.setParentState(ended, 'ended'), true);
  assert.equal(model.setParentState(ended, 'running'), false);
  assert.equal(model.notificationHandoff(endedEvent), false);

  const cancelling = addRun(model, 'cancel-pending', {
    origin: 'delegated',
    parent: { provider: 'claude', sessionId: 's4', agentId: 'a4', toolUseId: 't4' },
  });
  const cancelEvent = { eventId: 'cancel-target', type: 'restack', pr: PR, target: cancelling };
  assert.equal(model.enqueueNotification(cancelEvent).accepted, true);
  assert.equal(model.requestCancel(cancelling), true);
  assert.equal(model.lifecycle(cancelling).cancelState, 'requested');
  assert.equal(model.notificationHandoff(cancelEvent), false);
  assert.equal(model.confirmCancel(cancelling), false);
  assert.equal(model.lifecycle(cancelling).cancelState, 'requested');
  assert.equal(model.confirmChildEnded(cancelling), true);
  assert.equal(model.confirmCancel(cancelling), true);
  assert.equal(model.lifecycle(cancelling).cancelState, 'confirmed');
  assert.equal(model.lifecycle(cancelling).childEnded, true);
  assert.equal(model.returnResult(cancelling), false);
});

test('review reservation records a screen-confirmed head and waits for review convergence at execution time', async () => {
  const model = newModel();
  addPr(model);
  setPrState(model, HEAD_A);
  assert.equal(model.reserveMerge({ pr: PR, branch: 'feature', defaultBranch: 'main', screenHead: HEAD_A }).accepted, true);
  assert.equal(model.reserveMerge({ pr: PR, branch: 'feature', defaultBranch: 'main', screenHead: HEAD_A }).reason, 'reservation_exists');
  assert.equal(model.reserveMerge({ pr: PR, branch: 'feature', defaultBranch: 'main', screenHead: HEAD_B }).reason,
    'screen_head_stale');
  const gh = fakeGh('MERGED', 'merge');
  assert.equal((await model.attemptMerge({
    pr: PR, branch: 'feature', defaultBranch: 'main', mode: 'review_reservation',
  }, gh)).reason, 'no_review_round');
  assert.equal(gh.calls.length, 0);
});

test('in-flight merge requests lock duplicate calls and reject cancellation after handoff begins', async () => {
  const model = newModel();
  addPr(model);
  setPrState(model, HEAD_A);
  addReview(model, { round: 1, roundId: 'race-review', reviewedHead: HEAD_A });
  assert.equal(model.reserveMerge({
    pr: PR, branch: 'feature', defaultBranch: 'main', screenHead: HEAD_A,
  }).accepted, true);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const gh = {
    kind: 'fixture',
    calls: [],
    merge(request) {
      this.calls.push(request);
      return gate;
    },
  };
  const input = { pr: PR, branch: 'feature', defaultBranch: 'main', mode: 'review_reservation' };
  const first = model.attemptMerge(input, gh);
  assert.equal(gh.calls.length, 1);
  assert.equal((await model.attemptMerge(input, gh)).reason, 'state_unavailable');
  assert.equal(gh.calls.length, 1);
  assert.equal(model.cancelMerge({ pr: PR, branch: 'feature' }), false);
  release({ status: 'OPEN' });
  assert.equal((await first).reason, 'merge_queued');
  assert.equal((await model.attemptMerge(input, gh)).reason, 'state_unavailable');
  assert.equal(gh.calls.length, 1);
});

test('a head change during a pending fake gh call leaves the merge result unknown', async () => {
  const model = newModel();
  addPr(model);
  setPrState(model, HEAD_A);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const gh = { kind: 'fixture', merge: () => gate };
  const first = model.attemptMerge({
    pr: PR, defaultBranch: 'main', mode: 'manual', screenHead: HEAD_A,
  }, gh);
  setPrState(model, HEAD_B);
  release({ status: 'MERGED', method: 'squash' });
  assert.equal((await first).reason, 'merge_unknown');
  assert.equal(model.project().pullRequests[0].mergeState, 'unknown');
  assert.equal(model.project().notifications.some((row) => row.payload?.status === 'merged'), false);
});

test('a base change while fake gh is pending makes the merge result unknown without restacking', async () => {
  const model = newModel();
  const owner = addRun(model, 'base-change-owner');
  addPr(model, { createdBy: owner });
  const stackedPr = { owner: PR.owner, repo: PR.repo, number: 165 };
  const stackedOwner = addRun(model, 'base-change-stacked-owner');
  model.registerPr({ ...stackedPr, source: 'claude_mcp', createdBy: stackedOwner });
  assert.equal(model.registerStackedPr({ lowerPr: PR, stackedPr }), true);
  setPrState(model, HEAD_A, 'main');

  let resolveMerge;
  const response = new Promise((resolve) => { resolveMerge = resolve; });
  const gh = {
    kind: 'fixture',
    calls: [],
    merge(request) { this.calls.push(request); return response; },
  };
  const attempt = model.attemptMerge({
    pr: PR, defaultBranch: 'main', mode: 'manual', screenHead: HEAD_A,
  }, gh);
  assert.equal(model.project().pullRequests.find((row) => row.number === PR.number).mergeState, 'in_flight');
  setPrState(model, HEAD_A, 'feature-base');
  resolveMerge({ status: 'MERGED', method: 'squash' });

  assert.equal((await attempt).reason, 'merge_unknown');
  assert.equal(gh.calls.length, 1);
  assert.equal(gh.calls[0].base, 'main');
  assert.equal(model.project().pullRequests.find((row) => row.number === PR.number).mergeState, 'unknown');
  assert.equal(model.project().notifications.some((row) => row.payload?.status === 'merged'), false);
  assert.equal(model.project().notifications.some((row) => row.type === 'restack'), false);
});

test('a conflict can be retried only after an explicit head change and restack goes to the stacked PR', async () => {
  const model = newModel();
  const lowerOwner = addRun(model, 'conflict-lower-owner');
  const upperOwner = addRun(model, 'conflict-upper-owner');
  addPr(model, { createdBy: lowerOwner });
  const upperPr = { owner: PR.owner, repo: PR.repo, number: 165 };
  model.registerPr({ ...upperPr, source: 'delegated_codex_gh', createdBy: upperOwner });
  assert.equal(model.registerStackedPr({ lowerPr: PR, stackedPr: upperPr }), true);
  setPrState(model, HEAD_A);

  const conflicted = await model.attemptMerge({
    pr: PR, defaultBranch: 'main', mode: 'manual', screenHead: HEAD_A,
  }, fakeGh('CONFLICT'));
  assert.equal(conflicted.reason, 'merge_conflict');
  assert.equal(model.project().pullRequests.find((row) => row.number === PR.number).mergeState, 'conflict');
  setPrState(model, HEAD_B);
  assert.equal(model.project().pullRequests.find((row) => row.number === PR.number).mergeState, 'open');

  const merged = await model.attemptMerge({
    pr: PR, defaultBranch: 'main', mode: 'manual', screenHead: HEAD_B,
  }, fakeGh('MERGED', 'squash'));
  assert.equal(merged.reason, 'merged');
  const restack = model.project().notifications.find((row) => row.type === 'restack');
  assert.deepEqual(restack.pr, { owner: PR.owner.toLowerCase(), repo: PR.repo.toLowerCase(), number: 165 });
  assert.deepEqual(restack.target, upperOwner);
});

test('restack notifications to multiple stacked PRs owned by one run keep distinct stable IDs', async () => {
  const model = newModel();
  addPr(model);
  const owner = addRun(model, 'shared-stacked-owner');
  for (const number of [165, 166]) {
    const stackedPr = { owner: PR.owner, repo: PR.repo, number };
    model.registerPr({ ...stackedPr, source: 'claude_mcp', createdBy: owner });
    assert.equal(model.registerStackedPr({ lowerPr: PR, stackedPr }), true);
  }
  setPrState(model, HEAD_A);
  assert.equal((await model.attemptMerge({
    pr: PR, defaultBranch: 'main', mode: 'manual', screenHead: HEAD_A,
  }, fakeGh('MERGED', 'squash'))).reason, 'merged');

  const restacks = model.project().notifications.filter((row) => row.type === 'restack');
  assert.equal(restacks.length, 2);
  assert.deepEqual(restacks.map((row) => row.pr.number).sort(), [165, 166]);
  assert.notEqual(restacks[0].eventId, restacks[1].eventId);
  for (const row of restacks) {
    assert.equal(model.enqueueNotification(row).reason, 'duplicate');
  }
  assert.equal(model.project().notifications.length, 2);
});

test('generated notification IDs stay within the safe identifier bound for long PR names', async () => {
  const model = newModel();
  const longPr = { owner: 'owner' + 'x'.repeat(220), repo: 'repo' + 'y'.repeat(220), number: 9 };
  const target = addRun(model, 'long-pr-target');
  model.registerPr({ ...longPr, source: 'claude_mcp', createdBy: target });
  assert.equal(model.setPrState({ ...longPr, base: 'main', head: HEAD_A }), true);
  assert.equal((await model.attemptMerge({
    pr: longPr, defaultBranch: 'main', mode: 'manual', screenHead: HEAD_A,
  }, fakeGh('MERGED', 'merge'))).reason, 'merged');
  const eventId = model.project().notifications[0].eventId;
  assert.ok(eventId.length <= 128);
  assert.match(eventId, /^pr-[a-f0-9]{64}-merged$/);
});

test('contract labels every model result as fixture evidence and disallows inference fields', () => {
  assert.equal(CONTRACT.evidenceKind, 'synthetic-fixture-only');
  assert.deepEqual(CONTRACT.prohibitedInferenceInputs, ['pid', 'cwd', 'timestamp']);
  assert.deepEqual(CONTRACT.parentSessionTerminationKey, ['provider', 'sessionId']);
  const model = newModel();
  const first = addRun(model, 'explicit-one');
  const second = addRun(model, 'explicit-two');

  assert.equal(model.observe({
    source: 'shell', eventId: 'without-run-id',
    provider: 'codex', launchId: first.launchId, pid: 42, cwd: 'same', timestamp: 1,
  }), false);
  assert.equal(model.observe({
    source: 'shell', eventId: 'one', execution: first, pid: 1, cwd: 'same', timestamp: 100,
  }), true);
  assert.equal(model.observe({
    source: 'shell', eventId: 'two', execution: second, pid: 1, cwd: 'same', timestamp: 100,
  }), true);
  assert.equal(model.project().executions.length, 2);
  assert.notEqual(execKey(first), execKey(second));
});

test('PR routes case-fold owner and repository while preserving registration and creation origins once', () => {
  const model = newModel();
  const creator = addRun(model, 'creator');
  const claudeParent = addRun(model, 'parent', { provider: 'claude' });
  const first = addPr(model, { source: 'claude_mcp', createdBy: creator, registeredBy: claudeParent });
  const second = model.registerPr({
    owner: 'openai', repo: 'agent-cockpit', number: 164,
    source: 'delegated_codex_gh', createdBy: creator, registeredBy: claudeParent,
  });

  assert.equal(first.key, second.key);
  assert.equal(model.project().pullRequests.length, 1);
  const row = model.project().pullRequests[0];
  assert.deepEqual(row.registrationSources, ['claude_mcp', 'delegated_codex_gh']);
  assert.equal(row.creationOrigins.length, 2);
  assert.deepEqual(row.notificationTargets, [creator, claudeParent].sort((a, b) => execKey(a).localeCompare(execKey(b))));
});

test('attempts remain separate and PID, cwd, or nearby timestamps never join them', () => {
  const model = newModel();
  const base = identity('retry-one');
  const attemptOne = model.registerExecution({ ...base, origin: 'independent', purpose: 'work' });
  const attemptTwo = model.registerExecution({
    ...base, attemptId: 'attempt-two', origin: 'independent', purpose: 'work',
  });
  assert.ok(attemptOne);
  assert.ok(attemptTwo);
  assert.notEqual(execKey(attemptOne), execKey(attemptTwo));

  assert.equal(model.observe({
    source: 'external', eventId: 'event-a', execution: attemptOne, pid: 100, cwd: 'work', timestamp: 1000,
  }), true);
  assert.equal(model.observe({
    source: 'shell', eventId: 'event-b', execution: attemptTwo, pid: 100, cwd: 'work', timestamp: 1001,
  }), true);
  assert.equal(model.project().executions.length, 2);
  assert.deepEqual(model.project().executions.map((row) => row.sources), [['external'], ['shell']]);
});

test('native, shell, and external observations attach only through explicit canonical attempt identity', () => {
  const model = newModel();
  const one = addRun(model, 'native-one');
  const two = addRun(model, 'native-two');
  const native = { provider: 'codex', vendor: 'codex', scope: 'home-a', nativeId: 'thread-1' };

  assert.equal(model.bindNative({ execution: one, nativeIdentity: { ...native, vendor: 'claude' } }), false);
  assert.equal(model.bindNative({ execution: { ...one, provider: 'claude' }, nativeIdentity: native }), false);
  assert.equal(model.bindNative({ execution: one, nativeIdentity: native }), true);
  assert.equal(model.bindNative({ execution: two, nativeIdentity: native }), false);
  assert.equal(model.observe({ source: 'native', eventId: 'native-event', nativeIdentity: native }), true);
  assert.equal(model.observe({
    source: 'native', eventId: 'wrong-attempt', nativeIdentity: native, execution: two,
  }), false);
  assert.equal(model.observe({ source: 'shell', eventId: 'shell-event', execution: one }), true);
  assert.equal(model.observe({ source: 'external', eventId: 'runner-event', execution: one }), true);

  const projection = model.project();
  assert.equal(projection.executions.length, 2);
  assert.deepEqual(projection.executions.find((row) => execKey(row.identity) === execKey(one)).sources,
    ['external', 'native', 'shell']);
  assert.equal(projection.executions.find((row) => execKey(row.identity) === execKey(one)).purpose, 'work');
});

test('parent tool-use identity is required for delegated registration and cannot be inferred', () => {
  const model = newModel();
  const bad = {
    ...identity('missing-parent-tool'), origin: 'delegated', purpose: 'work',
    parent: { provider: 'claude', sessionId: 'session-1', agentId: 'agent-1' },
  };
  assert.equal(model.registerExecution(bad), null);
  const run = model.registerExecution({
    ...identity('with-parent-tool'), origin: 'delegated', purpose: 'review',
    parent: { provider: 'claude', sessionId: 'session-1', agentId: 'agent-1', toolUseId: 'tool-1' },
  });
  assert.ok(run);
  assert.equal(model.project().executions[0].purpose, 'review');
});

test('ending a parent session affects every agent and tool use but preserves other provider/session identities', () => {
  const model = newModel();
  const first = addRun(model, 'shared-parent-first', {
    origin: 'delegated',
    parent: { provider: 'claude', sessionId: 'shared-session', agentId: 'agent-one', toolUseId: 'tool-one' },
  });
  const sibling = addRun(model, 'shared-parent-sibling', {
    origin: 'delegated',
    parent: { provider: 'claude', sessionId: 'shared-session', agentId: 'agent-two', toolUseId: 'tool-two' },
  });
  const otherProvider = addRun(model, 'other-parent-provider', {
    origin: 'delegated',
    parent: { provider: 'codex', sessionId: 'shared-session', agentId: 'agent-one', toolUseId: 'tool-one' },
  });
  const otherSession = addRun(model, 'other-parent-session', {
    origin: 'delegated',
    parent: { provider: 'claude', sessionId: 'different-session', agentId: 'agent-one', toolUseId: 'tool-one' },
  });
  const notice = { eventId: 'parent-ended-notice', type: 'merge', pr: PR, target: sibling };
  assert.equal(model.enqueueNotification(notice).accepted, true);

  assert.equal(model.setParentState(first, 'ended'), true);
  assert.equal(model.lifecycle(first).parentState, 'ended');
  assert.equal(model.lifecycle(sibling).parentState, 'ended');
  assert.equal(model.lifecycle(sibling).childEnded, false);
  assert.equal(model.lifecycle(sibling).cancelState, 'none');
  assert.equal(model.lifecycle(otherProvider).parentState, 'running');
  assert.equal(model.lifecycle(otherSession).parentState, 'running');
  assert.equal(model.notificationHandoff(notice), false);
  assert.equal(model.receiveResult(sibling, RESULT), true);
  assert.equal(model.confirmChildEnded(sibling), true);
  assert.equal(model.returnResult(sibling), false);
  assert.equal(model.lifecycle(sibling).successfulReturn, false);
  assert.equal(model.markParentSessionEnded({
    provider: 'claude', sessionId: 'different-session', agentId: 'must-not-be-accepted',
  }), false);
});

test('a session ended before child registration blocks every origin with that parent', () => {
  const model = newModel();
  const ended = { provider: 'claude', sessionId: 'ended-before-launch' };
  assert.equal(model.markParentSessionEnded(ended), true);
  assert.equal(model.markParentSessionEnded(ended), true);
  const restoredWithoutChildren = PrReviewModel.restore(model.snapshot());
  assert.ok(restoredWithoutChildren);
  assert.equal(restoredWithoutChildren.registerExecution({
    ...identity('blocked-after-empty-restore'), origin: 'independent', purpose: 'work',
    parent: { ...ended, agentId: 'agent', toolUseId: 'tool' },
    configuration: CONFIG_A,
  }), null);
  for (const origin of ['independent', 'delegated']) {
    assert.equal(model.registerExecution({
      ...identity('blocked-' + origin), origin, purpose: 'work',
      parent: { ...ended, agentId: 'agent', toolUseId: 'tool' }, configuration: CONFIG_A,
    }), null);
  }
  assert.ok(model.registerExecution({
    ...identity('same-id-other-provider'), origin: 'independent', purpose: 'work',
    parent: { provider: 'codex', sessionId: ended.sessionId, agentId: 'agent', toolUseId: 'tool' },
    configuration: CONFIG_A,
  }));
  assert.ok(model.registerExecution({
    ...identity('same-provider-other-session', 'claude'), origin: 'independent', purpose: 'work',
    parent: { provider: 'claude', sessionId: 'other-session', agentId: 'agent', toolUseId: 'tool' },
    configuration: CONFIG_B,
  }));
});

test('parent session termination survives restore and blocks resumption while late evidence remains recordable', () => {
  const model = newModel();
  const parent = { provider: 'claude', sessionId: 'restored-ended-session' };
  const target = addRun(model, 'restore-ended-target', {
    origin: 'delegated',
    parent: { ...parent, agentId: 'agent', toolUseId: 'tool' },
  });
  const sibling = addRun(model, 'restore-ended-sibling', {
    origin: 'independent',
    parent: { ...parent, agentId: 'another-agent', toolUseId: 'another-tool' },
  });
  const notice = { eventId: 'restore-ended-notice', type: 'conflict', pr: PR, target };
  assert.equal(model.enqueueNotification(notice).accepted, true);
  assert.equal(model.markParentSessionEnded(parent), true);

  const snapshot = model.snapshot();
  assert.deepEqual(snapshot.endedParentSessions, [parent]);
  const restored = PrReviewModel.restore(snapshot);
  assert.ok(restored);
  assert.deepEqual(restored.project().endedParentSessions, [parent]);
  assert.equal(restored.lifecycle(target).parentState, 'ended');
  assert.equal(restored.lifecycle(sibling).parentState, 'ended');
  assert.equal(restored.setParentState(target, 'running'), false);
  assert.equal(restored.setExecutionState(target, 'running'), false);
  assert.equal(restored.registerExecution({
    ...identity('post-restore-child'), origin: 'independent', purpose: 'work',
    parent: { ...parent, agentId: 'new-agent', toolUseId: 'new-tool' }, configuration: CONFIG_A,
  }), null);
  assert.equal(restored.notificationHandoff(notice), false);
  assert.equal(restored.receiveResult(target, RESULT), true);
  assert.equal(restored.confirmChildEnded(target), true);
  assert.equal(restored.returnResult(target), false);
  assert.equal(restored.lifecycle(target).successfulReturn, false);

  const legacySnapshot = JSON.parse(JSON.stringify(snapshot));
  delete legacySnapshot.endedParentSessions;
  const legacyRestored = PrReviewModel.restore(legacySnapshot);
  assert.ok(legacyRestored);
  assert.equal(legacyRestored.lifecycle(target).parentState, 'ended');
  assert.equal(legacyRestored.setParentState(target, 'running'), false);
  assert.equal(legacyRestored.registerExecution({
    ...identity('legacy-post-restore-child'), origin: 'independent', purpose: 'work',
    parent: { ...parent, agentId: 'new-agent', toolUseId: 'new-tool' }, configuration: CONFIG_A,
  }), null);
});

test('routing changes apply to the next matching provider and each attempt keeps its launch configuration', () => {
  const model = newModel();
  const first = addRun(model, 'fixed-before-change');
  assert.equal(model.updateRouting(CONFIG_B), true);
  const second = addRun(model, 'fixed-after-change');
  const external = addRun(model, 'external-provider', { provider: 'external' });

  const rows = model.project().executions;
  assert.deepEqual(rows.find((row) => execKey(row.identity) === execKey(first)).routing, CONFIG_A);
  assert.deepEqual(rows.find((row) => execKey(row.identity) === execKey(second)).routing, CONFIG_B);
  assert.equal(second.provider, 'claude');
  assert.equal(rows.find((row) => execKey(row.identity) === execKey(external)).routing.vendor, 'external');
  assert.equal(model.registerExecution({
    ...identity('provider-vendor-mismatch'), origin: 'independent', purpose: 'work', configuration: CONFIG_B,
  }), null);
  assert.equal(model.updateRouting({ vendor: 'claude' }), false);
});

test('review purpose is fixed at registration and review rounds share the one canonical execution row', () => {
  const model = newModel();
  const ordinary = addRun(model, 'ordinary');
  addPr(model);
  assert.equal(model.startReview({ pr: PR, branch: 'feature', run: ordinary, round: 1, roundId: 'wrong' }), null);

  const reviewer = addRun(model, 'review-actual', { purpose: 'review' });
  assert.ok(model.startReview({ pr: PR, branch: 'feature', run: reviewer, round: 1, roundId: 'r1' }));
  assert.equal(model.concludeReview({
    pr: PR, branch: 'feature', run: reviewer, round: 1, roundId: 'r1',
    reviewedHead: HEAD_A, convergenceHead: HEAD_A, conclusion: 'success',
  }), true);
  assert.equal(model.project().executions.length, 2);
  assert.equal(model.project().reviewRounds.length, 1);
});

test('older successful round at the same head is invalidated by a newer unreviewed round', async () => {
  const model = newModel();
  addPr(model);
  setPrState(model, HEAD_A);
  addReview(model, { round: 1, roundId: 'old', reviewedHead: HEAD_A });
  assert.equal(model.reserveMerge({ pr: PR, branch: 'feature', defaultBranch: 'main', screenHead: HEAD_A }).accepted, true);

  const current = addReview(model, { round: 2, roundId: 'new', conclude: false });
  assert.equal(model.reserveMerge({ pr: PR, branch: 'feature', defaultBranch: 'main', screenHead: HEAD_A }).reason,
    'reservation_exists');
  const gh = fakeGh('MERGED', 'merge');
  const attempt = await model.attemptMerge({
    pr: PR, branch: 'feature', defaultBranch: 'main', mode: 'review_reservation',
  }, gh);
  assert.equal(attempt.reason, 'latest_round_unfinished');
  assert.equal(gh.calls.length, 0);

  assert.equal(model.concludeReview({
    pr: PR, branch: 'feature', run: current.run, round: current.round, roundId: current.roundId,
    reviewedHead: HEAD_A, convergenceHead: HEAD_A, conclusion: 'success',
  }), true);
  assert.equal((await model.attemptMerge({
    pr: PR, branch: 'feature', defaultBranch: 'main', mode: 'review_reservation',
  }, gh)).reason, 'merged');
  assert.equal(gh.calls[0].expectedHead, HEAD_A);
});

test('a new head may merge after a new latest round concludes successfully on that head', async () => {
  const model = newModel();
  const reporter = addRun(model, 'new-head-reporter');
  addPr(model, { createdBy: reporter });
  setPrState(model, HEAD_A);
  addReview(model, { round: 1, roundId: 'old', reviewedHead: HEAD_A });
  assert.equal(model.reserveMerge({ pr: PR, branch: 'feature', defaultBranch: 'main', screenHead: HEAD_A }).accepted, true);

  const newRound = addReview(model, { round: 2, roundId: 'new-head', conclude: false });
  setPrState(model, HEAD_B);
  const blockedGh = fakeGh('MERGED', 'merge');
  assert.equal((await model.attemptMerge({
    pr: PR, branch: 'feature', defaultBranch: 'main', mode: 'review_reservation',
  }, blockedGh)).reason, 'latest_round_unfinished');
  assert.equal(blockedGh.calls.length, 0);
  assert.equal(model.concludeReview({
    pr: PR, branch: 'feature', run: newRound.run, round: newRound.round, roundId: newRound.roundId,
    reviewedHead: HEAD_B, convergenceHead: HEAD_B, conclusion: 'success',
  }), true);
  const gh = fakeGh('MERGED', 'rebase');
  const merged = await model.attemptMerge({
    pr: PR, branch: 'feature', defaultBranch: 'main', mode: 'review_reservation',
  }, gh);
  assert.equal(merged.reason, 'merged');
  assert.equal(gh.calls[0].expectedHead, HEAD_B);
  assert.deepEqual(model.project().notifications.map((row) => row.type), ['merge']);
  assert.equal(newRound.round, 2);
});

test('not_required, a stale convergence head, and another branch cannot support reserved merge', async () => {
  const model = newModel();
  addPr(model);
  setPrState(model, HEAD_A);
  addReview(model, { round: 1, roundId: 'not-required', conclusion: 'not_required' });
  assert.equal(model.reserveMerge({ pr: PR, branch: 'feature', defaultBranch: 'main', screenHead: HEAD_A }).accepted, true);
  assert.equal((await model.attemptMerge({
    pr: PR, branch: 'feature', defaultBranch: 'main', mode: 'review_reservation',
  }, fakeGh('MERGED', 'merge'))).reason, 'latest_round_not_successful');

  const otherBranchRun = addRun(model, 'other-branch-review', { purpose: 'review' });
  assert.ok(model.startReview({
    pr: PR, branch: 'other-feature', run: otherBranchRun, round: 1, roundId: 'other',
  }));
  assert.equal(model.concludeReview({
    pr: PR, branch: 'other-feature', run: otherBranchRun, round: 1, roundId: 'other',
    reviewedHead: HEAD_B, convergenceHead: HEAD_B, conclusion: 'success',
  }), true);
  assert.equal(model.reserveMerge({ pr: PR, branch: 'other-feature', defaultBranch: 'main', screenHead: HEAD_A }).accepted, true);
  assert.equal((await model.attemptMerge({
    pr: PR, branch: 'other-feature', defaultBranch: 'main', mode: 'review_reservation',
  }, fakeGh('MERGED', 'merge'))).reason, 'head_not_converged');
});

test('manual screen SHA and reserved convergence SHA are independent freshness checks', async () => {
  const model = newModel();
  addPr(model);
  setPrState(model, HEAD_A);
  const stale = fakeGh('MERGED', 'merge');
  assert.equal((await model.attemptMerge({
    pr: PR, defaultBranch: 'main', mode: 'manual', screenHead: HEAD_B,
  }, stale)).reason, 'screen_head_stale');
  assert.equal(stale.calls.length, 0);

  const current = fakeGh('MERGED', 'merge');
  const merged = await model.attemptMerge({
    pr: PR, defaultBranch: 'main', mode: 'manual', screenHead: HEAD_A,
  }, current);
  assert.equal(merged.reason, 'merged');
  assert.equal(current.calls[0].expectedHead, HEAD_A);
});

test('merge is blocked before the fixture gh boundary unless this is the bottom PR', async () => {
  const model = newModel();
  addPr(model);
  setPrState(model, HEAD_A, 'feature-base');
  const gh = fakeGh('MERGED', 'merge');
  assert.equal((await model.attemptMerge({
    pr: PR, defaultBranch: 'main', mode: 'manual', screenHead: HEAD_A,
  }, gh)).reason, 'not_lowest_pr');
  assert.equal(model.reserveMerge({ pr: PR, branch: 'feature', defaultBranch: 'main', screenHead: HEAD_A }).reason, 'not_lowest_pr');
  assert.equal(gh.calls.length, 0);
});

test('merge reservations can be cancelled and cancellation prevents fake gh calls', async () => {
  const model = newModel();
  addPr(model);
  setPrState(model, HEAD_A);
  addReview(model, { round: 1, roundId: 'successful', reviewedHead: HEAD_A });
  assert.equal(model.reserveMerge({ pr: PR, branch: 'feature', defaultBranch: 'main', screenHead: HEAD_A }).accepted, true);
  assert.equal(model.cancelMerge({ pr: PR, branch: 'feature' }), true);
  const gh = fakeGh('MERGED', 'merge');
  assert.equal((await model.attemptMerge({
    pr: PR, branch: 'feature', defaultBranch: 'main', mode: 'review_reservation',
  }, gh)).reason, 'reservation_missing');
  assert.equal(gh.calls.length, 0);
});

test('fake gh maps OPEN to queued, read failure to unknown, conflict to conflict, and MERGED to completion', async () => {
  const cases = [
    ['OPEN', undefined, 'merge_queued', 'queue', 'queued'],
    ['READ_FAILED', undefined, 'merge_unknown', 'merge', 'unknown'],
    ['CONFLICT', undefined, 'merge_conflict', 'conflict', 'conflict'],
    ['MERGED', 'merge', 'merged', 'merge', 'merged'],
  ];
  for (const [status, method, expected, eventType, state] of cases) {
    const model = newModel();
    const reporter = addRun(model, 'merge-reporter-' + status);
    addPr(model, { createdBy: reporter });
    setPrState(model, HEAD_A);
    const gh = fakeGh(status, method);
    const actual = await model.attemptMerge({
      pr: PR, defaultBranch: 'main', mode: 'manual', screenHead: HEAD_A,
    }, gh);
    assert.equal(actual.reason, expected);
    assert.equal(gh.calls.length, 1);
    assert.ok(model.project().notifications.some((row) => row.type === eventType));
    assert.equal(model.project().pullRequests[0].mergeState, state);
  }
});

test('squash and rebase notify a registered stacked PR; unknown merge method never guesses', async () => {
  for (const method of ['squash', 'rebase', 'merge', undefined]) {
    const model = newModel();
    addPr(model);
    const stackedPr = { owner: PR.owner, repo: PR.repo, number: 165 };
    const stackedOwner = addRun(model, 'stacked-owner-' + String(method));
    model.registerPr({ ...stackedPr, source: 'claude_mcp', createdBy: stackedOwner });
    assert.equal(model.registerStackedPr({ lowerPr: PR, stackedPr }), true);
    setPrState(model, HEAD_A);
    await model.attemptMerge({
      pr: PR, defaultBranch: 'main', mode: 'manual', screenHead: HEAD_A,
    }, fakeGh('MERGED', method));
    const restacks = model.project().notifications.filter((row) => row.type === 'restack');
    assert.equal(restacks.length, method === 'squash' || method === 'rebase' ? 1 : 0);
    if (restacks.length) {
      assert.equal(restacks[0].payload.method, method);
      assert.deepEqual(restacks[0].pr, { owner: PR.owner.toLowerCase(), repo: PR.repo.toLowerCase(), number: 165 });
      assert.deepEqual(restacks[0].target, stackedOwner);
    }
  }
});

test('notification identity is event ID plus canonical target attempt; conflicts and duplicate routes are explicit', () => {
  const model = newModel();
  const shared = addRun(model, 'notify-shared');
  const nextAttempt = {
    ...shared,
    attemptId: 'attempt-next',
  };
  assert.ok(model.registerExecution({
    ...nextAttempt, origin: 'independent', purpose: 'work',
  }));
  addPr(model, { source: 'claude_mcp', createdBy: shared, registeredBy: shared });
  addPr(model, { source: 'independent_codex_gh', createdBy: shared, registeredBy: shared });
  assert.equal(model.project().pullRequests[0].notificationTargets.length, 1);
  assert.equal(model.notifyPr(PR, { eventId: 'same-run-origin-event', type: 'merge', payload: { status: 'merged' } }).length, 1);

  const event = { eventId: 'merge-event-1', type: 'merge', pr: PR, target: shared, payload: { status: 'merged' } };
  assert.equal(model.enqueueNotification(event).reason, 'queued');
  assert.equal(model.enqueueNotification({ ...event, source: shared }).reason, 'duplicate');
  assert.equal(model.enqueueNotification({ ...event, payload: { status: 'conflict' } }).reason, 'event_id_conflict');
  assert.equal(model.enqueueNotification({ ...event, target: nextAttempt }).reason, 'queued');
  assert.equal(model.project().notifications.length, 3);
});

test('notification handoff, ack, unknown and restore never automatically resend an event', () => {
  const model = newModel();
  const target = addRun(model, 'notify-target');
  const event = {
    eventId: 'merge-event-2', type: 'merge', pr: PR, target, payload: { status: 'merged' },
  };
  assert.equal(model.enqueueNotification(event).reason, 'queued');
  assert.equal(model.notificationHandoff(event), true);
  assert.equal(model.acknowledgeNotification(event), true);
  assert.equal(model.notificationHandoff(event), false);
  assert.equal(model.enqueueNotification(event).reason, 'duplicate');
  assert.equal(notification(model, event.eventId, target).state, 'acknowledged');

  const lost = { ...event, eventId: 'merge-event-lost' };
  assert.equal(model.enqueueNotification(lost).reason, 'queued');
  assert.equal(model.notificationHandoff(lost), true);
  assert.equal(model.markNotificationUnknown(lost), true);
  const restored = PrReviewModel.restore(model.snapshot());
  assert.ok(restored);
  assert.equal(notification(restored, lost.eventId, target).state, 'unknown');
  assert.equal(restored.enqueueNotification(lost).reason, 'duplicate');
  assert.equal(restored.notificationHandoff(lost), false);
  assert.equal(restored.acknowledgeNotification(lost), false);

  const handed = { ...event, eventId: 'handed-at-restart' };
  assert.equal(model.enqueueNotification(handed).reason, 'queued');
  assert.equal(model.notificationHandoff(handed), true);
  const afterRestart = PrReviewModel.restore(model.snapshot());
  assert.equal(notification(afterRestart, handed.eventId, target).state, 'unknown');
  assert.equal(afterRestart.notificationHandoff(handed), false);
  assert.equal(afterRestart.enqueueNotification(handed).reason, 'duplicate');

  const queued = { ...event, eventId: 'queued-at-restart' };
  assert.equal(model.enqueueNotification(queued).reason, 'queued');
  const queuedRestore = PrReviewModel.restore(model.snapshot());
  assert.equal(notification(queuedRestore, queued.eventId, target).state, 'queued');
  assert.equal(queuedRestore.notificationHandoff(queued), false);
  assert.equal(queuedRestore.setExecutionState(target, 'running'), true);
  assert.equal(queuedRestore.notificationHandoff(queued), true);
});

test('an exit rejects a first late result but accepts only the identical earlier result again', () => {
  const model = newModel();
  const known = addRun(model, 'known-result');
  assert.equal(model.receiveResult(known, RESULT), true);
  assert.equal(model.receiveResult(known, RESULT), true);
  assert.equal(model.confirmChildEnded(known), true);
  assert.equal(model.receiveResult(known, { resultId: RESULT.resultId, resultDigest: RESULT.resultDigest.toUpperCase() }), true);
  assert.equal(model.receiveResult(known, {
    resultId: 'different-result', resultDigest: HEAD_B,
  }), false);
  const restored = PrReviewModel.restore(model.snapshot());
  assert.ok(restored);
  assert.equal(restored.receiveResult(known, {
    resultId: RESULT.resultId, resultDigest: RESULT.resultDigest.toUpperCase(),
  }), true);

  const late = addRun(model, 'late-result');
  assert.equal(model.confirmChildEnded(late), true);
  assert.equal(model.receiveResult(late, RESULT), false);
  assert.equal(model.lifecycle(late).resultReceived, false);
});

test('cancel confirmation requires explicit child-exit evidence and remains separate from the request', () => {
  const model = newModel();
  const run = addRun(model, 'cancel-evidence', {
    origin: 'delegated',
    parent: { provider: 'claude', sessionId: 'cancel-session', agentId: 'cancel-agent', toolUseId: 'cancel-tool' },
  });
  assert.equal(model.requestCancel(run), true);
  assert.equal(model.confirmCancel(run), false);
  assert.equal(model.lifecycle(run).cancelState, 'requested');
  assert.equal(model.lifecycle(run).childEnded, false);
  assert.equal(model.confirmChildEnded(run), true);
  assert.equal(model.lifecycle(run).cancelState, 'requested');
  assert.equal(model.confirmCancel(run), true);
  assert.equal(model.lifecycle(run).cancelState, 'confirmed');
  assert.equal(model.lifecycle(run).childEnded, true);
});

test('result receipt, child close, parent return, parent state, and cancellation remain separate facts', () => {
  const model = newModel();
  const run = addRun(model, 'lifecycle', {
    origin: 'delegated',
    parent: { provider: 'claude', sessionId: 'session', agentId: 'agent', toolUseId: 'tool' },
  });
  assert.equal(model.receiveResult(run, RESULT), true);
  assert.equal(model.lifecycle(run).successfulReturn, false);
  assert.equal(model.returnResult(run), false);
  assert.equal(model.confirmChildEnded(run), true);
  assert.equal(model.returnResult(run), true);
  assert.equal(model.lifecycle(run).successfulReturn, true);

  const stopped = addRun(model, 'stopped', {
    origin: 'delegated',
    parent: { provider: 'claude', sessionId: 'session-2', agentId: 'agent-2', toolUseId: 'tool-2' },
  });
  assert.equal(model.setParentState(stopped, 'stopped'), true);
  assert.equal(model.receiveResult(stopped, RESULT), true);
  assert.equal(model.confirmChildEnded(stopped), true);
  assert.equal(model.returnResult(stopped), false);

  const ended = addRun(model, 'ended-parent', {
    origin: 'delegated',
    parent: { provider: 'claude', sessionId: 'session-3', agentId: 'agent-3', toolUseId: 'tool-3' },
  });
  assert.equal(model.requestCancel(ended), true);
  assert.equal(model.lifecycle(ended).cancelState, 'requested');
  assert.equal(model.receiveResult(ended, RESULT), true);
  assert.equal(model.confirmChildEnded(ended), true);
  assert.equal(model.returnResult(ended), false);
  assert.equal(model.confirmCancel(ended), true);
  assert.equal(model.lifecycle(ended).cancelState, 'confirmed');
  assert.equal(model.lifecycle(ended).childEnded, true);
  assert.equal(model.setParentState(ended, 'ended'), true);
  assert.equal(model.receiveResult(ended, RESULT), true);
  assert.equal(model.confirmChildEnded(ended), true);
  assert.equal(model.returnResult(ended), false);
  assert.equal(model.lifecycle(ended).successfulReturn, false);

  const cancelOnly = addRun(model, 'cancel-confirm-only', {
    origin: 'delegated',
    parent: { provider: 'claude', sessionId: 'session-4', agentId: 'agent-4', toolUseId: 'tool-4' },
  });
  assert.equal(model.requestCancel(cancelOnly), true);
  assert.equal(model.confirmCancel(cancelOnly), false);
  assert.equal(model.lifecycle(cancelOnly).cancelState, 'requested');
  assert.equal(model.lifecycle(cancelOnly).childEnded, false);
  assert.equal(model.confirmChildEnded(cancelOnly), true);
  assert.equal(model.lifecycle(cancelOnly).cancelState, 'requested');
  assert.equal(model.confirmCancel(cancelOnly), true);
  assert.equal(model.lifecycle(cancelOnly).childEnded, true);
});

test('only an explicitly marked fixture adapter can be called as the merge boundary', async () => {
  const model = newModel();
  addPr(model);
  setPrState(model, HEAD_A);
  const plain = { merge() { throw new Error('must not call'); } };
  const output = await model.attemptMerge({
    pr: PR, defaultBranch: 'main', mode: 'manual', screenHead: HEAD_A,
  }, plain);
  assert.equal(output.reason, 'fixture_gh_required');
});

test('ended parent and execution states survive restore and cannot be resumed', () => {
  const model = newModel();
  const target = addRun(model, 'terminal-after-restart', {
    origin: 'delegated',
    parent: { provider: 'claude', sessionId: 'terminal-session', agentId: 'terminal-agent', toolUseId: 'terminal-tool' },
  });
  const event = { eventId: 'terminal-restart-event', type: 'merge', pr: PR, target };
  assert.equal(model.enqueueNotification(event).accepted, true);
  assert.equal(model.setParentState(target, 'ended'), true);
  assert.equal(model.setExecutionState(target, 'ended'), true);
  const restored = PrReviewModel.restore(model.snapshot());
  assert.ok(restored);
  const restoredAgain = PrReviewModel.restore(restored.snapshot());
  assert.ok(restoredAgain);
  assert.deepEqual(restoredAgain.lifecycle(target), {
    parentState: 'ended',
    runState: 'ended',
    childEnded: false,
    resultReceived: false,
    parentReturned: false,
    cancelState: 'none',
    successfulReturn: false,
  });
  assert.equal(restoredAgain.setParentState(target, 'running'), false);
  assert.equal(restoredAgain.setExecutionState(target, 'running'), false);
  assert.equal(restoredAgain.notificationHandoff(event), false);
});

test('unknown liveness can be snapshotted and restored repeatedly until explicitly refreshed', () => {
  const model = newModel();
  const target = addRun(model, 'unknown-liveness', {
    origin: 'delegated',
    parent: { provider: 'claude', sessionId: 'unknown-session', agentId: 'unknown-agent', toolUseId: 'unknown-tool' },
  });
  const event = { eventId: 'unknown-liveness-event', type: 'queue', pr: PR, target };
  assert.equal(model.enqueueNotification(event).accepted, true);

  const first = PrReviewModel.restore(model.snapshot());
  assert.ok(first);
  assert.equal(first.lifecycle(target).parentState, 'unknown');
  assert.equal(first.lifecycle(target).runState, 'unknown');
  assert.equal(first.notificationHandoff(event), false);

  const second = PrReviewModel.restore(first.snapshot());
  assert.ok(second);
  assert.equal(second.lifecycle(target).parentState, 'unknown');
  assert.equal(second.lifecycle(target).runState, 'unknown');
  assert.equal(second.notificationHandoff(event), false);
  assert.equal(second.setExecutionState(target, 'running'), true);
  assert.equal(second.notificationHandoff(event), false);
  assert.equal(second.setParentState(target, 'running'), true);
  assert.equal(second.notificationHandoff(event), true);
});

test('snapshot is labelled as fixture state and rejects malformed restoration', () => {
  const model = newModel();
  addRun(model, 'snapshot-run');
  const snapshot = model.snapshot();
  assert.equal(snapshot.schema, CONTRACT.schema);
  assert.equal(PrReviewModel.restore(snapshot).project().executions.length, 1);
  assert.equal(PrReviewModel.restore({ ...snapshot, schema: 'other' }), null);
});
