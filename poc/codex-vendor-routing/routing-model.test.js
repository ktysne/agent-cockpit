'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { RoutingModel, TRUST_SCOPE } = require('./routing-model');
const { RoutingState, readRoutingSync } = require('../../src/server/routing');

const PARENT_CODEX = { provider: 'codex', sessionId: 'session-codex', toolUseId: 'tool-codex' };
const PARENT_CLAUDE = { provider: 'claude', sessionId: 'session-claude', agentId: 'agent-claude' };

function profiles(overrides = {}) {
  return {
    claude: {
      model: 'claude-sonnet-4', effort: 'high', transport: 'externalClaude',
      ...overrides.claude,
    },
    codex: {
      model: 'gpt-6.1-sol', effort: 'high', transport: 'nativeCodex',
      ...overrides.codex,
    },
  };
}

function reservation(overrides = {}) {
  return {
    launchId: 'launch-one',
    runId: 'run-one',
    attemptId: 'attempt-one',
    routeSnapshot: { agents: 'default', review: 'default' },
    profiles: profiles(),
    parent: PARENT_CODEX,
    depth: 1,
    ancestors: [],
    workspace: path.resolve('test-workspace'),
    ...overrides,
  };
}

function reserve(model, overrides = {}) {
  const result = model.reserveLaunch(reservation(overrides));
  assert.equal(result.accepted, true, result.reason);
  return result.launch;
}

function correlated(launch, overrides = {}) {
  return {
    launchId: launch.launchId,
    runId: launch.runId,
    attemptId: launch.attemptId,
    parent: launch.parent,
    ...overrides,
  };
}

function begin(model, launch) {
  return model.beginLaunch(correlated(launch));
}

function shellObservation(model, launch, overrides = {}) {
  return model.attachObservation({
    ...correlated(launch), source: 'shell', observationId: 'shell-observation-one', ...overrides,
  });
}

function nativeObservation(model, launch, overrides = {}) {
  return model.attachObservation({
    ...correlated(launch),
    source: 'native',
    observationId: 'native-observation-one',
    identity: { provider: 'codex', hostId: 'host-one', homeScope: 'home-one', threadId: 'thread-one' },
    ...overrides,
  });
}

function claudeObservation(model, launch, overrides = {}) {
  return model.attachObservation({
    ...correlated(launch),
    source: 'native',
    observationId: 'claude-session-observation-one',
    identity: { provider: 'claude', hostId: 'host-one', homeScope: 'home-one', sessionId: 'session-uuid-one' },
    ...overrides,
  });
}

function shellExit(model, launch, overrides = {}) {
  return model.recordExit({
    ...correlated(launch), source: 'shell', exitId: 'exit-one', status: 'exited', exitCode: 0, ...overrides,
  });
}

function result(model, launch, overrides = {}) {
  return model.recordResult({
    ...correlated(launch), resultId: 'result-one', classification: 'ok', ...overrides,
  });
}

function rowFor(model, launchId) {
  const row = model.project().rows.find((candidate) => candidate.launchId === launchId);
  assert.ok(row, `missing launch ${launchId}`);
  return row;
}

function assertNoSymlinkComponents(root, target, allowMissingLeaf = false) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('target must be a child of the expected root');
  }
  const rootStat = fsSync.lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('root must be a real directory');
  const parts = relative.split(path.sep);
  let current = resolvedRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fsSync.lstatSync(current);
    } catch (error) {
      if (allowMissingLeaf && index === parts.length - 1 && error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('target must not contain symlinks');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('parent component must be a directory');
  }
}

test('default resolves to the parent provider from a validated shared route snapshot', () => {
  const model = new RoutingModel();
  const codexLaunch = reserve(model);
  const claudeLaunch = reserve(model, {
    launchId: 'launch-claude-parent', runId: 'run-claude-parent', attemptId: 'attempt-claude-parent',
    parent: PARENT_CLAUDE,
  });

  assert.equal(codexLaunch.resolvedVendor, 'codex');
  assert.equal(codexLaunch.transport, 'nativeCodex');
  assert.equal(claudeLaunch.resolvedVendor, 'claude');
  assert.equal(claudeLaunch.transport, 'externalClaude');
  assert.deepEqual(codexLaunch.routeSnapshot, { agents: 'default', review: 'default' });
  assert.deepEqual(codexLaunch.permissions, { tools: 'none' });
});

