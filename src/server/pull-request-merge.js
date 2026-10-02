'use strict';

const { validBranchName, validRepositoryPart } = require('./pull-request-utils');
const { safeRepo } = require('./pull-requests');

const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const METHODS = new Set(['merge', 'squash', 'rebase']);
const RESERVATION_POLL_MS = 15_000;
const METHOD_LABELS = { merge: 'マージコミット', squash: 'スカッシュ', rebase: 'リベース' };

function actionResult(status, error) {
  return { ok: false, status, error };
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

function mergeCandidateError(candidate, input, number) {
  const pullRequest = candidate.pullRequest;
  if (pullRequest.headRefOid.toLowerCase() !== input.headRefOid.toLowerCase()) {
    return '表示していた head SHA と現在の head SHA が異なります。状態を確認してください';
  }
  if (!candidate.repository.mergeMethods.includes(input.method)) return 'このリポジトリでは選んだマージ方式が許可されていません';
  if (!pullRequest.canMerge) return `PR #${number} はマージできません: ${pullRequest.blocker || '状態を確認できません'}`;
  if (pullRequest.baseRefName !== candidate.repository.defaultBranch || pullRequest.effectiveBase !== candidate.repository.defaultBranch) {
    return `PR #${number} は既定ブランチ ${candidate.repository.defaultBranch} を base にしていません`;
  }
  return null;
}

class PullRequestMergeManager {
  constructor({ state, tracker, answerDelivery, now = Date.now, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, reservationPollMs = RESERVATION_POLL_MS } = {}) {
    this.state = state;
    this.tracker = tracker;
    this.answerDelivery = answerDelivery;
    this.now = now;
    this.setInterval = setIntervalImpl;
    this.clearInterval = clearIntervalImpl;
    this.reservationPollMs = reservationPollMs;
    this.inFlight = new Map();
    this.timer = null;
    this.polling = false;
  }

  start() {
    if (this.timer) return;
    this.timer = this.setInterval(() => { void this.checkReservations(); }, this.reservationPollMs);
    this.timer.unref?.();
  }

  close() {
    if (this.timer) this.clearInterval(this.timer);
    this.timer = null;
  }

  async withPullRequestLock(owner, repo, number, operation) {
    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
    if (this.inFlight.has(key)) return actionResult(409, `PR #${number} の操作が進行中です`);
    const pending = Promise.resolve().then(operation);
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.inFlight.get(key) === pending) this.inFlight.delete(key);
    }
  }

  registeredPullRequest(number, registrationKey) {
    if (!Number.isSafeInteger(number) || number < 1) return null;
    const registration = this.state.pullRequestRegistration(number, registrationKey);
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
    if (!SHA_PATTERN.test(input.headRefOid || '') || !METHODS.has(input.method) || typeof input.deleteBranch !== 'boolean') {
      return Promise.resolve(actionResult(400, 'マージ内容を確認してください'));
    }
    return this.withPullRequestLock(registration.owner, registration.repo, registration.number, () => (
      this.performMerge(registration, input)
    ));
  }

  reserve(input) {
    const registration = this.registeredPullRequest(input.number, input.registration_key);
    if (!registration) return Promise.resolve(actionResult(404, '記録された PR が見つかりません'));
    if (!SHA_PATTERN.test(input.headRefOid || '') || !METHODS.has(input.method) || typeof input.deleteBranch !== 'boolean') {
      return Promise.resolve(actionResult(400, 'マージ予約の内容を確認してください'));
    }
    return this.withPullRequestLock(registration.owner, registration.repo, registration.number, () => (
      this.performReservation(registration, input)
    ));
  }

  cancelReservation(input) {
    const registration = this.registeredPullRequest(input.number, input.registration_key);
    if (!registration) return Promise.resolve(actionResult(404, '記録された PR が見つかりません'));
    return this.withPullRequestLock(registration.owner, registration.repo, registration.number, () => (
      this.performCancelReservation(registration, '開発者がダッシュボードからマージ予約を取り消した')
    ));
  }

  async freshCandidate(registration) {
    let refreshed;
    try {
      refreshed = await this.tracker.refreshRepoFresh(registration.owner, registration.repo);
    } catch {
      return { error: 'GitHub から PR の状態を取り直せませんでした' };
    }
    if (refreshed?.error) return { error: `GitHub から PR の状態を取り直せませんでした。${refreshed.error}` };
    const candidate = this.tracker.mergeCandidate(registration);
    if (!candidate?.pullRequest) return { error: `PR #${registration.number} はオープンの記録済みスタックにありません` };
    if (!validBranchName(candidate.repository.defaultBranch) || !validBranchName(candidate.pullRequest.headRefName)) {
      return { error: '既定ブランチまたは head ブランチ名を安全に確認できません' };
    }
    return candidate;
  }

  async performMerge(registration, input) {
    if (this.state.pullRequestMergeReservation(registration.owner, registration.repo, registration.number)) {
      return actionResult(409, 'この PR にはマージ予約があります。先に予約を取り消してください');
    }
    const candidate = await this.freshCandidate(registration);
    if (candidate.error) return actionResult(409, candidate.error);
    const pullRequest = candidate.pullRequest;
    const repository = safeRepo(registration.owner, registration.repo);
    const initialError = mergeCandidateError(candidate, input, registration.number);
    if (initialError) return actionResult(409, initialError);

    const retargeted = [];
    const stackedPullRequests = pullRequest.children.map((child) => ({
      number: child.number,
      baseRefName: child.baseRefName,
      headRefName: child.headRefName,
    }));
    for (const child of pullRequest.children) {
      if (!Number.isSafeInteger(child.number) || child.number < 1 || !validBranchName(candidate.repository.defaultBranch)) {
        return actionResult(409, `#${child.number} の base を安全に付け替えられません。マージはしていません`);
      }
      try {
        await this.tracker.execute([
          'pr', 'edit', String(child.number), '-R', repository, '--base', candidate.repository.defaultBranch,
        ]);
      } catch {
        const completed = retargeted.length ? `完了: ${retargeted.map((item) => `#${item.number}`).join('、')} の base を付け替え済み` : 'base の付け替えは未完了';
        return actionResult(502, `#${child.number} の base を ${candidate.repository.defaultBranch} に付け替えられませんでした。${completed}。マージはしていません`);
      }
      this.state.recordPullRequestRetarget({
        owner: registration.owner,
        repo: registration.repo,
        number: child.number,
        base: candidate.repository.defaultBranch,
        fromNumber: registration.number,
      });
      retargeted.push(child);
    }

    const latestCandidate = await this.freshCandidate(registration);
    if (latestCandidate.error) {
      const completed = retargeted.length ? `#${retargeted.map((item) => item.number).join('、')} の base は付け替え済みです。` : '';
      return actionResult(409, `${completed}${latestCandidate.error}。マージはしていません`);
    }
    const latestError = mergeCandidateError(latestCandidate, input, registration.number);
    if (latestError) {
      const completed = retargeted.length ? `#${retargeted.map((item) => item.number).join('、')} の base は付け替え済みです。` : '';
      return actionResult(409, `${completed}${latestError}。マージはしていません`);
    }

    try {
      await this.tracker.execute([
        'pr', 'merge', String(registration.number), '-R', repository,
        `--${input.method}`, '--match-head-commit', pullRequest.headRefOid,
      ]);
    } catch {
      const completed = retargeted.length ? `#${retargeted.map((item) => item.number).join('、')} の base は付け替え済みです。` : '';
      return actionResult(502, `${completed}PR #${registration.number} をマージできませんでした。状態を確認してください`);
    }

    const mergedAt = new Date(this.now()).toISOString();
    this.state.recordMergedPullRequest({
      owner: registration.owner,
      repo: registration.repo,
      number: registration.number,
      title: pullRequest.title,
      url: pullRequest.url,
      mergedAt,
      method: input.method,
      automatic: false,
    }, this.now());
    this.state.setLastPullRequestMethod(registration.owner, registration.repo, input.method);
    this.state.clearPullRequestMergeReservation(registration.owner, registration.repo, registration.number);

    let branchDeleted = false;
    let warning = null;
    if (input.deleteBranch) {
      try {
        await this.deleteRemoteBranch(registration.owner, registration.repo, pullRequest.headRefName);
        branchDeleted = true;
      } catch {
        warning = `PR はマージしましたが、リモートブランチ ${pullRequest.headRefName} を削除できませんでした`;
      }
    }
    const mergeSessions = this.state.pullRequestRegistrationsForRepo(registration.owner, registration.repo)
      .filter((record) => record.number === registration.number)
      .map((record) => record.session_id);
    this.notifyMerge(registration.owner, registration.repo, pullRequest, candidate.repository.defaultBranch, input.method, stackedPullRequests, mergeSessions, warning);
    await this.tracker.refreshRepo(registration.owner, registration.repo).catch(() => {});
    await this.state.waitForPersistence?.();
    return { ok: true, merged: true, branchDeleted, warning };
  }

  async performReservation(registration, input) {
    const candidate = await this.freshCandidate(registration);
    if (candidate.error) return actionResult(409, candidate.error);
    const pullRequest = candidate.pullRequest;
    const repository = safeRepo(registration.owner, registration.repo);
    if (pullRequest.headRefOid.toLowerCase() !== input.headRefOid.toLowerCase()) {
      return actionResult(409, '表示していた head SHA と現在の head SHA が異なります。状態を確認してください');
    }
    if (!candidate.repository.mergeMethods.includes(input.method)) return actionResult(409, 'このリポジトリでは選んだマージ方式が許可されていません');
    if (pullRequest.blocker !== 'CI 実行中' || !['approved', 'none'].includes(pullRequest.review)) {
      return actionResult(409, `CI 実行中だけが理由の PR ではありません: ${pullRequest.blocker || 'マージ可能な状態です'}`);
    }
    if (this.state.pullRequestMergeReservation(registration.owner, registration.repo, registration.number)) {
      return actionResult(409, 'この PR にはすでにマージ予約があります');
    }

    const reservation = {
      session_id: registration.session_id,
      owner: registration.owner,
      repo: registration.repo,
      number: registration.number,
      url: pullRequest.url,
      headRefOid: pullRequest.headRefOid,
      headRefName: pullRequest.headRefName,
      defaultBranch: candidate.repository.defaultBranch,
      method: input.method,
      deleteBranch: input.deleteBranch,
      createdAt: new Date(this.now()).toISOString(),
      stackedPullRequests: pullRequest.children.map((child) => ({ number: child.number, baseRefName: child.baseRefName })),
    };
    if (!this.state.setPullRequestMergeReservation(reservation)) return actionResult(500, 'マージ予約を保存できませんでした');
    try {
      await this.state.waitForPersistence?.();
    } catch {
      this.state.clearPullRequestMergeReservation(registration.owner, registration.repo, registration.number);
      await this.state.waitForPersistence?.().catch(() => {});
      return actionResult(500, 'マージ予約を保存できませんでした');
    }
    try {
      await this.tracker.execute([
        'pr', 'merge', String(registration.number), '-R', repository,
        '--auto', `--${input.method}`, '--match-head-commit', pullRequest.headRefOid,
      ]);
    } catch {
      this.state.clearPullRequestMergeReservation(registration.owner, registration.repo, registration.number);
      await this.state.waitForPersistence?.().catch(() => {});
      return actionResult(502, `PR #${registration.number} のマージを予約できませんでした`);
    }
    this.state.setLastPullRequestMethod(registration.owner, registration.repo, input.method);
    await this.state.waitForPersistence?.();
    return { ok: true, reserved: true, reservation };
  }

  async performCancelReservation(registration, reason) {
    const reservation = this.state.pullRequestMergeReservation(registration.owner, registration.repo, registration.number);
    if (!reservation) return actionResult(404, 'マージ予約が見つかりません');
    const repository = safeRepo(registration.owner, registration.repo);
    try {
      await this.tracker.execute(['pr', 'merge', String(registration.number), '-R', repository, '--disable-auto']);
    } catch {
      await this.tracker.refreshRepoFresh(registration.owner, registration.repo).catch(() => {});
      if (!this.state.pullRequestMergeReservation(registration.owner, registration.repo, registration.number)) {
        return actionResult(409, '取り消しより先に PR がマージされました。状態と通知を確認してください');
      }
      return actionResult(502, `PR #${registration.number} のマージ予約を取り消せませんでした`);
    }

    let refreshed;
    try {
      refreshed = await this.tracker.refreshRepoFresh(registration.owner, registration.repo);
    } catch {
      return actionResult(502, `PR #${registration.number} の予約を取り消しましたが、状態を再確認できませんでした`);
    }
    if (refreshed?.error) return actionResult(502, `PR #${registration.number} の予約を取り消しましたが、状態を再確認できませんでした`);
    if (!this.state.pullRequestMergeReservation(registration.owner, registration.repo, registration.number)) {
      return actionResult(409, '取り消しより先に PR がマージされました。状態と通知を確認してください');
    }
    this.state.clearPullRequestMergeReservation(registration.owner, registration.repo, registration.number);
    const sessionIds = this.state.pullRequestRegistrationsForRepo(registration.owner, registration.repo)
      .filter((record) => record.number === registration.number)
      .map((record) => record.session_id);
    this.answerDelivery?.notifySessions(unique(sessionIds), `${reason}。PR #${registration.number} は自動マージされません。`);
    await this.state.waitForPersistence?.();
    return { ok: true, cancelled: true };
  }

  async checkReservations() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const reservation of this.state.pullRequestMergeReservations()) {
        await this.withPullRequestLock(reservation.owner, reservation.repo, reservation.number, () => this.checkReservation(reservation));
      }
    } finally {
      this.polling = false;
    }
  }

  async checkReservation(original) {
    let reservation = this.state.pullRequestMergeReservation(original.owner, original.repo, original.number);
    if (!reservation) return null;
    let refreshed;
    try {
      refreshed = await this.tracker.refreshRepoFresh(reservation.owner, reservation.repo);
    } catch {
      return null;
    }
    if (refreshed?.error) return null;
    reservation = this.state.pullRequestMergeReservation(original.owner, original.repo, original.number);
    if (!reservation) return null;
    const repository = this.tracker.repositories.get(`${reservation.owner.toLowerCase()}/${reservation.repo.toLowerCase()}`);
    const pullRequest = repository?.openPullRequests.find((item) => item.number === reservation.number);
    if (!pullRequest || pullRequest.headRefOid.toLowerCase() === reservation.headRefOid.toLowerCase()) return null;

    try {
      await this.tracker.execute([
        'pr', 'merge', String(reservation.number), '-R', safeRepo(reservation.owner, reservation.repo), '--disable-auto',
      ]);
    } catch {
      await this.tracker.refreshRepoFresh(reservation.owner, reservation.repo).catch(() => {});
      if (!this.state.pullRequestMergeReservation(reservation.owner, reservation.repo, reservation.number)) return null;
      return null;
    }

    let confirmed;
    try {
      confirmed = await this.tracker.refreshRepoFresh(reservation.owner, reservation.repo);
    } catch {
      return null;
    }
    if (confirmed?.error) return null;
    if (!this.state.pullRequestMergeReservation(reservation.owner, reservation.repo, reservation.number)) return null;
    this.state.clearPullRequestMergeReservation(reservation.owner, reservation.repo, reservation.number);
    const sessionIds = this.state.pullRequestRegistrationsForRepo(reservation.owner, reservation.repo)
      .filter((record) => record.number === reservation.number)
      .map((record) => record.session_id);
    this.answerDelivery?.notifySessions(
      unique([...sessionIds, reservation.session_id]),
      `PR #${reservation.number} の head SHA が予約時から変わったため、マージ予約を取り消しました。予約時 ${reservation.headRefOid}、現在 ${pullRequest.headRefOid}。`,
    );
    await this.state.waitForPersistence?.();
    return { cancelled: true };
  }

  async deleteRemoteBranch(owner, repo, branch) {
    if (!validRepositoryPart(owner) || !validRepositoryPart(repo) || !validBranchName(branch)) throw new Error('invalid branch');
    await this.tracker.execute(['api', '-X', 'DELETE', `repos/${owner}/${repo}/git/refs/heads/${branch}`]);
  }

  notifyMerge(owner, repo, pullRequest, defaultBranch, method, stackedPullRequests, sessionIds, warning = null, headMismatch = null) {
    const automatic = method ? '' : '方式は取得できませんでした。';
    const methodText = method ? `方式: ${METHOD_LABELS[method] || method}。` : automatic;
    const lines = [`PR #${pullRequest.number} が ${defaultBranch} に入りました。${methodText}`];
    if (headMismatch) lines.push(`予約時の head SHA ${headMismatch.reserved} とマージされた head SHA ${headMismatch.merged} が異なります。予約の取り消しより先にマージされました。`);
    if (['squash', 'rebase'].includes(method)) {
      for (const stacked of stackedPullRequests) {
        if (validBranchName(stacked.baseRefName)) {
          lines.push(`#${stacked.number} を \`git rebase --onto ${defaultBranch} ${stacked.baseRefName}\` で積み直して push する。`);
        }
      }
    }
    if (warning) lines.push(warning);
    const childSessions = stackedPullRequests.flatMap((stacked) => (
      this.state.pullRequestRegistrationsForRepo(owner, repo).filter((record) => record.number === stacked.number).map((record) => record.session_id)
    ));
    this.answerDelivery?.notifySessions(unique([...sessionIds, ...childSessions]), lines.join('\n'));
  }

  async handleDetectedMerge({ owner, repo, pullRequest, mergedAt, reservation, registrations, stackedPullRequests }) {
    if (!pullRequest) return;
    const headMismatch = reservation && pullRequest.headRefOid.toLowerCase() !== reservation.headRefOid.toLowerCase()
      ? { reserved: reservation.headRefOid, merged: pullRequest.headRefOid }
      : null;
    this.state.recordMergedPullRequest({
      owner,
      repo,
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      mergedAt,
      method: reservation?.method || null,
      automatic: Boolean(reservation),
    }, this.now());
    this.state.clearPullRequestMergeReservation(owner, repo, pullRequest.number);

    let warning = null;
    const defaultBranch = reservation?.defaultBranch || this.tracker.repositories.get(`${owner.toLowerCase()}/${repo.toLowerCase()}`)?.defaultBranch;
    let canDeleteBranch = true;
    if (reservation && validBranchName(defaultBranch)) {
      for (const stacked of stackedPullRequests || []) {
        if (!Number.isSafeInteger(stacked.number) || stacked.number < 1) {
          warning = `#${stacked.number} の base を ${defaultBranch} に付け替えられませんでした`;
          canDeleteBranch = false;
          break;
        }
        try {
          await this.tracker.execute(['pr', 'edit', String(stacked.number), '-R', safeRepo(owner, repo), '--base', defaultBranch]);
          this.state.recordPullRequestRetarget({ owner, repo, number: stacked.number, base: defaultBranch, fromNumber: pullRequest.number });
        } catch {
          warning = `#${stacked.number} の base を ${defaultBranch} に付け替えられませんでした`;
          canDeleteBranch = false;
          break;
        }
      }
    }
    if (reservation?.deleteBranch && !headMismatch && canDeleteBranch && validBranchName(pullRequest.headRefName)) {
      try {
        await this.deleteRemoteBranch(owner, repo, pullRequest.headRefName);
      } catch {
        warning = [warning, `PR はマージしましたが、リモートブランチ ${pullRequest.headRefName} を削除できませんでした`].filter(Boolean).join('。');
      }
    }
    const method = reservation?.method || null;
    const sessionIds = registrations.map((record) => record.session_id);
    this.notifyMerge(owner, repo, pullRequest, defaultBranch || '既定ブランチ', method, stackedPullRequests || [], sessionIds, warning, headMismatch);
    await this.state.waitForPersistence?.();
  }

  async handleDetectedClose({ owner, repo, number, reservation, registrations }) {
    this.state.clearPullRequestMergeReservation(owner, repo, number);
    this.answerDelivery?.notifySessions(
      [...registrations.map((record) => record.session_id), reservation.session_id],
      `PR #${number} がクローズされたため、マージ予約は終了しました。`,
    );
    await this.state.waitForPersistence?.();
  }
}

module.exports = { PullRequestMergeManager, RESERVATION_POLL_MS };
