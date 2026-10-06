'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DelegationIdentityModel } = require('./identity-model');

const NONCE_A = 'a'.repeat(64);
const NONCE_B = 'b'.repeat(64);
const PARENT_A = { provider: 'claude-code', sessionId: 'session-A', agentId: 'agent-A' };
const PARENT_B = { provider: 'claude-code', sessionId: 'session-A', toolUseId: 'tool-B' };

function createModel() {
  let nextId = 0;
  return new DelegationIdentityModel({ randomId: () => `launch-${++nextId}` });
}

function register(model, options = {}) {
  const input = {
    launchId: options.launchId || 'launch-one',
    runId: options.runId || 'run-one',
    attemptId: options.attemptId || 'attempt-one',
    origin: options.origin || 'delegated',
    hostId: options.hostId || 'host-one',
    homeScope: options.homeScope || 'scope-one',
    parent: options.origin === 'standalone' ? undefined : (options.parent || PARENT_A),
    bindingNonce: options.bindingNonce || NONCE_A,
  };
  const safe = model.registerLaunch(input);
  return { input, safe };
}

function bind(model, launch, options = {}) {
  return model.bindNative({
    launchId: launch.launchId,
    runId: launch.runId,
    attemptId: launch.attemptId,
    bindingNonce: options.bindingNonce || NONCE_A,
    hostId: options.hostId || launch.hostId,
    homeScope: options.homeScope || launch.homeScope,
    threadId: options.threadId || 'thread-one',
  });
}

function nativeEvent(options = {}) {
  return {
    eventId: options.eventId || 'native-event-one',
    hostId: options.hostId || 'host-one',
    homeScope: options.homeScope || 'scope-one',
    threadId: options.threadId || 'thread-one',
    type: options.type || 'thread.started',
    ...(options.status ? { status: options.status } : {}),
    ...(options.launchId ? {
      launchId: options.launchId,
      runId: options.runId,
      attemptId: options.attemptId,
    } : {}),
  };
}

function auditEvent(options = {}) {
  return {
    eventId: options.eventId || 'audit-event-one',
    runId: options.runId || 'run-one',
    attemptId: options.attemptId || 'attempt-one',
    kind: options.kind || 'run_started',
    ...(options.launchId ? { launchId: options.launchId } : {}),
    ...(options.status ? { status: options.status } : {}),
    ...(options.generation === undefined ? {} : { generation: options.generation }),
    ...(options.parent ? { parent: options.parent } : {}),
    ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
  };
}

function rowFor(model, predicate) {
  const row = model.project().rows.find(predicate);
  assert.ok(row, 'expected projection row');
  return row;
}

test('registerLaunch requires an opaque binding nonce and valid delegated parent identity', () => {
  const model = createModel();
  assert.equal(model.registerLaunch({
    launchId: 'bad-parent', runId: 'run', attemptId: 'attempt', origin: 'delegated',
    hostId: 'host', homeScope: 'scope', parent: { provider: 'claude-code', sessionId: 's' },
    bindingNonce: NONCE_A,
  }), null);
  assert.equal(model.registerLaunch({
    launchId: 'credential', runId: 'token:secret', attemptId: 'attempt', origin: 'standalone',
    hostId: 'host', homeScope: 'scope', bindingNonce: NONCE_A,
  }), null);
  const { safe } = register(model);
  assert.deepEqual(safe.parent, PARENT_A);
  assert.equal(Object.hasOwn(safe, 'bindingNonce'), false);
  assert.equal(JSON.stringify(safe).includes(NONCE_A), false);
});

test('exact launch registration is idempotent and conflicting reuse is rejected', () => {
  const model = createModel();
  const { input, safe } = register(model);
  assert.deepEqual(model.registerLaunch(input), safe);
  assert.equal(model.registerLaunch({ ...input, bindingNonce: NONCE_B }), null);
  assert.equal(model.registerLaunch({ ...input, parent: PARENT_B }), null);
  assert.equal(model.registerLaunch({ ...input, attemptId: 'attempt-two' }), null);
  assert.equal(model.registerLaunch({ ...input, launchId: 'launch-two' }), null);
});