test('an explicit route switch changes only a new reservation and cannot rewrite an existing launch', () => {
  const model = new RoutingModel();
  const firstInput = reservation();
  const first = model.reserveLaunch(firstInput).launch;
  const changed = model.reserveLaunch(reservation({
    routeSnapshot: { agents: 'claude', review: 'codex' },
  }));
  assert.equal(changed.accepted, false);
  assert.equal(changed.reason, 'launch_conflict');

  const next = reserve(model, {
    launchId: 'launch-next', runId: 'run-next', attemptId: 'attempt-next',
    routeSnapshot: { agents: 'claude', review: 'codex' },
  });
  assert.equal(first.resolvedVendor, 'codex');
  assert.equal(first.requestedProfile.model, 'gpt-6.1-sol');
  assert.equal(next.resolvedVendor, 'claude');
  assert.equal(next.requestedProfile.model, 'claude-sonnet-4');
  assert.equal(next.routeSnapshot.review, 'codex');
});

test('shared route, profile, parent, and workspace inputs use strict schemas', () => {
  const model = new RoutingModel();
  const invalid = [
    reservation({ routeSnapshot: { agents: 'default', review: 'default', extra: true } }),
    reservation({ routeSnapshot: { agents: 'default', review: 'invalid' } }),
    reservation({ profiles: { ...profiles(), extra: {} } }),
    reservation({ profiles: profiles({ codex: { extra: true } }) }),
    reservation({ parent: { ...PARENT_CODEX, sessionToken: 'secret' } }),
    reservation({ parent: { provider: 'codex', sessionId: 'session' } }),
    reservation({ workspace: 'relative/workspace' }),
    reservation({ workspace: `${path.resolve('..')}${path.sep}..${path.sep}outside-workspace` }),
    reservation({ role: 'unknown-role' }),
    reservation({ env: { CLAUDE_CODE_MESSAGING_TOKEN: 'never-pass' } }),
  ];

  for (const input of invalid) assert.equal(model.reserveLaunch(input).accepted, false);
  assert.equal(model.project().rows.length, 0);
});

test('transport is explicit and native Codex requires a Codex parent', () => {
  const model = new RoutingModel();
  const incompatible = model.reserveLaunch(reservation({
    routeSnapshot: { agents: 'codex', review: 'default' }, parent: PARENT_CLAUDE,
  }));
  assert.deepEqual(incompatible, { accepted: false, reason: 'incompatible_transport' });

  const bridge = reserve(model, {
    launchId: 'launch-bridge', runId: 'run-bridge', attemptId: 'attempt-bridge',
    routeSnapshot: { agents: 'codex', review: 'default' }, parent: PARENT_CLAUDE,
    profiles: profiles({ codex: { transport: 'bridgeBackend' } }),
  });
  assert.equal(bridge.resolvedVendor, 'codex');
  assert.equal(bridge.transport, 'bridgeBackend');

  const claudeFromCodex = reserve(model, {
    launchId: 'launch-claude', runId: 'run-claude', attemptId: 'attempt-claude',
    routeSnapshot: { agents: 'claude', review: 'default' },
    profiles: profiles({ claude: { transport: 'externalClaude' } }),
  });
  assert.equal(claudeFromCodex.transport, 'externalClaude');
});

test('reservation does not authorize a spawn and depth-one children cannot delegate again', () => {
  const model = new RoutingModel();
  const launch = reserve(model);
  assert.equal(rowFor(model, launch.launchId).launchStatus, 'reserved');
  assert.equal(shellObservation(model, launch).reason, 'start_not_authorized');
  assert.equal(begin(model, launch).reason, 'start_authorized');

  const tooDeep = model.reserveLaunch(reservation({
    launchId: 'launch-depth-two', runId: 'run-depth-two', attemptId: 'attempt-depth-two', depth: 2,
    ancestors: [{ launchId: launch.launchId, runId: launch.runId, attemptId: launch.attemptId }],
  }));
  assert.equal(tooDeep.accepted, false);
  assert.equal(tooDeep.reason, 'depth_limit');
});

test('an ancestor launch, run, or attempt identifier cannot be reused', () => {
  const model = new RoutingModel();
  for (const field of ['launchId', 'runId', 'attemptId']) {
    const ancestor = { launchId: 'ancestor-launch', runId: 'ancestor-run', attemptId: 'ancestor-attempt' };
    const input = reservation({
      launchId: field === 'launchId' ? ancestor.launchId : `child-${field}`,
      runId: field === 'runId' ? ancestor.runId : `child-run-${field}`,
      attemptId: field === 'attemptId' ? ancestor.attemptId : `child-attempt-${field}`,
      ancestors: [ancestor],
    });
    const result = model.reserveLaunch(input);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'ancestor_cycle');
  }
});

test('exact reservations are idempotent while changed launch facts and repeated attempts are rejected', () => {
  const model = new RoutingModel();
  const input = reservation();
  const first = model.reserveLaunch(input);
  assert.equal(first.accepted, true);
  assert.equal(model.reserveLaunch(input).reason, 'duplicate');
  assert.equal(model.reserveLaunch(reservation({
    routeSnapshot: { agents: 'claude', review: 'default' },
  })).reason, 'launch_conflict');
  assert.equal(model.reserveLaunch(reservation({
    launchId: 'launch-other',
  })).reason, 'attempt_conflict');
});

