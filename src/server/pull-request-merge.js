'use strict';

const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { isCompleteCommitSha, pullRequestKey, staleHeadDescription, validBranchName, validRepositoryPart } = require('./pull-request-utils');
const { reservationReview } = require('../shared/review-evaluation');
const { safeRepo, ghFailureKind, matchingRepositoryCheckout, listWorktrees, gitRemotes, stackChain, stackMemberBlocker, stackReviewBlocker, STACK_MERGE_LIMIT } = require('./pull-requests');

const METHODS = new Set(['merge', 'squash', 'rebase']);
const METHOD_LABELS = { merge: 'マージコミット', squash: 'スカッシュ', rebase: 'リベース' };

function actionResult(status, error) {
  return { ok: false, status, error };
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

function confirmedMergedHead(pullRequest) {
  if (!isCompleteCommitSha(pullRequest?.headRefOid) || !validBranchName(pullRequest?.headRefName) ||
    !validBranchName(pullRequest?.baseRefName)) return null;
  return {
    headRefOid: pullRequest.headRefOid.toLowerCase(),
    headRefName: pullRequest.headRefName,
    baseRefName: pullRequest.baseRefName,
  };
}

function retargetedBaseStatus(retargeted) {
  if (!retargeted.length) return '';
  return `#${retargeted.map((item) => item.number).join('、')} の base は付け替え済みです。`;
}

function completedRetargetStatus(retargeted) {
  if (!retargeted.length) return 'base の付け替えは未完了';
  return `完了: ${retargeted.map((item) => `#${item.number}`).join('、')} の base を付け替え済み`;
}

function mergeCandidateError(candidate, input, number) {
  const pullRequest = candidate.pullRequest;
  if (pullRequest.headRefOid.toLowerCase() !== input.headRefOid.toLowerCase()) {
    return '表示していた head SHA と現在の head SHA が異なります。状態を確認してください';
  }
  if (pullRequest.mergeMethodFixed && input.method !== pullRequest.mergeMethodFixed) return 'マージ方式がマージコミットに固定のため、選んだ方式では実行しません';
  if (!candidate.repository.mergeMethods.includes(input.method)) return 'このリポジトリでは選んだマージ方式が許可されていません';
  if (!pullRequest.canMerge) return `PR #${number} はマージできません: ${pullRequest.blocker || '状態を確認できません'}`;
  if (!pullRequest.mergeTarget || pullRequest.baseRefName !== pullRequest.mergeTarget || pullRequest.effectiveBase !== pullRequest.mergeTarget) {
    return `PR #${number} は確認済みのマージ先を base にしていません`;
  }
  return null;
}

function errorText(error) {
  return [error?.message, error?.stderr].filter((value) => typeof value === 'string').join('\n');
}

class PullRequestMergeManager {
  constructor({ state, tracker, answerDelivery, diagnostics, now = Date.now, gitExecFileImpl = execFile } = {}) {
    this.state = state;
    this.diagnostics = diagnostics;
    this.tracker = tracker;
    this.answerDelivery = answerDelivery;
    this.now = now;
    this.gitExecFileImpl = gitExecFileImpl;
    this.localUpdates = new Set();
    this.worktreeUpdates = new Map();
    this.inFlight = new Map();
    this.repositoryInFlight = new Set();
    this.repositoryLockWaiters = new Map();
    this.pendingRepositoryReservationChecks = new Map();
    this.repositoryReservationChecks = new Set();
    this.handledMerges = new Set();
    this.mergeOutcomes = new Map();
    this.diagnosticReservationConditions = new Map();
    this.stackMergeCancellationRequests = new Set();
  }

  async withPullRequestLock(owner, repo, number, operation) {
    const key = pullRequestKey(owner, repo, number);
    if (this.inFlight.has(key)) return actionResult(409, `PR #${number} の操作が進行中です`);
    const pending = Promise.resolve().then(operation);
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }

  async withRepositoryTryLock(owner, repo, operation) {
    const key = safeRepo(owner, repo).toLowerCase();
    if (this.repositoryInFlight.has(key)) return { acquired: false };
    this.repositoryInFlight.add(key);
    try {
      return { acquired: true, result: await operation() };
    } finally {
      this.releaseRepositoryLock(key);
    }
  }

  async withRepositoryLock(owner, repo, operation) {
    const key = safeRepo(owner, repo).toLowerCase();
    if (this.repositoryInFlight.has(key)) {
      const waiters = this.repositoryLockWaiters.get(key) || [];
      this.repositoryLockWaiters.set(key, waiters);
      await new Promise((resolve) => waiters.push(resolve));
    } else {
      this.repositoryInFlight.add(key);
    }
    try {
      return await operation();
    } finally {
      this.releaseRepositoryLock(key);
    }
  }

  releaseRepositoryLock(key) {
    const waiters = this.repositoryLockWaiters.get(key);
    const next = waiters?.shift();
    if (next) {
      if (!waiters.length) this.repositoryLockWaiters.delete(key);
      next();
      return;
    }
    this.repositoryLockWaiters.delete(key);
    this.repositoryInFlight.delete(key);
    const pending = this.pendingRepositoryReservationChecks.get(key);
    if (pending) {
      this.pendingRepositoryReservationChecks.delete(key);
      setImmediate(() => this.checkReservations(pending.owner, pending.repo).catch(() => {}));
    }
  }

  registeredPullRequest(number, registrationKey) {
    if (!Number.isSafeInteger(number) || number < 1) return null;
    return this.validRegisteredPullRequest(this.state.pullRequestRegistration(number, registrationKey));
  }

  registeredPullRequestByKey(registrationKey) {
    return this.validRegisteredPullRequest(this.state.pullRequestRegistrationByKey(registrationKey));
  }

  validRegisteredPullRequest(registration) {
    if (!registration || !validRepositoryPart(registration.owner) || !validRepositoryPart(registration.repo)) return null;
    try {
      safeRepo(registration.owner, registration.repo);
    } catch {
      return null;
    }
    return registration;
  }

  merge(input) {
    const registration = this.registeredPullRequest(input.number, input.registration_key);
    if (!registration) return Promise.resolve(actionResult(404, '記録された PR が見つかりません'));
    if (!isCompleteCommitSha(input.headRefOid) || !METHODS.has(input.method) || typeof input.deleteBranch !== 'boolean') {
      return Promise.resolve(actionResult(400, 'マージ内容を確認してください'));
    }
    return this.withRepositoryLock(registration.owner, registration.repo, () => (
      this.withPullRequestLock(registration.owner, registration.repo, registration.number, () => (
        this.performMerge(registration, input)
      ))
    ));
  }

  reserve(input) {
    const registration = this.registeredPullRequest(input.number, input.registration_key);
    if (!registration) return Promise.resolve(actionResult(404, '記録された PR が見つかりません'));
    if (!isCompleteCommitSha(input.headRefOid) || !METHODS.has(input.method) || typeof input.deleteBranch !== 'boolean') {
      return Promise.resolve(actionResult(400, 'マージ予約の内容を確認してください'));
    }
    return this.withRepositoryLock(registration.owner, registration.repo, () => (
      this.withPullRequestLock(registration.owner, registration.repo, registration.number, () => (
        this.performReservation(registration, input)
      ))
    ));
  }

  async mergeStack(input) {
    if (!Array.isArray(input.items) || input.items.length < 2 || input.items.length > STACK_MERGE_LIMIT ||
      input.method !== 'merge' || input.deleteBranch !== true || !validBranchName(input.targetBranch) ||
      input.items.some((item) => !isCompleteCommitSha(item.headRefOid))) return actionResult(400, '一括マージの内容を確認してください');
    const registrations = input.items.map((item) => this.registeredPullRequest(item.number, item.registration_key));
    if (registrations.some((record) => !record)) return actionResult(409, '構成員の登録が見つかりません');
    const first = registrations[0];
    if (registrations.some((record) => safeRepo(record.owner, record.repo).toLowerCase() !== safeRepo(first.owner, first.repo).toLowerCase())) {
      return actionResult(409, '一本のスタックを指定してください');
    }
    const result = await this.withRepositoryLock(first.owner, first.repo, () => this.performStackMerge(registrations, input));
    if (result.ok) await this.checkReservations(first.owner, first.repo);
    return result;
  }

  async performStackMerge(registrations, input) {
    const candidates = [];
    for (const registration of registrations) {
      const candidate = await this.freshCandidate(registration);
      if (candidate.error) return actionResult(409, candidate.error);
      candidates.push(candidate);
    }
    // 取り直し中に構成が変わることがあるため、最後の一覧で、指定が鎖の一番下から続く範囲かを照合する。
    const latestRoot = this.tracker.mergeCandidate(registrations[0]);
    const chain = latestRoot?.pullRequest && stackChain(latestRoot.pullRequest);
    if (!chain || latestRoot.pullRequest.parentNumber || chain.length < input.items.length ||
      input.items.some((item, index) => chain[index].number !== item.number)) return actionResult(409, 'スタックの下から続く構成員を下から順に指定してください');
    const numbers = new Set(input.items.map((item) => item.number));
    const targetBranch = this.reservationTarget(latestRoot);
    if (!validBranchName(targetBranch)) return actionResult(409, 'マージ先を確認できません');
    if (targetBranch !== input.targetBranch) return actionResult(409, 'マージ先が確認時から変わりました');
    for (let index = 0; index < registrations.length; index += 1) {
      const registration = registrations[index];
      if (!this.registeredPullRequest(input.items[index].number, input.items[index].registration_key)) return actionResult(409, '構成員の登録が変わりました');
      const candidate = this.tracker.mergeCandidate(registration);
      const pr = candidate?.pullRequest;
      if (!candidate?.repository.listAvailable || !candidate.repository.configAvailable || !pr) return actionResult(409, 'PR の状態を確認できません');
      if (pr.headRefOid.toLowerCase() !== input.items[index].headRefOid.toLowerCase()) return actionResult(409, `#${pr.number} の head が変わっています`);
      if (this.state.pullRequestMergeReservation(registration.owner, registration.repo, registration.number) ||
        this.state.pullRequestMergeIntent(registration.owner, registration.repo, registration.number)) return actionResult(409, `#${pr.number} はマージを予約中、または処理中です`);
      const reason = stackMemberBlocker(pr, candidate.repository, numbers);
      if (reason) return actionResult(409, `#${pr.number} ${reason}`);
      const reviewReason = stackReviewBlocker(pr);
      if (reviewReason) return actionResult(409, `#${pr.number} は${reviewReason}`);
    }
    const runId = randomUUID();
    const saved = [];
    try {
      for (let index = 0; index < registrations.length; index += 1) {
        const registration = registrations[index];
        const record = { session_id: registration.session_id, owner: registration.owner, repo: registration.repo,
          number: registration.number, url: candidates[index].pullRequest.url, targetBranch,
          kind: 'stack', headRefOid: input.items[index].headRefOid, runId, order: index + 1, total: registrations.length,
          method: 'merge', deleteBranch: true, createdAt: new Date(this.now()).toISOString() };
        if (!this.state.setPullRequestMergeReservation(record)) throw new Error('reservation-save');
        saved.push(record);
      }
      await this.state.flushStoreWrite();
    } catch {
      for (const record of saved) this.state.clearPullRequestMergeReservation(record.owner, record.repo, record.number);
      await this.state.waitForPersistence?.().catch(() => {});
      return actionResult(500, '一括マージの予約を保存できませんでした');
    }
    if (chain.slice(0, input.items.length).some((pr) => pr.mergeable === 'UNKNOWN')) {
      const { owner, repo } = registrations[0];
      this.tracker.unknownMergeableRefreshCounts.delete(safeRepo(owner, repo).toLowerCase());
      this.tracker.scheduleUnknownMergeableRefresh(owner, repo, latestRoot.repository.openPullRequests, { verifyHeads: true });
    }
    return { ok: true, runId, reserved: true };
  }

  stackReservations(reservation) {
    return this.state.pullRequestMergeReservationsForRepo(reservation.owner, reservation.repo)
      .filter((record) => record.kind === 'stack' && record.runId === reservation.runId).sort((a, b) => a.order - b.order);
  }

  async cancelStackMerge({ runId }) {
    this.stackMergeCancellationRequests.add(runId);
    try {
      const reservation = this.state.pullRequestMergeReservations().find((record) => record.kind === 'stack' && record.runId === runId);
      if (!reservation) return actionResult(404, '一括マージの予約が見つかりません');
      return await this.withRepositoryLock(reservation.owner, reservation.repo, () => this.cancelStackRun(reservation));
    } finally {
      this.stackMergeCancellationRequests.delete(runId);
    }
  }

  async cancelStackRun(reservation, reason = null) {
    const remaining = this.stackReservations(reservation);
    if (!remaining.length) return { ok: true, cancelled: true };
    const numbers = remaining.map((record) => `#${record.number}`).join('、');
    const message = reason
      ? `スタックの一括マージを中止しました: #${reservation.number} の ${reason}。残りの予約 (${numbers}) を取り消しました`
      : `中止しました。残りの予約 (${numbers}) を取り消しました`;
    for (const record of remaining) this.state.clearPullRequestMergeReservation(record.owner, record.repo, record.number);
    this.state.recordStackMergeResult({ owner: reservation.owner, repo: reservation.repo, runId: reservation.runId,
      at: new Date(this.now()).toISOString(), message });
    const numbersSet = new Set(remaining.map((record) => record.number));
    const sessions = this.state.pullRequestRegistrationsForRepo(reservation.owner, reservation.repo)
      .filter((record) => numbersSet.has(record.number)).map((record) => record.session_id);
    this.answerDelivery?.notifySessions(unique([...sessions, ...remaining.map((record) => record.session_id)]), message);
    await this.state.waitForPersistence?.();
    return { ok: true, cancelled: true, message };
  }

  stackReservationMergeInput(candidate, reservation) {
    if (this.stackMergeCancellationRequests.has(reservation.runId)) return { userCancelled: true };
    if (this.state.pullRequestMergeReservation(reservation.owner, reservation.repo, reservation.number)?.runId !== reservation.runId) {
      return { cancelled: true, reason: '予約が取り消されました' };
    }
    if (!candidate?.repository?.listAvailable || !candidate.repository.configAvailable) return null;
    if (candidate.repository.uninspectedNumbers?.has(reservation.number)) return null;
    const pr = candidate.pullRequest;
    if (!pr) return { cancelled: true, reason: 'PR がオープンではありません' };
    if (pr.headRefOid.toLowerCase() !== reservation.headRefOid.toLowerCase()) return { cancelled: true, reason: 'head が変わりました' };
    const numbers = new Set(this.stackReservations(reservation).map((record) => record.number));
    const reason = stackMemberBlocker(pr, candidate.repository, numbers);
    if (reason) return { cancelled: true, reason };
    const reviewReason = stackReviewBlocker(pr);
    if (reviewReason) return { cancelled: true, reason: `クロスレビューの条件を満たさなくなった(${reviewReason})` };
    if (['parentOpen', 'parentMergePending', 'mergeableUnknown', 'restackCheckUnknown'].includes(pr.operationBlockerCode) ||
      pr.ci === 'pending') return null;
    if (pr.mergeTarget !== reservation.targetBranch) return { cancelled: true, reason: 'マージ先が変わりました' };
    const input = { headRefOid: reservation.headRefOid, method: 'merge', deleteBranch: true };
    const error = mergeCandidateError(candidate, input, reservation.number);
    return error ? { cancelled: true, reason: error } : { input };
  }

  cancelReservation(input) {
    const registration = this.registeredPullRequest(input.number, input.registration_key);
    if (!registration) return Promise.resolve(actionResult(404, '記録された PR が見つかりません'));
    return this.withPullRequestLock(registration.owner, registration.repo, registration.number, () => (
      this.performCancelReservation(registration, '開発者がダッシュボードからマージ予約を取り消した')
    ));
  }

  requestConflictResolution(input) {
    const registration = this.registeredPullRequestByKey(input.key);
    if (!registration) return Promise.resolve(actionResult(404, '記録された PR が見つかりません'));
    if (!isCompleteCommitSha(input.headRefOid)) {
      return Promise.resolve(actionResult(400, '衝突の解消依頼の head SHA を確認してください'));
    }
    return this.withPullRequestLock(registration.owner, registration.repo, registration.number, () => (
      this.performConflictRequest(registration, input)
    ));
  }

  async performConflictRequest(registration, input) {
    const candidate = await this.freshCandidate(registration);
    if (candidate.error) {
      const missing = candidate.error.includes('オープンの記録済みスタックにありません');
      return actionResult(missing ? 404 : 502, candidate.error);
    }
    const pullRequest = candidate.pullRequest;
    if (!pullRequest.conflict) return actionResult(409, 'この PR に現在コンフリクトはありません');
    if (pullRequest.headRefOid.toLowerCase() !== input.headRefOid.toLowerCase()) {
      return actionResult(409, '表示していた head SHA と現在の head SHA が異なります。状態を確認してください');
    }
    const registrations = this.state.pullRequestRegistrationsForRepo(registration.owner, registration.repo)
      .filter((record) => record.number === registration.number);
    const sessionIds = unique(registrations
      .filter((record) => !this.state.sessionHasEnded(record.session_id))
      .map((record) => record.session_id));
    if (!sessionIds.length) return actionResult(409, '衝突の解消を依頼できる稼働中のセッションがありません');

    const message = [
      `PR #${registration.number} (${pullRequest.url}) の衝突を解消してください。`,
      `base ブランチ ${pullRequest.baseRefName} を取り込んで衝突を解消し、検証してから push してください。`,
      'この PR はマージしないでください。',
      '衝突を解消できない場合は、その理由を報告してください。',
    ].join('\n');
    this.answerDelivery?.notifySessions(sessionIds, message);
    const requestedAt = new Date(this.now()).toISOString();
    this.state.recordPullRequestConflictRequest({
      owner: registration.owner,
      repo: registration.repo,
      number: registration.number,
      headRefOid: pullRequest.headRefOid,
      requestedAt,
      sessionIds,
    });
    await this.state.waitForPersistence?.();
    return { ok: true, requestedAt };
  }

  async setReviewSkip(registration, headRefOid, reason) {
    return this.setReviewRecord(registration, headRefOid, reason);
  }

  async setReviewDeferral(registration, headRefOid, reason, next) {
    return this.setReviewRecord(registration, headRefOid, reason, next);
  }

  async setReviewRecord(registration, headRefOid, reason, next) {
    let saved;
    try {
      const candidate = await this.reviewSkipCandidate(registration);
      if (candidate.refreshFailed) return actionResult(502, 'PR の状態を取り直せませんでした');
      if (candidate.error) return actionResult(409, 'PR はオープンではありません');
      if (candidate.pullRequest.staleHead) {
        return actionResult(409, `${staleHeadDescription(candidate.pullRequest.staleHead)}ため記録しません。PR の head とブランチの先頭が一致してから記録してください`);
      }
      if (candidate.pullRequest.headRefOid.toLowerCase() !== headRefOid.toLowerCase()) {
        return actionResult(409, 'PR の head が変わりました。現在の状態を確認してください');
      }
      const record = {
        owner: registration.owner,
        repo: registration.repo,
        number: registration.number,
        headRefOid: candidate.pullRequest.headRefOid,
        reason,
        recordedAt: new Date(this.now()).toISOString(),
      };
      saved = next === undefined ? this.state.setCrossReviewSkip(record)
        : this.state.setCrossReviewDeferral({ ...record, next });
      if (!saved) return actionResult(400, 'Invalid review skip');
    } catch {
      return actionResult(502, 'PR の状態を取り直せませんでした');
    }
    let persisted = true;
    try {
      await this.state.flushStoreWrite();
      await this.state.waitForPersistence();
    } catch {
      persisted = false;
    }
    try {
      await this.tracker.refreshReviewGroups(registration.owner, registration.repo);
    } catch {
      // 記録はメモリーに反映済みで、表示は次の取り直しで追いつく。
    }
    // 記録はメモリーに反映済みで保存も再試行されるので、未記録と区別できる 500 で返す。
    if (!persisted) return actionResult(500, 'レビュー記録を反映しましたが、保存を確かめられませんでした');
    return { ok: true, saved };
  }

  async reviewSkipCandidate(registration) {
    let refreshed;
    try {
      refreshed = await this.tracker.refreshRepoFresh(registration.owner, registration.repo, { priority: true });
    } catch {
      return { error: 'PR の状態を取り直せませんでした', refreshFailed: true };
    }
    if (refreshed?.listAvailable !== true || !refreshed.uninspectedNumbers ||
      refreshed.uninspectedNumbers.has(registration.number)) {
      return { error: 'PR の状態を取り直せませんでした', refreshFailed: true };
    }
    const candidate = this.tracker.mergeCandidate(registration);
    if (!candidate?.pullRequest) return { error: `PR #${registration.number} はオープンの記録済みスタックにありません` };
    return candidate;
  }

  async refreshedCandidate(registration) {
    let refreshed;
    try {
      refreshed = await this.tracker.refreshRepoFresh(registration.owner, registration.repo, { priority: true });
    } catch {
      return { error: 'GitHub から PR の状態を取り直せませんでした', refreshFailed: true };
    }
    if (refreshed?.error) return { error: `GitHub から PR の状態を取り直せませんでした。${refreshed.error}` };
    const candidate = this.tracker.mergeCandidate(registration);
    if (!candidate?.pullRequest) return { error: `PR #${registration.number} はオープンの記録済みスタックにありません` };
    return candidate;
  }

  async freshCandidate(registration) {
    const candidate = await this.refreshedCandidate(registration);
    if (candidate.error) return candidate;
    if (!validBranchName(candidate.repository.defaultBranch) || !validBranchName(candidate.pullRequest.headRefName)) {
      return { error: '既定ブランチまたは head ブランチ名を安全に確認できません' };
    }
    return candidate;
  }

  stackedPullRequests(candidate, parentNumber) {
    if (candidate.pullRequest.headRefName === candidate.repository.defaultBranch) return [];
    const stacked = new Map(candidate.pullRequest.children.map((child) => [child.number, {
      number: child.number,
      baseRefName: child.baseRefName,
      headRefName: child.headRefName,
    }]));
    const openByNumber = new Map(candidate.repository.openPullRequests.map((pullRequest) => [pullRequest.number, pullRequest]));
    for (const retarget of this.state.pullRequestRetargetsForRepo(candidate.registration.owner, candidate.registration.repo)) {
      if (retarget.fromNumber !== parentNumber) continue;
      const child = openByNumber.get(retarget.number);
      if (!child) continue;
      stacked.set(child.number, {
        number: child.number,
        baseRefName: retarget.previousBaseRefName || child.baseRefName,
        headRefName: child.headRefName,
      });
    }
    return [...stacked.values()];
  }

  async processMergedPullRequest(owner, repo, pullRequest, mergedAt, confirmedIntent = null) {
    const registrations = this.state.pullRequestRegistrationsForRepo(owner, repo)
      .filter((record) => record.number === pullRequest.number);
    const related = this.state.relatedPullRequestRegistrationsForRepo(owner, repo)
      .filter((record) => record.number === pullRequest.number);
    const changes = { state: 'merged', mergedAt, mergedHead: confirmedMergedHead(pullRequest) };
    for (const registration of registrations) {
      this.state.updatePullRequest(registration.session_id, owner, repo, pullRequest.number, changes);
    }
    for (const record of related) this.state.updateRelatedPullRequest(owner, repo, pullRequest.number, changes);
    return this.handleDetectedMerge({
      owner,
      repo,
      pullRequest,
      mergedAt,
      confirmedIntent,
      reservation: this.state.pullRequestMergeReservation(owner, repo, pullRequest.number),
      registrations,
      stackedPullRequests: this.stackedPullRequests({
        registration: { owner, repo },
        repository: this.tracker.repositoryState(owner, repo) || { openPullRequests: [] },
        pullRequest: { children: [] },
      }, pullRequest.number),
    });
  }

  async performMerge(registration, input, reserved = false) {
    const reject = (status, error, condition) => {
      this.diagnostics?.record('info', 'merge', 'merge.check', { operation: 'execute',
        repository: safeRepo(registration.owner, registration.repo), number: registration.number, condition, status });
      const saved = this.state.pullRequestMergeReservation(registration.owner, registration.repo, registration.number);
      if (reserved && saved?.kind === 'stack' && !['candidate-unavailable', 'latest-unavailable', 'review-not-ready', 'latest-review-not-ready'].includes(condition)) {
        return this.cancelStackRun(saved, error);
      }
      return actionResult(status, error);
    };
    const reservation = this.state.pullRequestMergeReservation(registration.owner, registration.repo, registration.number);
    if (!reserved && reservation?.kind === 'stack') return reject(409, '一括マージの予約中です。先に一括マージを中止してください', 'stack-reserved');
    if (reserved && (!reservation || reservation.method !== input.method || reservation.deleteBranch !== input.deleteBranch)) {
      return reject(409, 'マージ予約の状態が変わりました', 'reservation-changed');
    }
    const candidate = await this.freshCandidate(registration);
    if (candidate.error) return reject(409, candidate.error, 'candidate-unavailable');
    let mergeInput = input;
    if (reserved) {
      const reservationStatus = (reservation.kind === 'stack' ? this.stackReservationMergeInput(candidate, reservation) : this.reservationMergeInput(candidate, reservation));
      if (reservationStatus?.userCancelled) return this.cancelStackRun(reservation);
      if (reservationStatus?.cancelled) return this.cancelStackRun(reservation, reservationStatus.reason);
      if (reservationStatus?.halted) return this.cancelHaltedReservation(reservation);
      if (!reservationStatus) return reject(409, reservation.kind === 'stack' ? '一括マージの条件待ちです' : 'レビュー収束後マージの条件が変わりました。予約は保持しています', 'review-not-ready');
      mergeInput = reservationStatus.input;
    }
    const pullRequest = candidate.pullRequest;
    this.diagnostics?.record('info', 'merge', 'merge.check', { operation: 'execute',
      repository: safeRepo(registration.owner, registration.repo), number: registration.number,
      head: pullRequest.headRefOid.toLowerCase() === mergeInput.headRefOid.toLowerCase() ? 'match' : 'mismatch' });
    const repository = safeRepo(registration.owner, registration.repo);
    const synchronization = pullRequest.headRefName === candidate.repository.defaultBranch;
    const targetBranch = pullRequest.mergeTarget;
    const deleteBranch = !synchronization && mergeInput.deleteBranch && candidate.repository.autoDeleteBranch !== true;
    if (deleteBranch && pullRequest.isCrossRepository) {
      return reject(400, 'fork からの PR の head ブランチは登録先リポジトリから削除できません', 'fork-delete');
    }
    const initialError = reserved ? null : mergeCandidateError(candidate, mergeInput, registration.number);
    if (initialError) return reject(409, initialError, 'candidate-blocked');

    if (!validBranchName(targetBranch)) return reject(409, 'マージ先のブランチを確認できません', 'target-invalid');
    const retargeted = [];
    const stackedPullRequests = this.stackedPullRequests(candidate, registration.number);
    const branchKept = pullRequest.isCrossRepository === true
      || (!deleteBranch && candidate.repository.autoDeleteBranch !== true);
    for (const child of synchronization || branchKept ? [] : pullRequest.children) {
      if (!Number.isSafeInteger(child.number) || child.number < 1 || !validBranchName(targetBranch)) {
        return reject(409, `#${child.number} の base を安全に付け替えられません。マージはしていません`, 'retarget-invalid');
      }
      const retarget = {
        owner: registration.owner,
        repo: registration.repo,
        number: child.number,
        base: targetBranch,
        fromNumber: registration.number,
        previousBaseRefName: child.baseRefName,
        completed: false,
      };
      const recorded = this.state.recordPullRequestRetarget(retarget);
      const alreadyRecorded = this.state.pullRequestRetargetsForRepo(registration.owner, registration.repo)
        .some((item) => item.number === child.number && item.base === targetBranch &&
          item.fromNumber === registration.number && item.previousBaseRefName === child.baseRefName && item.completed === false);
      if (!recorded && !alreadyRecorded) {
        return reject(500, `#${child.number} の base 変更を保存できませんでした。マージはしていません`, 'retarget-save');
      }
      try {
        await this.state.flushStoreWrite();
      } catch {
        return reject(500, `#${child.number} の base 変更を保存できませんでした。マージはしていません`, 'retarget-persist');
      }
      try {
        await this.tracker.execute([
          'pr', 'edit', String(child.number), '-R', repository, '--base', targetBranch,
        ], { priority: true });
      } catch {
        const completed = completedRetargetStatus(retargeted);
        return reject(502, `#${child.number} の base を ${targetBranch} に付け替えられませんでした。${completed}。マージはしていません`, 'retarget-failed');
      }
      this.state.recordPullRequestRetarget({ ...retarget, completed: true });
      retargeted.push(child);
    }

    const latestCandidate = await this.freshCandidate(registration);
    if (latestCandidate.error) {
      const completed = retargetedBaseStatus(retargeted);
      return reject(409, `${completed}${latestCandidate.error}。マージはしていません`, 'latest-unavailable');
    }
    if (reserved) {
      const reservationStatus = (reservation.kind === 'stack' ? this.stackReservationMergeInput(latestCandidate, reservation) : this.reservationMergeInput(latestCandidate, reservation));
      if (reservationStatus?.userCancelled) return this.cancelStackRun(reservation);
      if (reservationStatus?.cancelled) return this.cancelStackRun(reservation, reservationStatus.reason);
      if (reservationStatus?.halted) return this.cancelHaltedReservation(reservation);
      if (!reservationStatus) {
        const completed = retargetedBaseStatus(retargeted);
        return reject(409, `${completed}レビュー収束後マージの条件が変わりました。予約は保持しています`, 'latest-review-not-ready');
      }
      mergeInput = reservationStatus.input;
    }
    if (deleteBranch && latestCandidate.pullRequest.isCrossRepository) {
      const completed = retargetedBaseStatus(retargeted);
      return reject(400, `${completed}fork からの PR の head ブランチは登録先リポジトリから削除できません`, 'latest-fork-delete');
    }
    if (latestCandidate.pullRequest.mergeTarget !== targetBranch ||
      latestCandidate.pullRequest.headRefName !== pullRequest.headRefName) {
      return reject(409, `${retargetedBaseStatus(retargeted)}マージ先または head ブランチが変わりました。マージはしていません`, 'target-changed');
    }
    this.diagnostics?.record('info', 'merge', 'merge.check', { operation: 'execute', repository, number: registration.number,
      head: latestCandidate.pullRequest.headRefOid.toLowerCase() === mergeInput.headRefOid.toLowerCase() ? 'match' : 'mismatch' });
    const latestError = reserved ? null : mergeCandidateError(latestCandidate, mergeInput, registration.number);
    if (latestError) {
      const completed = retargetedBaseStatus(retargeted);
      return reject(409, `${completed}${latestError}。マージはしていません`, 'latest-blocked');
    }

    const mergeIntent = {
      session_id: registration.session_id,
      owner: registration.owner,
      repo: registration.repo,
      number: registration.number,
      url: pullRequest.url,
      headRefOid: mergeInput.headRefOid,
      headRefName: pullRequest.headRefName,
      defaultBranch: candidate.repository.defaultBranch,
      targetBranch,
      method: mergeInput.method,
      deleteBranch: deleteBranch && latestCandidate.repository.autoDeleteBranch !== true,
      automatic: reserved,
      createdAt: new Date(this.now()).toISOString(),
      stackedPullRequests: stackedPullRequests.map((item) => ({ number: item.number, baseRefName: item.baseRefName })),
    };
    if (!this.state.setPullRequestMergeIntent(mergeIntent)) return reject(500, 'マージ操作を保存できませんでした', 'intent-save');
    // キューに入ったまま落ちても方式と削除の選択を戻せるよう、gh を呼ぶ前にまとめ書きを待たずに保存し終える。
    try {
      await this.state.flushStoreWrite();
    } catch {
      this.state.clearPullRequestMergeIntent(registration.owner, registration.repo, registration.number);
      await this.state.waitForPersistence?.().catch(() => {});
      return reject(500, 'マージ操作を保存できませんでした', 'intent-persist');
    }
    // 保存を待つ間に届いた一括マージの中止は、gh を呼ぶ前に効かせる。
    if (reserved && reservation.kind === 'stack' && this.stackMergeCancellationRequests.has(reservation.runId)) {
      this.state.clearPullRequestMergeIntent(registration.owner, registration.repo, registration.number);
      await this.state.waitForPersistence?.().catch(() => {});
      return this.cancelStackRun(reservation);
    }

    const mergeKey = pullRequestKey(registration.owner, registration.repo, registration.number);
    let outcome;
    this.tracker.executingMerges.add(mergeKey);
    try {
      try {
        await this.tracker.execute([
          'pr', 'merge', String(registration.number), '-R', repository,
          `--${mergeInput.method}`, '--match-head-commit', mergeInput.headRefOid,
        ], { priority: true });
      } catch (error) {
        const failureKind = ghFailureKind(error);
        this.diagnostics?.record('warn', 'merge', 'merge.result',
          { repository, number: registration.number, result: failureKind === 'exit' ? 'gh-exit' : failureKind === 'spawn' ? 'gh-failed' : 'merge-unconfirmed' });
        if (failureKind === 'unconfirmed') {
          return reject(502, 'マージの結果を確認できませんでした。次の取得で確かめます', 'merge-unconfirmed');
        }
        this.state.clearPullRequestMergeIntent(registration.owner, registration.repo, registration.number);
        await this.state.waitForPersistence?.().catch(() => {});
        const completed = retargetedBaseStatus(retargeted);
        return reject(502, `${completed}PR #${registration.number} をマージできませんでした。状態を確認してください`, 'gh-failed');
      }

      this.diagnostics?.record('info', 'merge', 'merge.result',
        { repository, number: registration.number, result: 'gh-success' });
      let view;
      try {
        view = await this.tracker.readPullRequestView(registration.owner, registration.repo, registration.number, { priority: true });
      } catch {
        return reject(502, 'マージの結果を確認できませんでした。次の取得で確かめます', 'merge-unconfirmed');
      }
      this.diagnostics?.record('info', 'merge', 'merge.result',
        { repository, number: registration.number, result: view.state === 'MERGED' ? 'merged' : view.state === 'OPEN' ? 'queued' : 'not-merged' });
      if (view.state === 'OPEN') {
        // マージキューでは方式の指定が効かず、キューの所属も gh から取れないので、意図を持たずに外でのマージとして扱う。
        this.state.clearPullRequestMergeIntent(registration.owner, registration.repo, registration.number);
        this.state.setLastPullRequestMethod(registration.owner, registration.repo, mergeInput.method);
        if (reserved && reservation.kind === 'stack') {
          await this.cancelStackRun(reservation, 'マージキューに入りました');
        } else if (reserved) {
          await this.cancelSavedReservation(
            reservation,
            `PR #${registration.number} はマージキューに入りました。予約を終了し、マージ後は方式不明として知らせてブランチは削除しません。`,
          );
        } else {
          await this.state.flushStoreWrite().catch(() => {});
        }
        return {
          ok: true,
          merged: false,
          queued: true,
          message: `PR #${registration.number} はマージキューに入りました。まだマージされていません。マージされたら外でのマージとして知らせ、ブランチは消しません`,
        };
      }
      if (view.state !== 'MERGED') {
        this.state.clearPullRequestMergeIntent(registration.owner, registration.repo, registration.number);
        await this.state.waitForPersistence?.();
        return reject(409, `PR #${registration.number} はマージされていません。GitHub の状態を確認してください`, 'not-merged');
      }

      this.state.setLastPullRequestMethod(registration.owner, registration.repo, mergeInput.method);
      const mergedAt = view.mergedAt || new Date(this.now()).toISOString();
      // gh の後に MERGED を確かめたので、この操作の意図は方式と削除の根拠にしてよい。
      outcome = await this.processMergedPullRequest(
        registration.owner, registration.repo, view.pullRequest, mergedAt,
        { ...mergeIntent, retargetedNumbers: retargeted.map((item) => item.number) },
      );
    } finally {
      this.tracker.executingMerges.delete(mergeKey);
    }
    await this.tracker.refreshRepoFresh(registration.owner, registration.repo, { priority: true }).catch(() => {});
    await this.state.waitForPersistence?.();
    const history = this.state.mergedPullRequestHistoryForRepo(registration.owner, registration.repo, this.now())
      .find((record) => record.number === registration.number);
    return {
      ok: true,
      merged: true,
      branchDeleted: outcome?.branchDeleted === true,
      warning: outcome?.warning || (history?.headMismatch ? '予約時と異なる head SHA がマージされました' : null),
    };
  }

  async performReservation(registration, input) {
    const reject = (status, error, condition) => {
      this.diagnostics?.record('info', 'merge', 'merge.check', { operation: 'reserve',
        repository: safeRepo(registration.owner, registration.repo), number: registration.number, condition, status });
      return actionResult(status, error);
    };
    const candidate = await this.freshCandidate(registration);
    if (candidate.error) return reject(409, candidate.error, 'candidate-unavailable');
    const pullRequest = candidate.pullRequest;
    this.diagnostics?.record('info', 'merge', 'merge.check', { operation: 'reserve',
      repository: safeRepo(registration.owner, registration.repo), number: registration.number,
      head: pullRequest.headRefOid.toLowerCase() === input.headRefOid.toLowerCase() ? 'match' : 'mismatch' });
    const deleteBranch = pullRequest.headRefName !== candidate.repository.defaultBranch && input.deleteBranch && candidate.repository.autoDeleteBranch !== true;
    if (deleteBranch && pullRequest.isCrossRepository) {
      return reject(400, 'fork からの PR の head ブランチは登録先リポジトリから削除できません', 'fork-delete');
    }
    if (pullRequest.headRefOid.toLowerCase() !== input.headRefOid.toLowerCase()) {
      return reject(409, '表示していた head SHA と現在の head SHA が異なります。状態を確認してください', 'head-mismatch');
    }
    if (pullRequest.mergeMethodFixed && input.method !== pullRequest.mergeMethodFixed) return reject(409, 'マージ方式がマージコミットに固定のため、選んだ方式では実行しません', 'method-fixed');
    if (!candidate.repository.mergeMethods.includes(input.method)) return reject(409, 'このリポジトリでは選んだマージ方式が許可されていません', 'method-unavailable');
    if (this.state.pullRequestMergeReservation(registration.owner, registration.repo, registration.number)) {
      return reject(409, 'この PR にはすでにマージ予約があります', 'already-reserved');
    }

    const targetBranch = this.reservationTarget(candidate);
    if (!validBranchName(targetBranch)) return reject(409, '予約のマージ先を確認できません', 'target-invalid');
    const reservation = {
      targetBranch,
      session_id: registration.session_id,
      owner: registration.owner,
      repo: registration.repo,
      number: registration.number,
      url: pullRequest.url,
      method: input.method,
      deleteBranch,
      createdAt: new Date(this.now()).toISOString(),
    };
    if (!this.state.setPullRequestMergeReservation(reservation)) return reject(500, 'マージ予約を保存できませんでした', 'reservation-save');
    try {
      await this.state.flushStoreWrite();
    } catch {
      this.state.clearPullRequestMergeReservation(registration.owner, registration.repo, registration.number);
      await this.state.waitForPersistence?.().catch(() => {});
      return reject(500, 'マージ予約を保存できませんでした', 'reservation-persist');
    }
    this.diagnostics?.record('info', 'merge', 'merge.reserved',
      { repository: safeRepo(registration.owner, registration.repo), number: registration.number });
    this.state.setLastPullRequestMethod(registration.owner, registration.repo, input.method);
    await this.state.waitForPersistence?.();
    const immediateResult = await this.checkReservation(reservation);
    if (immediateResult) return immediateResult;
    return { ok: true, reserved: true, reservation };
  }

  async performCancelReservation(registration, reason) {
    const reservation = this.state.pullRequestMergeReservation(registration.owner, registration.repo, registration.number);
    if (!reservation) return actionResult(404, 'マージ予約が見つかりません');
    if (reservation.kind === 'stack') return this.cancelStackRun(reservation);
    const message = `${reason}。PR #${registration.number} のレビュー収束後マージの予約を取り消しました。`;
    return this.cancelSavedReservation(reservation, message);
  }

  async cancelSavedReservation(reservation, message) {
    if (reservation.kind === 'stack') return this.cancelStackRun(reservation, message);
    if (!this.state.clearPullRequestMergeReservation(reservation.owner, reservation.repo, reservation.number)) return null;
    this.diagnostics?.record('info', 'merge', 'merge.cancelled',
      { repository: safeRepo(reservation.owner, reservation.repo), number: reservation.number });
    const registrations = this.state.pullRequestRegistrationsForRepo(reservation.owner, reservation.repo)
      .filter((record) => record.number === reservation.number);
    const sessionIds = unique([...registrations.map((record) => record.session_id), reservation.session_id]);
    this.state.recordPullRequestMergeReservationNotice({
      owner: reservation.owner,
      repo: reservation.repo,
      number: reservation.number,
      url: reservation.url,
      at: new Date(this.now()).toISOString(),
      message,
    });
    this.answerDelivery?.notifySessions(sessionIds, message);
    await this.state.waitForPersistence?.();
    return { ok: true, cancelled: true, message };
  }

  async checkReservations(owner = null, repo = null) {
    const reservations = this.state.pullRequestMergeReservations().filter((record) => (
      (!owner || record.owner.toLowerCase() === owner.toLowerCase()) &&
      (!repo || record.repo.toLowerCase() === repo.toLowerCase())
    ));
    const repositories = new Map();
    for (const reservation of reservations) {
      const key = safeRepo(reservation.owner, reservation.repo).toLowerCase();
      const group = repositories.get(key) || { owner: reservation.owner, repo: reservation.repo, reservations: [] };
      group.reservations.push(reservation);
      repositories.set(key, group);
    }
    for (const group of repositories.values()) {
      const key = safeRepo(group.owner, group.repo).toLowerCase();
      const result = await this.withRepositoryTryLock(group.owner, group.repo, async () => {
        this.repositoryReservationChecks.add(key);
        try {
          for (const reservation of group.reservations) {
            await this.withPullRequestLock(reservation.owner, reservation.repo, reservation.number, () => this.checkReservation(reservation));
          }
        } finally {
          this.repositoryReservationChecks.delete(key);
        }
      });
      if (!result.acquired && !this.repositoryReservationChecks.has(key)) {
        this.pendingRepositoryReservationChecks.set(key, { owner: group.owner, repo: group.repo });
      }
    }
  }

  async checkReservation(original) {
    const reservation = this.state.pullRequestMergeReservation(original.owner, original.repo, original.number);
    if (!reservation) return null;
    const registration = this.state.pullRequestRegistrationForSession(reservation.session_id, reservation.owner, reservation.repo, reservation.number);
    if (!registration) return reservation.kind === 'stack' ? this.cancelStackRun(reservation, '登録が消えました') : null;
    if (reservation.kind === 'stack') {
      const remaining = this.stackReservations(reservation);
      for (const member of remaining) {
        const record = this.state.pullRequestRegistrationForSession(member.session_id, member.owner, member.repo, member.number);
        if (!record) return this.cancelStackRun(member, '登録が消えました');
        const status = this.stackReservationMergeInput(this.tracker.mergeCandidate(record), member);
        if (status?.userCancelled) return this.cancelStackRun(member);
        if (status?.cancelled) return this.cancelStackRun(member, status.reason);
        if (this.state.pullRequestMergeIntent(member.owner, member.repo, member.number)) return null;
      }
      if (remaining[0]?.number !== reservation.number) return null;
    }
    const candidate = this.tracker.mergeCandidate(registration);
    const reservationStatus = (reservation.kind === 'stack' ? this.stackReservationMergeInput(candidate, reservation) : this.reservationMergeInput(candidate, reservation));
    if (reservationStatus?.userCancelled) return this.cancelStackRun(reservation);
    if (reservationStatus?.cancelled) return this.cancelStackRun(reservation, reservationStatus.reason);
    if (reservationStatus?.halted) return this.cancelHaltedReservation(reservation);
    if (!reservationStatus) return null;
    return this.performMerge(registration, reservationStatus.input, true);
  }

  reservationTarget(candidate) {
    const seen = new Set();
    while (candidate?.pullRequest && !seen.has(candidate.pullRequest.number)) {
      const pullRequest = candidate.pullRequest;
      seen.add(pullRequest.number);
      if (pullRequest.mergeTarget) return pullRequest.mergeTarget;
      if (!pullRequest.parentNumber) break;
      candidate = this.tracker.mergeCandidate({ ...candidate.registration, number: pullRequest.parentNumber });
    }
    return null;
  }

  reservationMergeInput(candidate, reservation) {
    const pullRequest = candidate?.pullRequest;
    const waiting = (condition) => {
      const key = pullRequestKey(reservation.owner, reservation.repo, reservation.number);
      if (this.diagnosticReservationConditions.get(key) !== condition) {
        this.diagnosticReservationConditions.set(key, condition);
        this.diagnostics?.record('info', 'merge', 'merge.check', { operation: 'reservation',
          repository: safeRepo(reservation.owner, reservation.repo), number: reservation.number, condition,
          head: pullRequest && isCompleteCommitSha(pullRequest.review?.evaluation.latest.sha)
            ? (pullRequest.headRefOid.toLowerCase() === pullRequest.review.evaluation.latest.sha.toLowerCase() ? 'match' : 'mismatch') : 'missing' });
      }
      return null;
    };
    if (!candidate?.repository?.listAvailable || !candidate.repository.configAvailable || !pullRequest) return waiting('repository-unavailable');
    const review = reservationReview(pullRequest.review.evaluation);
    if (review.action === 'cancel') {
      waiting(review.condition);
      return { halted: true };
    }
    if (['review-deferred', 'review-conflict'].includes(review.condition)) return waiting(review.condition);
    if (pullRequest.mergeTarget !== (reservation.targetBranch || candidate.repository.defaultBranch)) return waiting('target-changed');
    if (review.action !== 'merge') return waiting(review.condition);
    if (pullRequest.ci !== 'pass') return waiting('ci-not-pass');
    if (!['approved', 'none'].includes(pullRequest.githubReview)) return waiting('review-unapproved');
    const input = { headRefOid: review.matchSha, method: reservation.method, deleteBranch: reservation.deleteBranch };
    if (mergeCandidateError(candidate, input, reservation.number)) return waiting('candidate-blocked');
    waiting('ready');
    return { input };
  }

  cancelHaltedReservation(reservation) {
    const message = `PR #${reservation.number} のクロスレビューが halted になったため、レビュー収束後マージの予約を取り消しました。`;
    return this.cancelSavedReservation(reservation, message);
  }

  async deleteRemoteBranch(owner, repo, branch, expectedHeadRefOid) {
    if (!validRepositoryPart(owner) || !validRepositoryPart(repo) || !validBranchName(branch) ||
      !isCompleteCommitSha(expectedHeadRefOid)) throw new Error('invalid branch deletion');
    const repository = safeRepo(owner, repo);
    const currentHeadRefOid = await this.tracker.readRemoteBranchHead(repository, branch, { priority: true });
    if (!currentHeadRefOid) return 'missing';
    if (currentHeadRefOid !== expectedHeadRefOid.toLowerCase()) return 'changed';
    try {
      await this.tracker.deleteRemoteBranchIfHeadMatches(owner, repo, branch, expectedHeadRefOid);
      return 'deleted';
    } catch (error) {
      try {
        const latestHeadRefOid = await this.tracker.readRemoteBranchHead(repository, branch, { priority: true });
        if (!latestHeadRefOid) return 'missing';
        if (latestHeadRefOid !== expectedHeadRefOid.toLowerCase()) return 'changed';
      } catch {}
      throw error;
    }
  }

  notifyMerge(owner, repo, pullRequest, targetBranch, method, stackedPullRequests, sessionIds, warning = null, headMismatch = null, branchKept = false, retargetedChildren = new Set()) {
    const automatic = method ? '' : '方式は取得できませんでした。';
    const methodText = method ? `方式: ${METHOD_LABELS[method] || method}。` : automatic;
    const lines = [`PR #${pullRequest.number} が ${targetBranch} に入りました。${methodText}`];
    if (headMismatch) lines.push(`予約時の head SHA ${headMismatch.reserved} とマージされた head SHA ${headMismatch.merged} が異なります。予約の取り消しより先にマージされました。`);
    const squashed = ['squash', 'rebase'].includes(method);
    // 前の実行で付け替えた子は、ブランチを残しても base が移っているので積み直しを頼む。
    const keptChildren = branchKept ? stackedPullRequests.filter((stacked) => !retargetedChildren.has(stacked.number)) : [];
    for (const stacked of keptChildren) {
      lines.push(`${pullRequest.headRefName} は残したので、#${stacked.number} の base は ${pullRequest.headRefName} のままです。`);
    }
    if (keptChildren.length && squashed) {
      lines.push(`次に ${pullRequest.headRefName} を ${targetBranch} へマージするときは、同じ変更が再び差分に入らないようマージコミットを推奨します。`);
    }
    if (squashed) {
      for (const stacked of stackedPullRequests.filter((item) => !keptChildren.includes(item))) {
        if (validBranchName(stacked.baseRefName)) {
          lines.push(`#${stacked.number} を \`git rebase --onto ${targetBranch} ${stacked.baseRefName}\` で積み直して push する。`);
        }
      }
    }
    if (warning) lines.push(warning);
    const childSessions = stackedPullRequests.flatMap((stacked) => (
      this.state.pullRequestRegistrationsForRepo(owner, repo).filter((record) => record.number === stacked.number).map((record) => record.session_id)
    ));
    const recipients = unique([...sessionIds, ...childSessions]);
    this.answerDelivery?.notifySessions(recipients, lines.join('\n'));
    return recipients;
  }

  runLocalGit(root, args) {
    return new Promise((resolve, reject) => {
      this.gitExecFileImpl('git', ['-C', root, ...args], {
        encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
  }

  scheduleDefaultBranchUpdate(owner, repo, defaultBranch, sessionIds, registrations) {
    // マージの応答とロックの解放を git の実行時間で遅らせない。
    const pending = new Promise((resolve) => setImmediate(resolve))
      .then(() => this.updateDefaultBranchWorktrees(owner, repo, defaultBranch, sessionIds, registrations))
      .catch(() => {})
      .finally(() => this.localUpdates.delete(pending));
    this.localUpdates.add(pending);
  }

  async updateDefaultBranchWorktrees(owner, repo, defaultBranch, sessionIds, registrations) {
    const worktrees = new Map();
    const roots = new Set();
    const pathKey = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
    const execFileImpl = (file, args, options, callback) => this.gitExecFileImpl(file, args, {
      ...options, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, callback);
    for (const record of registrations) {
      const root = await matchingRepositoryCheckout(record.cwd, { owner, repo }, { execFileImpl });
      if (!root || roots.has(pathKey(root))) continue;
      roots.add(pathKey(root));
      for (const worktree of await listWorktrees(root, execFileImpl)) {
        if (worktree.branch === defaultBranch && !worktree.prunable) worktrees.set(pathKey(worktree.path), worktree.path);
      }
    }
    const lines = [];
    for (const [key, root] of worktrees) {
      const pending = (this.worktreeUpdates.get(key) || Promise.resolve())
        .then(() => this.updateDefaultBranchWorktree(root, owner, repo, defaultBranch));
      this.worktreeUpdates.set(key, pending);
      let result;
      try {
        result = await pending;
      } finally {
        if (this.worktreeUpdates.get(key) === pending) this.worktreeUpdates.delete(key);
      }
      if (result === 'switched') continue;
      this.diagnostics?.record(result === 'updated' ? 'info' : 'warn', 'merge', 'merge.local-update',
        { repository: safeRepo(owner, repo), result });
      if (result === 'updated') lines.push(`ローカルの ${defaultBranch} を最新にしました: ${root}`);
      else if (result === 'dirty') lines.push(`${root} は未コミットの変更があるため ${defaultBranch} を更新しませんでした`);
      else if (result === 'no-remote') lines.push(`${root} はリポジトリに一致する remote がないため ${defaultBranch} を更新しませんでした`);
      else lines.push(`${root} の ${defaultBranch} を更新できませんでした(fast-forward できないか、取得に失敗しました)`);
    }
    if (lines.length) this.answerDelivery?.notifySessions(sessionIds, lines.join('\n'));
  }

  // 追跡していないファイルは見ない。衝突するときは merge --ff-only が失敗する。
  async localWorktreeState(root, defaultBranch) {
    const branch = await this.runLocalGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch.trim() !== defaultBranch) return 'switched';
    const status = await this.runLocalGit(root, ['status', '--porcelain', '--untracked-files=no']);
    return status.trim() ? 'dirty' : 'clean';
  }

  async updateDefaultBranchWorktree(root, owner, repo, defaultBranch) {
    try {
      // 探索後に開発者が別のブランチへ切り替えた場合は、そのブランチを更新しない。
      const before = await this.localWorktreeState(root, defaultBranch);
      if (before !== 'clean') return before;
      const remoteUrls = await this.runLocalGit(root, ['config', '--get-regexp', '^remote\\..*\\.url$'])
        .catch((error) => { if (error.code === 1) return ''; throw error; });
      const remotes = gitRemotes(remoteUrls);
      const remote = remotes.find((item) => item.owner?.toLowerCase() === owner.toLowerCase() && item.repo?.toLowerCase() === repo.toLowerCase());
      if (!remote || !remote.name || remote.name.startsWith('-')) return 'no-remote';
      // FETCH_HEAD は開発者の fetch で書き換わるので、専用の ref に取得して取り込む SHA を固定する。
      const fetchedRef = `refs/agent-cockpit/default-branch-${randomUUID()}`;
      try {
        await this.runLocalGit(root, ['fetch', '--no-write-fetch-head', '--', remote.name, `+refs/heads/${defaultBranch}:${fetchedRef}`]);
        const fetchedSha = (await this.runLocalGit(root, ['rev-parse', '--verify', `${fetchedRef}^{commit}`])).trim();
        if (!isCompleteCommitSha(fetchedSha)) return 'failed';
        // 取得を待つ間に切り替えや変更が起きることがあるので、取り込む直前に確かめ直す。
        const after = await this.localWorktreeState(root, defaultBranch);
        if (after !== 'clean') return after;
        await this.runLocalGit(root, ['merge', '--ff-only', fetchedSha]);
        return 'updated';
      } finally {
        await this.runLocalGit(root, ['update-ref', '-d', fetchedRef]).catch(() => {});
      }
    } catch {
      return 'failed';
    }
  }

  async handleDetectedMerge(event) {
    const { owner, repo, pullRequest, mergedAt, registrations = [] } = event;
    if (!pullRequest) return null;
    const mergeKey = pullRequestKey(owner, repo, pullRequest.number);
    if (this.handledMerges.has(mergeKey)) return this.mergeOutcomes.get(mergeKey) || null;
    this.handledMerges.add(mergeKey);
    const reservation = event.reservation || this.state.pullRequestMergeReservation(owner, repo, pullRequest.number);
    const mergeIntent = this.state.pullRequestMergeIntent(owner, repo, pullRequest.number);
    const confirmedIntent = event.confirmedIntent || (mergeIntent && isCompleteCommitSha(mergeIntent.headRefOid) &&
      mergeIntent.headRefOid.toLowerCase() === pullRequest.headRefOid?.toLowerCase() ? mergeIntent : null);
    const expectedHeadRefOid = confirmedIntent?.headRefOid || null;
    const headMismatch = expectedHeadRefOid && pullRequest.headRefOid.toLowerCase() !== expectedHeadRefOid.toLowerCase()
      ? { reserved: expectedHeadRefOid, merged: pullRequest.headRefOid }
      : null;
    if (reservation?.kind === 'stack' && (!confirmedIntent || headMismatch)) {
      await this.cancelStackRun(reservation, headMismatch ? 'head が変わりました' : '外部でマージされました');
    }
    this.state.clearPullRequestMergeReservation(owner, repo, pullRequest.number);
    this.state.clearPullRequestMergeIntent(owner, repo, pullRequest.number);

    const repositoryState = this.tracker.repositoryState(owner, repo);
    // 初回の取得では repositoryState がまだ無いので、取得した event.defaultBranch で補う。
    const defaultBranch = confirmedIntent?.defaultBranch || repositoryState?.defaultBranch || event.defaultBranch;
    const synchronization = pullRequest.headRefName === defaultBranch;
    const targetBranch = validBranchName(pullRequest.baseRefName) ? pullRequest.baseRefName : defaultBranch;
    const savedStackedByNumber = new Map([
      ...(confirmedIntent?.stackedPullRequests || []),
    ].map((item) => [item.number, item]));
    const retargeted = this.state.pullRequestRetargetsForRepo(owner, repo)
      .filter((record) => record.fromNumber === pullRequest.number && record.completed !== false);
    const stackedByNumber = new Map();
    const selectedStackedPullRequests = synchronization ? [] : [...savedStackedByNumber.values(), ...(event.stackedPullRequests || [])];
    for (const stacked of selectedStackedPullRequests) {
      const prior = retargeted.find((record) => record.number === stacked.number);
      const saved = savedStackedByNumber.get(stacked.number);
      stackedByNumber.set(stacked.number, {
        number: stacked.number,
        baseRefName: prior?.previousBaseRefName || saved?.baseRefName || stacked.baseRefName,
        headRefName: stacked.headRefName || repositoryState?.openPullRequests.find((item) => item.number === stacked.number)?.headRefName,
      });
    }
    const stackedPullRequests = [...stackedByNumber.values()].sort((left, right) => left.number - right.number);
    const branchKept = !synchronization && confirmedIntent?.deleteBranch === false
      && (pullRequest.isCrossRepository === true || repositoryState?.autoDeleteBranch !== true);
    // 予約は条件待ちに戻ってから再実行されることがあるので、前の実行で付け替えた記録も結果に含める。
    const retargetedNumbers = !synchronization && confirmedIntent
      ? [...new Set([...(confirmedIntent.retargetedNumbers || []), ...retargeted.map((record) => record.number)])].sort((left, right) => left - right)
      : [];
    const retargetedChildren = new Set([...retargetedNumbers, ...retargeted.map((record) => record.number)]);
    let warning = null;
    let branchDeleted = false;
    const deleteBranch = !synchronization && repositoryState?.autoDeleteBranch !== true
      && confirmedIntent?.deleteBranch === true;
    if (deleteBranch && pullRequest.isCrossRepository) {
      warning = [warning, 'fork からの PR の head ブランチは登録先リポジトリから削除しませんでした'].filter(Boolean).join('。');
    } else if (deleteBranch && !headMismatch && validBranchName(pullRequest.headRefName)) {
      try {
        const deletion = await this.deleteRemoteBranch(owner, repo, pullRequest.headRefName, pullRequest.headRefOid);
        branchDeleted = deletion === 'deleted' || deletion === 'missing';
        if (deletion === 'changed') warning = `PR はマージしましたが、head が更新されたためリモートブランチ ${pullRequest.headRefName} を削除しませんでした`;
      } catch {
        warning = [warning, `PR はマージしましたが、リモートブランチ ${pullRequest.headRefName} を削除できませんでした`].filter(Boolean).join('。');
      }
    }
    const method = confirmedIntent?.method || null;
    const automaticResult = confirmedIntent?.automatic === true ? {
      branchDeleted,
      autoDeleteBranch: !synchronization && repositoryState?.autoDeleteBranch === true && !pullRequest.isCrossRepository,
      retargetedBase: retargetedNumbers.length ? (confirmedIntent.targetBranch || confirmedIntent.defaultBranch) : null,
      retargetedNumbers,
      warning,
    } : undefined;
    this.state.recordMergedPullRequest({
      owner,
      repo,
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      mergedAt,
      method,
      automatic: confirmedIntent?.automatic === true,
      reservedHeadRefOid: expectedHeadRefOid,
      mergedHeadRefOid: pullRequest.headRefOid || null,
      mergedHead: { ...confirmedMergedHead(pullRequest), ...(branchKept ? { branchKept: true } : {}) },
      headMismatch: Boolean(headMismatch),
      ...(automaticResult ? { automaticResult } : {}),
    }, this.now());
    const sessionIds = [
      ...registrations.map((record) => record.session_id),
      reservation?.session_id,
      mergeIntent?.session_id,
    ].filter(Boolean);
    const recipients = this.notifyMerge(owner, repo, pullRequest, targetBranch || '既定ブランチ', method, stackedPullRequests, sessionIds, warning, headMismatch, branchKept, retargetedChildren);
    await this.state.waitForPersistence?.();
    if (reservation?.kind === 'stack' && confirmedIntent && !headMismatch && !this.stackReservations(reservation).length &&
      !this.state.stackMergeResults.has(reservation.runId)) {
      this.state.recordStackMergeResult({ owner, repo, runId: reservation.runId, at: new Date(this.now()).toISOString(),
        message: `スタックの ${reservation.total} 件を ${reservation.targetBranch} にマージしました` });
      await this.state.waitForPersistence?.();
    }
    const outcome = { branchDeleted, warning };
    this.mergeOutcomes.set(mergeKey, outcome);
    if (this.state.getDisplayPreferences().pullDefaultBranchAfterMerge === true && validBranchName(defaultBranch) && pullRequest.baseRefName === defaultBranch) {
      this.scheduleDefaultBranchUpdate(owner, repo, defaultBranch, recipients,
        [...this.state.pullRequestRegistrationsForRepo(owner, repo), ...registrations]);
    }
    return outcome;
  }

  async handleDetectedClose({ owner, repo, number, reservation, mergeIntent, registrations = [] }) {
    if (reservation?.kind === 'stack') {
      await this.cancelStackRun(reservation, 'PR がクローズされました');
      this.state.clearPullRequestMergeIntent(owner, repo, number);
      return;
    }
    this.state.clearPullRequestMergeReservation(owner, repo, number);
    this.state.clearPullRequestMergeIntent(owner, repo, number);
    const sessionIds = [...registrations.map((record) => record.session_id), reservation?.session_id, mergeIntent?.session_id].filter(Boolean);
    if (reservation) {
      await this.cancelledReservationNotice(reservation, `PR #${number} がクローズされたため、レビュー収束後マージの予約を取り消しました。`, sessionIds);
    } else if (mergeIntent) {
      this.answerDelivery?.notifySessions(sessionIds, `PR #${number} がクローズされたため、マージ操作は終了しました。`);
    }
    await this.state.waitForPersistence?.();
  }

  async cancelledReservationNotice(reservation, message, sessionIds = []) {
    this.state.recordPullRequestMergeReservationNotice({
      owner: reservation.owner,
      repo: reservation.repo,
      number: reservation.number,
      url: reservation.url,
      at: new Date(this.now()).toISOString(),
      message,
    });
    this.answerDelivery?.notifySessions(unique([...sessionIds, reservation.session_id]), message);
    await this.state.waitForPersistence?.();
  }
}

module.exports = { PullRequestMergeManager };