test('two registered standalone and two delegated tasks project and route separately', () => {
  const model = createModel();
  const launches = [];
  for (let index = 1; index <= 4; index += 1) {
    const origin = index <= 2 ? 'standalone' : 'delegated';
    const { safe } = register(model, {
      launchId: `launch-${index}`,
      runId: `run-${index}`,
      attemptId: `attempt-${index}`,
      origin,
      parent: index === 3 ? PARENT_A : PARENT_B,
      bindingNonce: index % 2 ? NONCE_A : NONCE_B,
    });
    assert.ok(safe);
    assert.equal(bind(model, safe, {
      bindingNonce: index % 2 ? NONCE_A : NONCE_B,
      threadId: `thread-${index}`,
    }), true);
    launches.push(safe);
  }

  const projection = model.project();
  assert.deepEqual({
    independent: projection.counts.independent,
    confirmed: projection.counts.confirmed_delegated,
  }, { independent: 2, confirmed: 2 });
  assert.equal(projection.rows.length, 4);
  const types = ['tasks', 'decision', 'pull_request'];
  for (let index = 1; index <= 4; index += 1) {
    const result = model.routeAnswer({
      hostId: 'host-one', homeScope: 'scope-one', threadId: `thread-${index}`,
      deliveryId: `delivery-${index}`, type: types[(index - 1) % types.length],
    });
    assert.equal(result.accepted, true);
    assert.equal(result.destination.launchId, `launch-${index}`);
  }
  assert.equal(JSON.stringify(projection).includes(NONCE_A), false);
  assert.equal(JSON.stringify(projection).includes(NONCE_B), false);
});

test('an unregistered or unbound native thread remains related_unknown and cannot receive answers', () => {
  const model = createModel();
  assert.equal(model.ingestNative(nativeEvent()), true);
  let row = rowFor(model, (candidate) => candidate.thread_id === 'thread-one');
  assert.equal(row.kind, 'related_unknown');
  assert.equal(row.origin, null);
  assert.equal(model.resolveMcpDestination({
    hostId: 'host-one', homeScope: 'scope-one', threadId: 'thread-one',
  }), null);
  assert.equal(model.routeAnswer({
    hostId: 'host-one', homeScope: 'scope-one', threadId: 'thread-one',
    deliveryId: 'unmatched-delivery', type: 'tasks',
  }).reason, 'unknown_destination');

  const { safe } = register(model, { launchId: 'candidate-launch' });
  assert.equal(model.ingestNative(nativeEvent({
    eventId: 'correlated-event', launchId: safe.launchId, runId: safe.runId,
    attemptId: safe.attemptId,
  })), true);
  row = rowFor(model, (candidate) => candidate.thread_id === 'thread-one');
  assert.equal(row.kind, 'related_unknown');
  assert.equal(row.parent, null);
  assert.equal(model.resolveMcpDestination({
    hostId: 'host-one', homeScope: 'scope-one', threadId: 'thread-one',
  }), null);
  assert.equal(bind(model, safe), true);
  assert.equal(rowFor(model, (candidate) => candidate.thread_id === 'thread-one').kind, 'confirmed_delegated');
});

test('native binding requires exact nonce, host, home scope, and one-to-one thread ownership', () => {
  const model = createModel();
  const { safe } = register(model);
  assert.equal(bind(model, safe, { bindingNonce: NONCE_B }), false);
  assert.equal(bind(model, safe, { hostId: 'other-host' }), false);
  assert.equal(bind(model, safe, { homeScope: 'other-scope' }), false);
  assert.equal(bind(model, safe), true);
  assert.equal(bind(model, safe), true);

  const second = register(model, {
    launchId: 'launch-two', runId: 'run-two', attemptId: 'attempt-two',
  }).safe;
  assert.equal(bind(model, second), false);
  assert.equal(model.project().counts.confirmed_delegated, 1);
});

test('native event IDs are idempotent per native scope and do not collide across colon-bearing keys', () => {
  const model = createModel();
  assert.equal(model.ingestNative({
    ...nativeEvent({ eventId: 'safe' }), notificationId: 'notification-safe', eventId: 'token:secret',
  }), false);
  assert.equal(model.ingestNative({
    ...nativeEvent({ eventId: 'safe' }), eventId: 'event-safe', notificationId: 'secret:value',
  }), false);
  assert.equal(model.ingestNative(nativeEvent({ eventId: 'shared' })), true);
  assert.equal(model.ingestNative(nativeEvent({ eventId: 'shared' })), true);
  assert.equal(rowFor(model, (row) => row.thread_id === 'thread-one').native.event_count, 1);
  assert.equal(model.ingestNative(nativeEvent({ eventId: 'shared', type: 'thread.closed' })), false);

  assert.equal(model.ingestNative(nativeEvent({
    eventId: 'shared', hostId: 'host:scope', homeScope: 'home', threadId: 'thread-two',
  })), true);
  assert.equal(model.ingestNative(nativeEvent({
    eventId: 'shared', hostId: 'host', homeScope: 'scope:home', threadId: 'thread-two',
  })), true);
  assert.equal(model.project().counts.related_unknown, 3);
});