test('returned snapshots cannot mutate immutable launch facts', () => {
  const model = new RoutingModel();
  const input = reservation();
  const returned = model.reserveLaunch(input).launch;
  input.routeSnapshot.agents = 'claude';
  input.profiles.codex.model = 'changed-model';
  input.parent.sessionId = 'changed-session';
  returned.workspace = 'relative';
  returned.parent.provider = 'claude';

  const row = rowFor(model, 'launch-one');
  assert.equal(row.resolvedVendor, 'codex');
  assert.equal(row.requestedProfile.model, 'gpt-6.1-sol');
  assert.equal(row.parent.sessionId, 'session-codex');
  assert.equal(path.isAbsolute(row.workspace), true);
  assert.deepEqual(row.permissions, { tools: 'none' });
});

test('shell and native observations for one run project as one canonical launch row', () => {
  const model = new RoutingModel();
  const launch = reserve(model);
  assert.equal(begin(model, launch).accepted, true);
  assert.equal(shellObservation(model, launch).accepted, true);
  assert.equal(nativeObservation(model, launch).accepted, true);
  assert.equal(nativeObservation(model, launch).reason, 'duplicate');

  const row = rowFor(model, launch.launchId);
  assert.equal(model.project().rows.length, 1);
  assert.equal(row.observations.length, 2);
  assert.deepEqual(row.observations.map((item) => item.source).sort(), ['native', 'shell']);
});

test('different launches in the same workspace remain separate and do not attach by cwd or PID', () => {
  const model = new RoutingModel();
  const first = reserve(model);
  const second = reserve(model, { launchId: 'launch-two', runId: 'run-two', attemptId: 'attempt-two' });
  assert.equal(first.workspace, second.workspace);
  assert.equal(begin(model, first).accepted, true);
  assert.equal(begin(model, second).accepted, true);
  assert.equal(shellObservation(model, first).accepted, true);
  assert.equal(shellObservation(model, second).accepted, true);
  assert.equal(model.project().rows.length, 2);

  assert.equal(model.attachObservation({
    ...correlated(first), source: 'shell', observationId: 'pid-observation', pid: 1234,
  }).accepted, false);
  assert.equal(model.attachObservation({
    ...correlated(first), source: 'shell', observationId: 'cwd-observation', cwd: first.workspace,
  }).accepted, false);
});

test('native identity requires a Codex thread ID and cannot be inferred from the parent agent ID', () => {
  const model = new RoutingModel();
  const launch = reserve(model, {
    parent: { provider: 'codex', sessionId: 'session-codex', agentId: 'thread-one' },
  });
  assert.equal(begin(model, launch).accepted, true);
  assert.equal(model.attachObservation({
    ...correlated(launch), source: 'native', observationId: 'agent-as-thread',
    identity: { provider: 'codex', hostId: 'host-one', homeScope: 'home-one', agentId: 'thread-one' },
  }).reason, 'invalid_native_identity');
  assert.equal(nativeObservation(model, launch).accepted, true);
  assert.equal(rowFor(model, launch.launchId).observations[0].identity.threadId, 'thread-one');
});

test('Claude session identity and shell observation attach to one external-Claude launch row', () => {
  const model = new RoutingModel();
  const launch = reserve(model, {
    launchId: 'launch-claude-session', runId: 'run-claude-session', attemptId: 'attempt-claude-session',
    parent: PARENT_CLAUDE,
  });
  assert.equal(begin(model, launch).accepted, true);
  assert.equal(shellObservation(model, launch, { observationId: 'claude-shell-observation' }).accepted, true);
  assert.equal(claudeObservation(model, launch).accepted, true);

  const row = rowFor(model, launch.launchId);
  assert.equal(model.project().rows.length, 1);
  assert.deepEqual(row.observations.map((item) => item.source).sort(), ['native', 'shell']);
  assert.deepEqual(row.observations.find((item) => item.source === 'native').identity, {
    provider: 'claude', hostId: 'host-one', homeScope: 'home-one', sessionId: 'session-uuid-one',
  });
  assert.deepEqual(row.actualProfile, { model: null, effort: null });
});

