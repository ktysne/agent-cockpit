'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const CONTRACT = require('./fixture-contract');
const { GhOutputRegistrationAdapter } = require('./gh-output-adapter');
const { PrReviewModel } = require('./model');

const ROUTING = { vendor: 'codex', model: 'fixture-model', effort: 'medium', transport: 'app-server' };
const RUN = { provider: 'codex', launchId: 'launch-codex-1', runId: 'run-codex-1', attemptId: 'attempt-codex-1' };
const OTHER_RUN = { provider: 'codex', launchId: 'launch-codex-1', runId: 'run-codex-1', attemptId: 'attempt-codex-2' };
const NATIVE = { provider: 'codex', vendor: 'codex', scope: 'app-server', nativeId: 'native-thread-1' };
const OTHER_NATIVE = { ...NATIVE, nativeId: 'native-thread-2' };
const ITEM = 'codex-source-item-1';
const PR_URL = 'https://github.com/OpenAI/Agent-Cockpit/pull/164';

function setup({ maxOutputBytes } = {}) {
  const model = new PrReviewModel({ configuration: ROUTING });
  assert.deepEqual(model.registerExecution({ ...RUN, origin: 'independent', purpose: 'work' }), RUN);
  assert.deepEqual(model.registerExecution({ ...OTHER_RUN, origin: 'independent', purpose: 'work' }), OTHER_RUN);
  const adapter = new GhOutputRegistrationAdapter({ model, maxOutputBytes });
  assert.equal(adapter.bindSourceItem({ sourceItemId: ITEM, execution: RUN, nativeIdentity: NATIVE }), true);
  return { model, adapter };
}

function completion(overrides = {}) {
  return {
    kind: 'commandExecution',
    status: 'completed',
    sourceItemId: ITEM,
    execution: { ...RUN },
    nativeIdentity: { ...NATIVE },
    argv: ['gh', 'pr', 'create', '--title', 'fixture PR'],
    exitCode: 0,
    aggregatedOutput: `Creating pull request\n${PR_URL}\n`,
    ...overrides,
  };
}

test('Codex gh pr createの完了出力は登録済み実行へ結び付けてPR登録する', () => {
  const { model, adapter } = setup();

  const result = adapter.observeCommandExecution(completion());

  assert.equal(result.accepted, true);
  assert.equal(result.reason, 'registered');
  assert.equal(result.evidenceKind, 'synthetic-fixture-only');
  assert.deepEqual(result.pullRequest.registrationSources, ['independent_codex_gh']);
  assert.deepEqual(result.pullRequest.creationOrigins, [{ source: 'independent_codex_gh', run: RUN }]);
  assert.deepEqual(result.pullRequest.notificationTargets, [RUN]);
  assert.equal(model.project().pullRequests.length, 1);
  assert.equal(CONTRACT.evidenceKind, 'synthetic-fixture-only');
});

test('Claude実行とreview目的の実行はPR作成元として受け付けない', () => {
  const { model, adapter } = setup();
  const claudeRun = { provider: 'claude', launchId: 'launch-claude-1', runId: 'run-claude-1', attemptId: 'attempt-claude-1' };
  const reviewRun = { ...RUN, attemptId: 'attempt-review-1' };
  assert.deepEqual(model.registerExecution({
    ...claudeRun, origin: 'independent', purpose: 'work',
    configuration: { vendor: 'claude', model: 'fixture-model', effort: 'medium', transport: 'cli' },
  }), claudeRun);
  assert.deepEqual(model.registerExecution({ ...reviewRun, origin: 'independent', purpose: 'review' }), reviewRun);

  assert.equal(adapter.bindSourceItem({
    sourceItemId: 'claude-item-1', execution: claudeRun,
    nativeIdentity: { provider: 'claude', vendor: 'claude', scope: 'cli', nativeId: 'claude-session-1' },
  }), false);
  assert.equal(adapter.bindSourceItem({
    sourceItemId: 'codex-review-item-1', execution: reviewRun,
    nativeIdentity: { ...NATIVE, nativeId: 'native-review-1' },
  }), false);
  assert.equal(model.project().pullRequests.length, 0);
});

test('Codex委譲実行のPR登録元はdelegated_codex_ghとして保持する', () => {
  const { model, adapter } = setup();
  const delegatedRun = { provider: 'codex', launchId: 'launch-child-1', runId: 'run-child-1', attemptId: 'attempt-child-1' };
  const nativeIdentity = { ...NATIVE, nativeId: 'native-child-1' };
  assert.deepEqual(model.registerExecution({
    ...delegatedRun, origin: 'delegated', purpose: 'work',
    parent: { provider: 'claude', sessionId: 'parent-session-1', agentId: 'agent-1', toolUseId: 'tool-use-1' },
  }), delegatedRun);
  assert.equal(adapter.bindSourceItem({
    sourceItemId: 'codex-child-item-1', execution: delegatedRun, nativeIdentity,
  }), true);

  const result = adapter.observeCommandExecution(completion({
    sourceItemId: 'codex-child-item-1', execution: delegatedRun, nativeIdentity,
  }));

  assert.equal(result.accepted, true);
  assert.deepEqual(result.pullRequest.registrationSources, ['delegated_codex_gh']);
  assert.deepEqual(result.pullRequest.creationOrigins, [{ source: 'delegated_codex_gh', run: delegatedRun }]);
});
test('gh pr create以外のコマンド出力はPR登録しない', () => {
  const { model, adapter } = setup();

  const result = adapter.observeCommandExecution(completion({ argv: ['gh', 'pr', 'list'] }));

  assert.deepEqual(result, { accepted: false, reason: 'not_gh_pr_create' });
  assert.equal(model.project().pullRequests.length, 0);
});