test('audit event IDs are scoped to run and attempt tuples without delimiter collisions', () => {
  const model = createModel();
  assert.equal(model.ingestAudit({
    ...auditEvent({ eventId: 'safe' }), notificationId: 'notification-safe', eventId: 'token:secret',
  }), false);
  assert.equal(model.ingestAudit({
    ...auditEvent({ eventId: 'safe' }), eventId: 'event-safe', notificationId: 'secret:value',
  }), false);
  const left = { runId: 'run:part', attemptId: 'attempt', eventId: 'shared', kind: 'run_started' };
  const right = { runId: 'run', attemptId: 'part:attempt', eventId: 'shared', kind: 'run_started' };
  assert.equal(model.ingestAudit(left), true);
  assert.equal(model.ingestAudit(left), true);
  assert.equal(model.ingestAudit(right), true);
  assert.equal(model.project().counts.audit_only, 2);
  assert.equal(model.project().counts.running, 2);
  assert.equal(model.ingestAudit({ ...left, kind: 'wait', status: 'waiting' }), false);
});

test('run-only audit data is not attached to a registered launch', () => {
  const model = createModel();
  const { safe } = register(model);
  assert.equal(model.ingestAudit(auditEvent({ runId: safe.runId, attemptId: safe.attemptId })), true);
  const launchRow = rowFor(model, (row) => row.launch_id === safe.launchId);
  const auditRow = rowFor(model, (row) => row.kind === 'audit_only');
  assert.equal(launchRow.execution_status, 'registered');
  assert.equal(launchRow.audit.event_count, 0);
  assert.equal(auditRow.execution_status, 'running');
});

test('native and audit ingestors reject non-record inputs without changing model state', () => {
  const model = createModel();
  const before = model.project();
  for (const input of [null, undefined, [], 'event', 7]) {
    assert.equal(model.ingestNative(input), false);
    assert.equal(model.ingestAudit(input), false);
  }
  assert.deepEqual(model.project(), before);
});

test('pre-registration result audit joins its native candidate once and resists a delayed start', () => {
  const model = createModel();
  const launchInput = {
    launchId: 'launch-delayed', runId: 'run-delayed', attemptId: 'attempt-delayed',
    origin: 'delegated', hostId: 'host-one', homeScope: 'scope-one',
    parent: PARENT_A, bindingNonce: NONCE_A,
  };

  assert.equal(model.ingestAudit(auditEvent({
    eventId: 'early-start', launchId: launchInput.launchId, runId: launchInput.runId,
    attemptId: launchInput.attemptId, kind: 'run_started',
  })), true);
  assert.equal(model.ingestAudit(auditEvent({
    eventId: 'early-result', launchId: launchInput.launchId, runId: launchInput.runId,
    attemptId: launchInput.attemptId, kind: 'result', status: 'ok',
  })), true);
  assert.equal(model.project().counts.audit_only, 1);

  assert.equal(model.ingestNative(nativeEvent({
    eventId: 'native-before-registration', threadId: 'thread-delayed',
    launchId: launchInput.launchId, runId: launchInput.runId, attemptId: launchInput.attemptId,
  })), true);
  assert.equal(model.project().counts.related_unknown, 1);

  const launch = model.registerLaunch(launchInput);
  assert.ok(launch);
  assert.equal(model.project().counts.audit_only, 1);
  assert.equal(model.bindNative({
    launchId: launch.launchId, runId: launch.runId, attemptId: launch.attemptId,
    bindingNonce: NONCE_A, hostId: launch.hostId, homeScope: launch.homeScope,
    threadId: 'thread-delayed',
  }), true);

  let projection = model.project();
  assert.equal(projection.rows.length, 1);
  assert.equal(projection.counts.audit_only, 0);
  assert.equal(projection.counts.confirmed_delegated, 1);
  assert.equal(projection.rows[0].execution_status, 'completed');
  assert.equal(projection.rows[0].audit.event_count, 2);

  assert.equal(model.ingestAudit(auditEvent({
    eventId: 'late-start', launchId: launch.launchId, runId: launch.runId,
    attemptId: launch.attemptId, kind: 'run_started',
  })), true);
  projection = model.project();
  assert.equal(projection.rows.length, 1);
  assert.equal(projection.rows[0].execution_status, 'completed');
  assert.equal(projection.rows[0].audit.event_count, 3);
});