test('native identity schemas are vendor-specific and reject mixed or mismatched identifiers', () => {
  const model = new RoutingModel();
  const claude = reserve(model, {
    launchId: 'launch-claude-schema', runId: 'run-claude-schema', attemptId: 'attempt-claude-schema',
    parent: PARENT_CLAUDE,
  });
  assert.equal(begin(model, claude).accepted, true);
  const invalidClaudeIdentities = [
    { provider: 'claude', hostId: 'host-one', homeScope: 'home-one', threadId: 'thread-one' },
    { provider: 'claude', hostId: 'host-one', homeScope: 'home-one', sessionId: 'session-one', threadId: 'thread-one' },
    { provider: 'codex', hostId: 'host-one', homeScope: 'home-one', threadId: 'thread-one' },
  ];
  for (const [index, identity] of invalidClaudeIdentities.entries()) {
    assert.equal(claudeObservation(model, claude, {
      observationId: `invalid-claude-identity-${index}`, identity,
    }).reason, 'invalid_native_identity');
  }

  const codex = reserve(model);
  assert.equal(begin(model, codex).accepted, true);
  assert.equal(nativeObservation(model, codex, {
    identity: { provider: 'codex', hostId: 'host-one', homeScope: 'home-one', sessionId: 'session-one' },
  }).reason, 'invalid_native_identity');
});

test('native identity keys separate vendors and host scopes but reject a same-scope rebind', () => {
  const model = new RoutingModel();
  const codex = reserve(model, {
    launchId: 'launch-codex-shared-id', runId: 'run-codex-shared-id', attemptId: 'attempt-codex-shared-id',
  });
  const claude = reserve(model, {
    launchId: 'launch-claude-shared-id', runId: 'run-claude-shared-id', attemptId: 'attempt-claude-shared-id',
    parent: PARENT_CLAUDE,
  });
  const claudeOtherHost = reserve(model, {
    launchId: 'launch-claude-other-host', runId: 'run-claude-other-host', attemptId: 'attempt-claude-other-host',
    parent: PARENT_CLAUDE,
  });
  const claudeOtherHome = reserve(model, {
    launchId: 'launch-claude-other-home', runId: 'run-claude-other-home', attemptId: 'attempt-claude-other-home',
    parent: PARENT_CLAUDE,
  });
  for (const launch of [codex, claude, claudeOtherHost, claudeOtherHome]) {
    assert.equal(begin(model, launch).accepted, true);
  }

  assert.equal(nativeObservation(model, codex, {
    identity: { provider: 'codex', hostId: 'host-one', homeScope: 'home-one', threadId: 'shared-native-id' },
  }).accepted, true);
  assert.equal(claudeObservation(model, claude, {
    identity: { provider: 'claude', hostId: 'host-one', homeScope: 'home-one', sessionId: 'shared-native-id' },
  }).accepted, true);
  assert.equal(claudeObservation(model, claudeOtherHost, {
    identity: { provider: 'claude', hostId: 'host-two', homeScope: 'home-one', sessionId: 'shared-native-id' },
  }).accepted, true);
  assert.equal(claudeObservation(model, claudeOtherHome, {
    identity: { provider: 'claude', hostId: 'host-one', homeScope: 'home-two', sessionId: 'shared-native-id' },
  }).accepted, true);

  const claudeRebind = reserve(model, {
    launchId: 'launch-claude-rebind', runId: 'run-claude-rebind', attemptId: 'attempt-claude-rebind',
    parent: PARENT_CLAUDE,
  });
  assert.equal(begin(model, claudeRebind).accepted, true);
  assert.equal(claudeObservation(model, claudeRebind, {
    identity: { provider: 'claude', hostId: 'host-one', homeScope: 'home-one', sessionId: 'shared-native-id' },
  }).reason, 'native_identity_conflict');
  assert.equal(model.project().rows.length, 5);
});

test('Codex bridge identity can attach but cannot confirm exit without owned shell close evidence', () => {
  const model = new RoutingModel();
  const launch = reserve(model, {
    launchId: 'launch-codex-bridge', runId: 'run-codex-bridge', attemptId: 'attempt-codex-bridge',
    routeSnapshot: { agents: 'codex', review: 'default' },
    parent: PARENT_CLAUDE,
    profiles: profiles({ codex: { transport: 'bridgeBackend' } }),
  });
  assert.equal(begin(model, launch).accepted, true);
  assert.equal(nativeObservation(model, launch).accepted, true);
  assert.equal(model.recordExit({
    ...correlated(launch), source: 'native', exitId: 'bridge-native-exit', status: 'exited', exitCode: 0,
    identity: { provider: 'codex', hostId: 'host-one', homeScope: 'home-one', threadId: 'thread-one' },
  }).reason, 'native_exit_unsupported');
  assert.equal(shellExit(model, launch).accepted, true);
  assert.equal(rowFor(model, launch.launchId).ownedChildExit.observed, true);
});