test('失敗したコマンドと未完了イベントはPR登録しない', () => {
  const { model, adapter } = setup();

  assert.equal(adapter.observeCommandExecution(completion({ exitCode: 1 })).reason, 'command_failed');
  assert.equal(adapter.observeCommandExecution(completion({ status: 'running' })).reason, 'execution_incomplete');
  assert.equal(model.project().pullRequests.length, 0);
});

test('実行IDやsource item/native IDが欠落または別実行なら登録しない', () => {
  const { model, adapter } = setup();
  const missingAttempt = completion({ execution: { provider: RUN.provider, launchId: RUN.launchId, runId: RUN.runId } });
  const missingItem = completion({ sourceItemId: undefined });
  const missingNativeId = completion({ nativeIdentity: { provider: NATIVE.provider, vendor: NATIVE.vendor, scope: NATIVE.scope } });
  const wrongRun = completion({ execution: { ...RUN, runId: 'different-run' } });
  const wrongAttempt = completion({ execution: { ...OTHER_RUN } });
  const wrongNative = completion({ nativeIdentity: { ...OTHER_NATIVE } });

  assert.equal(adapter.observeCommandExecution(missingAttempt).reason, 'missing_execution_binding');
  assert.equal(adapter.observeCommandExecution(missingItem).reason, 'missing_execution_binding');
  assert.equal(adapter.observeCommandExecution(missingNativeId).reason, 'missing_execution_binding');
  assert.equal(adapter.observeCommandExecution(wrongRun).reason, 'execution_unregistered');
  assert.equal(adapter.observeCommandExecution(wrongAttempt).reason, 'execution_binding_mismatch');
  assert.equal(adapter.observeCommandExecution(wrongNative).reason, 'execution_binding_mismatch');
  assert.equal(model.project().pullRequests.length, 0);
});

test('source itemの再結合は同じ実行とnative IDに限る', () => {
  const { adapter } = setup();

  assert.equal(adapter.bindSourceItem({ sourceItemId: ITEM, execution: RUN, nativeIdentity: NATIVE }), true);
  assert.equal(adapter.bindSourceItem({ sourceItemId: ITEM, execution: OTHER_RUN, nativeIdentity: NATIVE }), false);
  assert.equal(adapter.bindSourceItem({ sourceItemId: ITEM, execution: RUN, nativeIdentity: OTHER_NATIVE }), false);
  assert.equal(adapter.bindSourceItem({ sourceItemId: 'unregistered', execution: { ...RUN, runId: 'absent' }, nativeIdentity: NATIVE }), false);
});

test('同じsource itemからの重複完了は一件にし、別PRへの再利用を拒否する', () => {
  const { model, adapter } = setup();

  const first = adapter.observeCommandExecution(completion());
  const duplicate = adapter.observeCommandExecution(completion());
  const conflicting = adapter.observeCommandExecution(completion({
    aggregatedOutput: 'https://github.com/openai/agent-cockpit/pull/165',
  }));

  assert.equal(first.reason, 'registered');
  assert.equal(duplicate.reason, 'duplicate');
  assert.equal(conflicting.reason, 'source_item_already_registered');
  assert.equal(model.project().pullRequests.length, 1);
});

test('出力中の同一PR URLは大文字小文字を正規化して一件登録する', () => {
  const { model, adapter } = setup();
  const output = [
    `Created ${PR_URL}`,
    'https://github.com/openai/agent-cockpit/pull/164',
  ].join('\n');

  const result = adapter.observeCommandExecution(completion({ aggregatedOutput: output }));

  assert.equal(result.accepted, true);
  assert.equal(model.project().pullRequests.length, 1);
  assert.equal(result.pullRequest.owner, 'openai');
  assert.equal(result.pullRequest.repo, 'agent-cockpit');
});

test('異なるPR URLが複数含まれる出力は曖昧として登録しない', () => {
  const { model, adapter } = setup();

  const result = adapter.observeCommandExecution(completion({
    aggregatedOutput: `${PR_URL}\nhttps://github.com/openai/agent-cockpit/pull/165`,
  }));

  assert.deepEqual(result, { accepted: false, reason: 'ambiguous_pull_request_urls' });
  assert.equal(model.project().pullRequests.length, 0);
});

test('PR URLがない出力と上限を超える出力は登録しない', () => {
  const { model, adapter } = setup({ maxOutputBytes: 160 });

  assert.equal(adapter.observeCommandExecution(completion({ aggregatedOutput: 'created without a PR URL' })).reason,
    'pull_request_url_missing');
  assert.equal(adapter.observeCommandExecution(completion({ aggregatedOutput: `${PR_URL}\n${'x'.repeat(200)}` })).reason,
    'output_too_large');
  assert.equal(model.project().pullRequests.length, 0);
});