test('Stop and native turn completion never terminalize a delegated execution', () => {
  const model = createModel();
  const { safe } = register(model);
  assert.equal(bind(model, safe), true);
  assert.equal(model.ingestNative(nativeEvent({ eventId: 'stop', type: 'Stop' })), true);
  assert.equal(model.ingestNative(nativeEvent({ eventId: 'turn', type: 'turn.completed', status: 'completed' })), true);
  assert.equal(rowFor(model, (row) => row.launch_id === safe.launchId).execution_status, 'registered');

  assert.equal(model.ingestAudit(auditEvent({ eventId: 'start', launchId: safe.launchId, kind: 'run_started' })), true);
  assert.equal(model.ingestAudit(auditEvent({ eventId: 'wait', launchId: safe.launchId, kind: 'wait', status: 'waiting' })), true);
  assert.equal(model.ingestAudit(auditEvent({ eventId: 'stop-audit', launchId: safe.launchId, kind: 'stop', status: 'Stop' })), true);
  assert.equal(rowFor(model, (row) => row.launch_id === safe.launchId).execution_status, 'waiting');
  assert.equal(model.project().counts.running, 0);

  assert.equal(model.ingestAudit(auditEvent({ eventId: 'result', launchId: safe.launchId, kind: 'result', status: 'ok' })), true);
  assert.equal(model.ingestAudit(auditEvent({ eventId: 'late-start', launchId: safe.launchId, kind: 'run_started' })), true);
  assert.equal(model.ingestAudit(auditEvent({ eventId: 'late-wait', launchId: safe.launchId, kind: 'wait', status: 'waiting' })), true);
  assert.equal(rowFor(model, (row) => row.launch_id === safe.launchId).execution_status, 'completed');
  assert.equal(model.routeAnswer({
    hostId: 'host-one', homeScope: 'scope-one', threadId: 'thread-one',
    deliveryId: 'late-delivery', type: 'decision',
  }).reason, 'terminal_execution');
});

test('unknown end may be refined by a result but cannot be revived by a late start', () => {
  const model = createModel();
  const { safe } = register(model, { origin: 'standalone' });
  assert.equal(bind(model, safe), true);
  assert.equal(model.ingestAudit(auditEvent({
    eventId: 'unknown-end', launchId: safe.launchId, kind: 'unknown_end', status: 'vanished',
  })), true);
  assert.equal(model.project().counts.unknown_end, 1);
  assert.equal(model.ingestAudit(auditEvent({ eventId: 'late-start', launchId: safe.launchId, kind: 'run_started' })), true);
  assert.equal(rowFor(model, (row) => row.launch_id === safe.launchId).execution_status, 'unknown_end');
  assert.equal(model.ingestAudit(auditEvent({ eventId: 'result', launchId: safe.launchId, kind: 'result', status: 'completed' })), true);
  assert.equal(rowFor(model, (row) => row.launch_id === safe.launchId).execution_status, 'completed');
});

test('the first confirmed result fixes its status and exit code for the attempt', () => {
  const model = createModel();
  const { safe } = register(model, { origin: 'standalone' });
  assert.equal(model.ingestAudit(auditEvent({
    eventId: 'first-result', launchId: safe.launchId, kind: 'result',
    status: 'completed', exitCode: 0,
  })), true);

  assert.equal(model.ingestAudit(auditEvent({
    eventId: 'conflicting-exit-code', launchId: safe.launchId, kind: 'result',
    status: 'completed', exitCode: 9,
  })), false);
  assert.equal(model.ingestAudit(auditEvent({
    eventId: 'conflicting-status', launchId: safe.launchId, kind: 'result',
    status: 'failed', exitCode: 1,
  })), false);
  assert.equal(model.ingestAudit(auditEvent({
    eventId: 'late-start', launchId: safe.launchId, kind: 'run_started',
  })), true);

  const stored = model.launches.get(safe.launchId);
  const row = rowFor(model, (candidate) => candidate.launch_id === safe.launchId);
  assert.equal(stored.resultStatus, 'completed');
  assert.equal(stored.resultExitCode, 0);
  assert.equal(row.execution_status, 'completed');
  assert.equal(row.audit.event_count, 2);
});