test('Claude session identity is attribution evidence only and shell exit remains authoritative', () => {
  const model = new RoutingModel();
  const launch = reserve(model, {
    launchId: 'launch-claude-exit', runId: 'run-claude-exit', attemptId: 'attempt-claude-exit',
    parent: PARENT_CLAUDE,
  });
  assert.equal(begin(model, launch).accepted, true);
  assert.equal(claudeObservation(model, launch).accepted, true);
  assert.equal(model.recordExit({
    ...correlated(launch), source: 'native', exitId: 'claude-session-only', status: 'exited', exitCode: 0,
    identity: { provider: 'claude', hostId: 'host-one', homeScope: 'home-one', sessionId: 'session-uuid-one' },
  }).reason, 'native_exit_unsupported');
  assert.equal(rowFor(model, launch.launchId).ownedChildExit.observed, false);
  assert.equal(shellExit(model, launch).accepted, true);
  assert.equal(rowFor(model, launch.launchId).ownedChildExit.observed, true);
});

test('a native identity cannot be rebound to a second launch, even with the same workspace', () => {
  const model = new RoutingModel();
  const first = reserve(model);
  const second = reserve(model, { launchId: 'launch-two', runId: 'run-two', attemptId: 'attempt-two' });
  assert.equal(begin(model, first).accepted, true);
  assert.equal(begin(model, second).accepted, true);
  assert.equal(nativeObservation(model, first).accepted, true);
  assert.equal(nativeObservation(model, second).reason, 'native_identity_conflict');
});

test('actual model and effort remain separate from requested values and missing metadata stays unknown', () => {
  const model = new RoutingModel();
  const launch = reserve(model, {
    profiles: profiles({ codex: { model: 'requested-model', effort: 'high' } }),
  });
  assert.deepEqual(launch.actualProfile, { model: null, effort: null });
  assert.equal(begin(model, launch).accepted, true);
  assert.equal(shellObservation(model, launch).accepted, true);
  assert.deepEqual(rowFor(model, launch.launchId).requestedProfile, { model: 'requested-model', effort: 'high' });
  assert.deepEqual(rowFor(model, launch.launchId).actualProfile, { model: null, effort: null });

  assert.equal(shellObservation(model, launch, {
    observationId: 'runtime-metadata', actual: { model: 'observed-model', effort: 'medium' },
  }).accepted, true);
  assert.deepEqual(rowFor(model, launch.launchId).actualProfile, {
    model: 'observed-model', effort: 'medium',
  });
});

test('result receipt does not claim child exit or return a result to the parent', () => {
  const model = new RoutingModel();
  const launch = reserve(model);
  assert.equal(result(model, launch, { classification: 'uninstalled' }).reason, 'start_not_authorized');
  assert.equal(begin(model, launch).accepted, true);
  assert.equal(result(model, launch).accepted, true);

  const row = rowFor(model, launch.launchId);
  assert.equal(row.result.classification, 'ok');
  assert.deepEqual(row.ownedChildExit, { observed: false, status: null, exitCode: null });
  assert.equal(row.parentReturn, 'pending');
  assert.equal(model.markParentReturned({ ...correlated(launch), resultId: 'result-one' }).reason,
    'result_or_exit_unobserved');
});

test('a result received before exit remains returnable and an exact duplicate after exit is idempotent', () => {
  const model = new RoutingModel();
  const launch = reserve(model);
  assert.equal(begin(model, launch).accepted, true);
  assert.equal(result(model, launch, { classification: 'rate_limited' }).accepted, true);
  assert.equal(shellExit(model, launch).accepted, true);
  assert.equal(result(model, launch, { classification: 'rate_limited' }).reason, 'duplicate');
  assert.equal(result(model, launch, { resultId: 'late-conflict', classification: 'ok' }).reason,
    'duplicate_result');

  const row = rowFor(model, launch.launchId);
  assert.equal(row.result.classification, 'rate_limited');
  assert.deepEqual(row.ownedChildExit, {
    observed: true, exitId: 'exit-one', source: 'shell', status: 'exited', exitCode: 0,
  });
  assert.equal(model.markParentReturned({ ...correlated(launch), resultId: 'result-one' }).accepted, true);
  assert.equal(rowFor(model, launch.launchId).parentReturn, 'returned');
});

test('a first result arriving after known child exit is rejected and cannot make the row returnable', () => {
  const model = new RoutingModel();
  const launch = reserve(model);
  assert.equal(begin(model, launch).accepted, true);
  assert.equal(shellExit(model, launch).accepted, true);
  assert.equal(result(model, launch).reason, 'child_already_exited');

  const row = rowFor(model, launch.launchId);
  assert.equal(row.result, null);
  assert.equal(row.ownedChildExit.observed, true);
  assert.equal(row.parentReturn, 'pending');
  assert.equal(model.markParentReturned({ ...correlated(launch), resultId: 'result-one' }).reason,
    'result_or_exit_unobserved');
});

test('unknown exit does not confirm child termination or enable parent return', () => {
  const model = new RoutingModel();
  const launch = reserve(model);
  assert.equal(begin(model, launch).accepted, true);
  assert.equal(result(model, launch).accepted, true);
  assert.equal(model.recordExit({
    ...correlated(launch), source: 'shell', exitId: 'unknown-exit', status: 'unknown',
  }).reason, 'unknown_exit_observed');

  let row = rowFor(model, launch.launchId);
  assert.deepEqual(row.ownedChildExit, {
    observed: false, exitId: 'unknown-exit', source: 'shell', status: 'unknown', exitCode: null,
  });
  assert.equal(row.parentReturn, 'held_unknown_exit');
  assert.equal(model.markParentReturned({ ...correlated(launch), resultId: 'result-one' }).reason,
    'child_exit_unconfirmed');
  assert.equal(begin(model, launch).reason, 'child_end_unknown');

  assert.equal(model.recordExit({
    ...correlated(launch), source: 'shell', exitId: 'confirmed-exit', status: 'exited', exitCode: 0,
  }).accepted, true);
  row = rowFor(model, launch.launchId);
  assert.equal(row.ownedChildExit.observed, true);
  assert.equal(row.ownedChildExit.status, 'exited');
  assert.equal(row.parentReturn, 'ready');
});

test('an unknown exit can still receive a cancel request until a known cancelled exit confirms it', () => {
  const model = new RoutingModel();
  const launch = reserve(model);
  assert.equal(begin(model, launch).accepted, true);
  assert.equal(model.recordExit({
    ...correlated(launch), source: 'shell', exitId: 'unknown-exit', status: 'unknown',
  }).accepted, true);
  assert.equal(begin(model, launch).reason, 'child_end_unknown');
  assert.equal(model.requestCancel({
    ...correlated(launch), requestId: 'cancel-after-unknown', reason: 'user_requested',
  }).accepted, true);
  assert.equal(rowFor(model, launch.launchId).cancel.confirmed, false);

  assert.equal(model.recordExit({
    ...correlated(launch), source: 'shell', exitId: 'cancelled-exit', status: 'cancelled',
  }).accepted, true);
  const row = rowFor(model, launch.launchId);
  assert.equal(row.ownedChildExit.observed, true);
  assert.equal(row.ownedChildExit.status, 'cancelled');
  assert.equal(row.cancel.confirmed, true);
  assert.equal(model.requestCancel({
    ...correlated(launch), requestId: 'cancel-after-exit', reason: 'user_requested',
  }).reason, 'child_already_exited');
});

test('native exit evidence must match the identity already bound to the launch', () => {
  const model = new RoutingModel();
  const launch = reserve(model);
  assert.equal(begin(model, launch).accepted, true);
  const nativeExit = {
    ...correlated(launch), source: 'native', exitId: 'native-exit-one', status: 'exited', exitCode: 0,
    identity: { provider: 'codex', hostId: 'host-one', homeScope: 'home-one', threadId: 'thread-one' },
  };
  assert.equal(model.recordExit(nativeExit).reason, 'native_identity_unbound');
  assert.equal(nativeObservation(model, launch).accepted, true);
  assert.equal(model.recordExit(nativeExit).accepted, true);
});

test('cancel request and cancellation confirmation are separate observations', () => {
  const model = new RoutingModel();
  const launch = reserve(model);
  assert.equal(begin(model, launch).accepted, true);
  const request = {
    ...correlated(launch), requestId: 'cancel-one', reason: 'user_requested',
  };
  assert.equal(model.requestCancel(request).accepted, true);
  assert.equal(model.requestCancel(request).reason, 'duplicate');
  assert.equal(rowFor(model, launch.launchId).cancel.confirmed, false);
  assert.equal(shellExit(model, launch, { status: 'cancelled' }).accepted, true);
  assert.equal(rowFor(model, launch.launchId).cancel.confirmed, true);
});

test('a result that races with cancellation is preserved and does not imply cancellation', () => {
  const model = new RoutingModel();
  const launch = reserve(model);
  assert.equal(begin(model, launch).accepted, true);
  assert.equal(model.requestCancel({
    ...correlated(launch), requestId: 'cancel-race', reason: 'user_requested',
  }).accepted, true);
  assert.equal(result(model, launch).accepted, true);
  assert.equal(shellExit(model, launch, { status: 'exited' }).accepted, true);

  const row = rowFor(model, launch.launchId);
  assert.equal(row.result.classification, 'ok');
  assert.equal(row.cancel.requested, true);
  assert.equal(row.cancel.confirmed, false);
  assert.equal(row.ownedChildExit.observed, true);
});