test('handoff generations prevent delayed ownership events from restoring an old parent', () => {
  const model = createModel();
  const { safe } = register(model);
  assert.equal(model.ingestAudit(auditEvent({
    eventId: 'handoff-two', launchId: safe.launchId, kind: 'handoff',
    generation: 2, parent: PARENT_B,
  })), true);
  assert.equal(model.ingestAudit(auditEvent({
    eventId: 'handoff-one', launchId: safe.launchId, kind: 'handoff',
    generation: 1, parent: PARENT_A,
  })), false);
  assert.deepEqual(rowFor(model, (row) => row.launch_id === safe.launchId).parent, PARENT_B);
});

test('retry attempts remain separate and a previous terminal attempt stays terminal', () => {
  const model = createModel();
  const first = register(model, { launchId: 'launch-first', runId: 'run-retry', attemptId: 'attempt-1' }).safe;
  assert.ok(first);
  assert.equal(bind(model, first, { threadId: 'thread-first' }), true);
  assert.equal(model.ingestAudit(auditEvent({
    eventId: 'result-first', launchId: first.launchId, runId: first.runId,
    attemptId: first.attemptId, kind: 'result', status: 'failed',
  })), true);

  const conflict = register(model, { launchId: 'launch-conflict', runId: 'run-retry', attemptId: 'attempt-1' }).safe;
  assert.equal(conflict, null);
  const retry = register(model, { launchId: 'launch-retry', runId: 'run-retry', attemptId: 'attempt-2' }).safe;
  assert.ok(retry);
  assert.equal(bind(model, retry, { threadId: 'thread-retry' }), true);
  assert.equal(rowFor(model, (row) => row.launch_id === first.launchId).execution_status, 'failed');
  assert.equal(rowFor(model, (row) => row.launch_id === retry.launchId).execution_status, 'registered');
});

test('standalone execution_end is terminal while waiting and unknown_end are not running', () => {
  const model = createModel();
  const waiting = register(model, {
    launchId: 'waiting-launch', runId: 'waiting-run', attemptId: 'waiting-attempt',
  }).safe;
  const standalone = register(model, {
    launchId: 'standalone-launch', runId: 'standalone-run', attemptId: 'standalone-attempt',
    origin: 'standalone',
  }).safe;
  assert.equal(bind(model, standalone, { threadId: 'standalone-thread' }), true);
  assert.equal(model.ingestAudit(auditEvent({
    eventId: 'wait', launchId: waiting.launchId, runId: waiting.runId,
    attemptId: waiting.attemptId, kind: 'wait', status: 'waiting',
  })), true);
  assert.equal(model.ingestAudit(auditEvent({
    eventId: 'exec-end', launchId: standalone.launchId, runId: standalone.runId,
    attemptId: standalone.attemptId, kind: 'execution_end', status: 'completed',
  })), true);
  assert.equal(model.project().counts.running, 0);
  assert.equal(rowFor(model, (row) => row.launch_id === waiting.launchId).execution_status, 'waiting');
  assert.equal(rowFor(model, (row) => row.launch_id === standalone.launchId).execution_status, 'completed');
});

test('unverified delegated wrapper exit stays unknown_end, not a confirmed result', () => {
  const model = createModel();
  const { safe } = register(model);
  assert.equal(model.ingestAudit(auditEvent({
    eventId: 'wrapper-exit', launchId: safe.launchId, kind: 'execution_end', status: 'failed',
  })), true);
  const row = rowFor(model, (candidate) => candidate.launch_id === safe.launchId);
  assert.equal(row.execution_status, 'unknown_end');
  assert.equal(model.project().counts.running, 0);
});

test('answer routing rejects invalid types, unknown targets, duplicate deliveries, and terminal tasks', () => {
  const model = createModel();
  const { safe } = register(model);
  assert.equal(bind(model, safe), true);
  const base = {
    hostId: 'host-one', homeScope: 'scope-one', threadId: 'thread-one',
    deliveryId: 'delivery-one', type: 'tasks',
  };
  assert.equal(model.routeAnswer({ ...base, type: 'command' }).reason, 'invalid_input');
  assert.equal(model.routeAnswer({ ...base, bindingNonce: `Bearer ${NONCE_A}` }).reason, 'invalid_input');
  assert.equal(model.routeAnswer(base).accepted, true);
  assert.equal(model.routeAnswer(base).reason, 'duplicate_delivery');
});