test('parent session end blocks new reservations, unstarted reservations, and result return while retaining late results', () => {
  const model = new RoutingModel();
  const launch = reserve(model);
  assert.equal(model.markParentSessionEnded({ provider: 'codex', sessionId: PARENT_CODEX.sessionId }).accepted, true);
  assert.equal(begin(model, launch).reason, 'parent_ended');
  assert.equal(model.reserveLaunch(reservation({
    launchId: 'launch-late', runId: 'run-late', attemptId: 'attempt-late',
  })).reason, 'parent_ended');

  const activeModel = new RoutingModel();
  const active = reserve(activeModel);
  assert.equal(begin(activeModel, active).accepted, true);
  assert.equal(activeModel.markParentSessionEnded({ provider: 'codex', sessionId: PARENT_CODEX.sessionId }).accepted, true);
  assert.equal(result(activeModel, active).accepted, true);
  assert.equal(shellExit(activeModel, active).accepted, true);
  assert.equal(activeModel.markParentReturned({
    ...correlated(active), resultId: 'result-one',
  }).reason, 'parent_ended');
  assert.equal(rowFor(activeModel, active.launchId).parentReturn, 'held_parent_ended');
  assert.equal(rowFor(activeModel, active.launchId).result.classification, 'ok');
});

test('beginLaunch rejects after parent session end, cancel request, or child exit before its duplicate path', () => {
  const endedModel = new RoutingModel();
  const ended = reserve(endedModel);
  assert.equal(begin(endedModel, ended).accepted, true);
  assert.equal(endedModel.markParentSessionEnded({ provider: 'codex', sessionId: PARENT_CODEX.sessionId }).accepted, true);
  assert.equal(begin(endedModel, ended).reason, 'parent_ended');

  const cancelledModel = new RoutingModel();
  const cancelled = reserve(cancelledModel);
  assert.equal(begin(cancelledModel, cancelled).accepted, true);
  assert.equal(cancelledModel.requestCancel({
    ...correlated(cancelled), requestId: 'cancel-before-repeat', reason: 'user_requested',
  }).accepted, true);
  assert.equal(begin(cancelledModel, cancelled).reason, 'cancel_requested');

  const exitedModel = new RoutingModel();
  const exited = reserve(exitedModel);
  assert.equal(begin(exitedModel, exited).accepted, true);
  assert.equal(shellExit(exitedModel, exited).accepted, true);
  assert.equal(begin(exitedModel, exited).reason, 'child_already_exited');
});

test('parent session termination applies to every agent in that session and rejects agent-scoped input', () => {
  const model = new RoutingModel();
  const agentA = reserve(model, {
    launchId: 'launch-parent-agent-a', runId: 'run-parent-agent-a', attemptId: 'attempt-parent-agent-a',
    parent: { provider: 'codex', sessionId: 'shared-session', agentId: 'agent-a' },
  });
  const agentB = reserve(model, {
    launchId: 'launch-parent-agent-b', runId: 'run-parent-agent-b', attemptId: 'attempt-parent-agent-b',
    parent: { provider: 'codex', sessionId: 'shared-session', agentId: 'agent-b' },
  });
  const otherSession = reserve(model, {
    launchId: 'launch-other-session', runId: 'run-other-session', attemptId: 'attempt-other-session',
    parent: { provider: 'codex', sessionId: 'separate-session', agentId: 'agent-a' },
  });
  for (const launch of [agentA, agentB, otherSession]) assert.equal(begin(model, launch).accepted, true);

  assert.deepEqual(model.markParentSessionEnded({
    provider: 'codex', sessionId: 'shared-session',
  }), { accepted: true, reason: 'parent_ended' });
  assert.equal(rowFor(model, agentA.launchId).parentEnded, true);
  assert.equal(rowFor(model, agentB.launchId).parentEnded, true);
  assert.equal(rowFor(model, otherSession.launchId).parentEnded, false);
  assert.equal(begin(model, agentA).reason, 'parent_ended');
  assert.equal(begin(model, agentB).reason, 'parent_ended');
  assert.equal(begin(model, otherSession).reason, 'duplicate');
  assert.equal(model.reserveLaunch(reservation({
    launchId: 'launch-same-ended-session', runId: 'run-same-ended-session',
    attemptId: 'attempt-same-ended-session',
    parent: { provider: 'codex', sessionId: 'shared-session', toolUseId: 'tool-new' },
  })).reason, 'parent_ended');

  assert.equal(model.markParentSessionEnded({
    provider: 'codex', sessionId: 'shared-session', agentId: 'agent-a',
  }).reason, 'invalid_input');
  assert.equal(model.markParentSessionEnded({ parent: agentA.parent }).reason, 'invalid_input');
});

test('failure classifications remain distinct and do not imply a child exit', () => {
  const model = new RoutingModel();
  const statuses = ['rate_limited', 'uninstalled', 'unavailable', 'failed', 'timeout', 'output_limit'];
  for (const [index, classification] of statuses.entries()) {
    const launch = reserve(model, {
      launchId: `launch-failure-${index}`, runId: `run-failure-${index}`,
      attemptId: `attempt-failure-${index}`,
    });
    assert.equal(begin(model, launch).accepted, true);
    assert.equal(result(model, launch, {
      resultId: `result-failure-${index}`, classification,
    }).accepted, true);
    assert.equal(rowFor(model, launch.launchId).result.classification, classification);
    assert.equal(rowFor(model, launch.launchId).ownedChildExit.observed, false);
  }
});

test('projection exposes the trusted-caller scope without claiming caller authentication or OS sandbox proof', () => {
  const projection = new RoutingModel().project();
  assert.deepEqual(projection.trust, {
    scope: TRUST_SCOPE,
    authenticatesCallers: false,
    provesOsSandbox: false,
  });
});

test('synthetic Claude and Codex callers reserve from the same persisted routing file snapshot', async () => {
  const repositoryRoot = path.resolve(__dirname, '..', '..');
  const outputParent = path.join(repositoryRoot, 'poc', 'out');
  const isolatedHome = path.join(outputParent, `poc163-routing-test-${randomUUID()}`);
  assertNoSymlinkComponents(repositoryRoot, outputParent);
  assertNoSymlinkComponents(repositoryRoot, isolatedHome, true);
  fsSync.mkdirSync(isolatedHome, { recursive: false, mode: 0o700 });

  let routingState;
  let routingFlushed = false;
  try {
    routingState = await RoutingState.load(isolatedHome);
    const model = new RoutingModel();
    const expectedSnapshots = new Map();
    const routes = ['default', 'claude', 'codex'];
    const parents = {
      claude: PARENT_CLAUDE,
      codex: PARENT_CODEX,
    };

    for (const agents of routes) {
      const previousSnapshots = [...expectedSnapshots.entries()];
      await routingState.set('agents', agents);
      await routingState.flush();
      assert.deepEqual(readRoutingSync(isolatedHome), { agents, review: 'default' });

      for (const parentProvider of ['claude', 'codex']) {
        const routeSnapshot = readRoutingSync(isolatedHome);
        const parent = parents[parentProvider];
        const launchId = `integration-${agents}-${parentProvider}`;
        const candidate = reservation({
          launchId,
          runId: `run-${launchId}`,
          attemptId: `attempt-${launchId}`,
          routeSnapshot,
          profiles: profiles({
            codex: { transport: parentProvider === 'codex' ? 'nativeCodex' : 'bridgeBackend' },
            claude: { transport: 'externalClaude' },
          }),
          parent,
        });
        const reserved = model.reserveLaunch(candidate);
        assert.equal(reserved.accepted, true, `${parentProvider} caller reading ${agents}`);
        assert.equal(model.beginLaunch(correlated(reserved.launch)).accepted, true);
        const row = rowFor(model, launchId);
        const actualVendor = agents === 'default' ? parentProvider : agents;
        const expectedTransport = actualVendor === 'codex'
          ? (parentProvider === 'codex' ? 'nativeCodex' : 'bridgeBackend')
          : 'externalClaude';
        const expectedModel = actualVendor === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-4';
        const snapshot = {
          requestedRoute: row.requestedRoute,
          resolvedVendor: row.resolvedVendor,
          transport: row.transport,
          requestedProfile: row.requestedProfile,
        };
        assert.deepEqual(snapshot, {
          requestedRoute: agents,
          resolvedVendor: actualVendor,
          transport: expectedTransport,
          requestedProfile: { model: expectedModel, effort: 'high' },
        });
        expectedSnapshots.set(launchId, snapshot);
      }

      for (const [launchId, expected] of previousSnapshots) {
        const row = rowFor(model, launchId);
        assert.deepEqual({
          requestedRoute: row.requestedRoute,
          resolvedVendor: row.resolvedVendor,
          transport: row.transport,
          requestedProfile: row.requestedProfile,
        }, expected);
      }
    }

    for (const [launchId, expected] of expectedSnapshots) {
      const row = rowFor(model, launchId);
      assert.deepEqual({
        requestedRoute: row.requestedRoute,
        resolvedVendor: row.resolvedVendor,
        transport: row.transport,
        requestedProfile: row.requestedProfile,
      }, expected);
    }
    await routingState.flush();
    routingFlushed = true;
  } finally {
    if (routingState && !routingFlushed) {
      try {
        await routingState.flush();
        routingFlushed = true;
      } catch { }
    }
    if (routingFlushed) {
      assertNoSymlinkComponents(repositoryRoot, isolatedHome);
      fsSync.rmSync(isolatedHome, { recursive: true, force: false });
    }
  }
});
