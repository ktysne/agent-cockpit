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
    this.handledMerges = new Set();
    this.mergeOutcomes = new Map();
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

  stackedPullRequests(candidate, parentNumber) {
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

  async processMergedPullRequest(owner, repo, pullRequest, mergedAt) {
    const registrations = this.state.pullRequestRegistrationsForRepo(owner, repo)
      .filter((record) => record.number === pullRequest.number);
    const related = this.state.relatedPullRequestRegistrationsForRepo(owner, repo)
      .filter((record) => record.number === pullRequest.number);
    for (const registration of registrations) {
      this.state.updatePullRequest(registration.session_id, owner, repo, pullRequest.number, { state: 'merged', mergedAt });
    }
    for (const record of related) this.state.updateRelatedPullRequest(owner, repo, pullRequest.number, { state: 'merged', mergedAt });
    return this.handleDetectedMerge({
      owner,
      repo,
      pullRequest,
      mergedAt,
      reservation: this.state.pullRequestMergeReservation(owner, repo, pullRequest.number),
      registrations,
      stackedPullRequests: this.stackedPullRequests({
        registration: { owner, repo },
        repository: this.tracker.repositories.get(`${owner.toLowerCase()}/${repo.toLowerCase()}`) || { openPullRequests: [] },
        pullRequest: { children: [] },
      }, pullRequest.number),
    });
  }

  async performMerge(registration, input) {
    if (this.state.pullRequestMergeReservation(registration.owner, registration.repo, registration.number)) {
      return actionResult(409, 'この PR にはマージ予約があります。先に予約を取り消してください');
    }
    const candidate = await this.freshCandidate(registration);
    if (candidate.error) return actionResult(409, candidate.error);
    const pullRequest = candidate.pullRequest;
    const repository = safeRepo(registration.owner, registration.repo);
    if (input.deleteBranch && pullRequest.isCrossRepository) {
      return actionResult(400, 'fork からの PR の head ブランチは登録先リポジトリから削除できません');
    }
    const initialError = mergeCandidateError(candidate, input, registration.number);
    if (initialError) return actionResult(409, initialError);

    const retargeted = [];
    const stackedPullRequests = this.stackedPullRequests(candidate, registration.number);
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
        previousBaseRefName: child.baseRefName,
      });
      retargeted.push(child);
    }

    const latestCandidate = await this.freshCandidate(registration);
    if (latestCandidate.error) {
      const completed = retargeted.length ? `#${retargeted.map((item) => item.number).join('、')} の base は付け替え済みです。` : '';
      return actionResult(409, `${completed}${latestCandidate.error}。マージはしていません`);
    }
    if (input.deleteBranch && latestCandidate.pullRequest.isCrossRepository) {
      const completed = retargeted.length ? `#${retargeted.map((item) => item.number).join('、')} の base は付け替え済みです。` : '';
      return actionResult(400, `${completed}fork からの PR の head ブランチは登録先リポジトリから削除できません`);
    }
    const latestError = mergeCandidateError(latestCandidate, input, registration.number);
    if (latestError) {
      const completed = retargeted.length ? `#${retargeted.map((item) => item.number).join('、')} の base は付け替え済みです。` : '';
      return actionResult(409, `${completed}${latestError}。マージはしていません`);
    }

    const mergeIntent = {
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
      stackedPullRequests: stackedPullRequests.map((item) => ({ number: item.number, baseRefName: item.baseRefName })),
    };
    if (!this.state.setPullRequestMergeIntent(mergeIntent)) return actionResult(500, 'マージ操作を保存できませんでした');
    // キューに入ったまま落ちても方式と削除の選択を戻せるよう、gh を呼ぶ前にまとめ書きを待たずに保存し終える。
    try {
      await this.state.flushStoreWrite();
    } catch {
      this.state.clearPullRequestMergeIntent(registration.owner, registration.repo, registration.number);
      await this.state.waitForPersistence?.().catch(() => {});
      return actionResult(500, 'マージ操作を保存できませんでした');
    }

    try {
      await this.tracker.execute([
        'pr', 'merge', String(registration.number), '-R', repository,
        `--${input.method}`, '--match-head-commit', latestCandidate.pullRequest.headRefOid,
      ]);
    } catch {
      this.state.clearPullRequestMergeIntent(registration.owner, registration.repo, registration.number);
      await this.state.waitForPersistence?.().catch(() => {});
      const completed = retargeted.length ? `#${retargeted.map((item) => item.number).join('、')} の base は付け替え済みです。` : '';
      return actionResult(502, `${completed}PR #${registration.number} をマージできませんでした。状態を確認してください`);
    }

    let view;
    try {
      view = await this.tracker.readPullRequestView(registration.owner, registration.repo, registration.number);
    } catch {
      return actionResult(502, `gh pr merge は成功しましたが、PR #${registration.number} の状態を確認できませんでした。後続の状態取得で確認します`);
    }
    if (view.state === 'OPEN') {
      // マージキューでは方式の指定が効かず、キューの所属も gh から取れないので、意図を持たずに外でのマージとして扱う。
      this.state.clearPullRequestMergeIntent(registration.owner, registration.repo, registration.number);
      this.state.setLastPullRequestMethod(registration.owner, registration.repo, input.method);
      await this.state.waitForPersistence?.();
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
      return actionResult(409, `PR #${registration.number} はマージされていません。GitHub の状態を確認してください`);
    }

    this.state.setLastPullRequestMethod(registration.owner, registration.repo, input.method);
    const mergedAt = view.mergedAt || new Date(this.now()).toISOString();
    const outcome = await this.processMergedPullRequest(registration.owner, registration.repo, view.pullRequest, mergedAt);
    await this.tracker.refreshRepo(registration.owner, registration.repo).catch(() => {});
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
    const candidate = await this.freshCandidate(registration);
    if (candidate.error) return actionResult(409, candidate.error);
    const pullRequest = candidate.pullRequest;
    const repository = safeRepo(registration.owner, registration.repo);
    if (input.deleteBranch && pullRequest.isCrossRepository) {
      return actionResult(400, 'fork からの PR の head ブランチは登録先リポジトリから削除できません');
    }
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

  // 状態を確かめられないときも、取り消せたと知らせないよう残っている扱いにする。
  async autoMergeStillEnabled(owner, repo, number) {
    try {
      const view = await this.tracker.readPullRequestView(owner, repo, number);
      return view.state === 'OPEN' && view.autoMergeEnabled === true;
    } catch {
      return true;
    }
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

    if (await this.autoMergeStillEnabled(registration.owner, registration.repo, registration.number)) {
      return actionResult(502, `PR #${registration.number} のマージ予約を取り消せませんでした。GitHub で自動マージが有効なままです`);
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
    if (!pullRequest) return null;
    const headChanged = pullRequest.headRefOid.toLowerCase() !== reservation.headRefOid.toLowerCase();
    const baseChanged = pullRequest.baseRefName !== reservation.defaultBranch;
    const defaultBranchChanged = Boolean(repository.defaultBranch && repository.defaultBranch !== reservation.defaultBranch);
    if (!headChanged && !baseChanged && !defaultBranchChanged) return null;

    try {
      await this.tracker.execute([
        'pr', 'merge', String(reservation.number), '-R', safeRepo(reservation.owner, reservation.repo), '--disable-auto',
      ]);
    } catch {
      await this.tracker.refreshRepoFresh(reservation.owner, reservation.repo).catch(() => {});
      if (!this.state.pullRequestMergeReservation(reservation.owner, reservation.repo, reservation.number)) return null;
      return null;
    }

    if (await this.autoMergeStillEnabled(reservation.owner, reservation.repo, reservation.number)) return null;

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
    const reasons = [];
    if (headChanged) reasons.push(`head SHA が予約時から変わったため`);
    if (baseChanged) reasons.push(`base が予約時の既定ブランチ ${reservation.defaultBranch} から ${pullRequest.baseRefName} に変わったため`);
    if (defaultBranchChanged) reasons.push(`リポジトリの既定ブランチが ${reservation.defaultBranch} から ${repository.defaultBranch} に変わったため`);
    this.answerDelivery?.notifySessions(
      unique([...sessionIds, reservation.session_id]),
      `PR #${reservation.number} の ${reasons.join('。')}、マージ予約を取り消しました。予約時 head SHA ${reservation.headRefOid}、現在 ${pullRequest.headRefOid}。`,
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

  async handleDetectedMerge(event) {
    const { owner, repo, pullRequest, mergedAt, registrations = [] } = event;
    if (!pullRequest) return null;
    const mergeKey = `${owner.toLowerCase()}/${repo.toLowerCase()}#${pullRequest.number}`;
    if (this.handledMerges.has(mergeKey)) return this.mergeOutcomes.get(mergeKey) || null;
    this.handledMerges.add(mergeKey);
    const reservation = event.reservation || this.state.pullRequestMergeReservation(owner, repo, pullRequest.number);
    const mergeIntent = this.state.pullRequestMergeIntent(owner, repo, pullRequest.number);
    const expectedHeadRefOid = reservation?.headRefOid || mergeIntent?.headRefOid || null;
    const headMismatch = expectedHeadRefOid && pullRequest.headRefOid.toLowerCase() !== expectedHeadRefOid.toLowerCase()
      ? { reserved: expectedHeadRefOid, merged: pullRequest.headRefOid }
      : null;
    this.state.recordMergedPullRequest({
      owner,
      repo,
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      mergedAt,
      method: reservation?.method || mergeIntent?.method || null,
      automatic: Boolean(reservation),
      reservedHeadRefOid: expectedHeadRefOid,
      mergedHeadRefOid: pullRequest.headRefOid || null,
      headMismatch: Boolean(headMismatch),
    }, this.now());
    this.state.clearPullRequestMergeReservation(owner, repo, pullRequest.number);
    this.state.clearPullRequestMergeIntent(owner, repo, pullRequest.number);

    const repositoryState = this.tracker.repositories.get(`${owner.toLowerCase()}/${repo.toLowerCase()}`);
    const defaultBranch = reservation?.defaultBranch || mergeIntent?.defaultBranch || repositoryState?.defaultBranch;
    const savedStackedByNumber = new Map([
      ...(reservation?.stackedPullRequests || []),
      ...(mergeIntent?.stackedPullRequests || []),
    ].map((item) => [item.number, item]));
    const retargeted = this.state.pullRequestRetargetsForRepo(owner, repo)
      .filter((record) => record.fromNumber === pullRequest.number);
    const stackedByNumber = new Map();
    const selectedStackedPullRequests = event.stackedPullRequests || [...savedStackedByNumber.values()];
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
    let warning = null;
    let canDeleteBranch = true;
    if (reservation && validBranchName(defaultBranch)) {
      for (const stacked of stackedPullRequests) {
        if (!Number.isSafeInteger(stacked.number) || stacked.number < 1) {
          warning = `#${stacked.number} の base を ${defaultBranch} に付け替えられませんでした`;
          canDeleteBranch = false;
          break;
        }
        try {
          await this.tracker.execute(['pr', 'edit', String(stacked.number), '-R', safeRepo(owner, repo), '--base', defaultBranch]);
          this.state.recordPullRequestRetarget({
            owner, repo, number: stacked.number, base: defaultBranch, fromNumber: pullRequest.number,
            previousBaseRefName: stacked.baseRefName,
          });
        } catch {
          warning = `#${stacked.number} の base を ${defaultBranch} に付け替えられませんでした`;
          canDeleteBranch = false;
          break;
        }
      }
    }
    let branchDeleted = false;
    const deleteBranch = reservation?.deleteBranch || mergeIntent?.deleteBranch;
    if (deleteBranch && pullRequest.isCrossRepository) {
      warning = [warning, 'fork からの PR の head ブランチは登録先リポジトリから削除しませんでした'].filter(Boolean).join('。');
    } else if (deleteBranch && !headMismatch && canDeleteBranch && validBranchName(pullRequest.headRefName)) {
      try {
        await this.deleteRemoteBranch(owner, repo, pullRequest.headRefName);
        branchDeleted = true;
      } catch {
        warning = [warning, `PR はマージしましたが、リモートブランチ ${pullRequest.headRefName} を削除できませんでした`].filter(Boolean).join('。');
      }
    }
    const method = reservation?.method || mergeIntent?.method || null;
    const sessionIds = [
      ...registrations.map((record) => record.session_id),
      reservation?.session_id,
      mergeIntent?.session_id,
    ].filter(Boolean);
    this.notifyMerge(owner, repo, pullRequest, defaultBranch || '既定ブランチ', method, stackedPullRequests, sessionIds, warning, headMismatch);
    await this.state.waitForPersistence?.();
    const outcome = { branchDeleted, warning };
    this.mergeOutcomes.set(mergeKey, outcome);
    return outcome;
  }

  async handleDetectedClose({ owner, repo, number, reservation, mergeIntent, registrations }) {
    this.state.clearPullRequestMergeReservation(owner, repo, number);
    this.state.clearPullRequestMergeIntent(owner, repo, number);
    const sessionIds = [...registrations.map((record) => record.session_id), reservation?.session_id, mergeIntent?.session_id].filter(Boolean);
    if (reservation || mergeIntent) {
      this.answerDelivery?.notifySessions(sessionIds, `PR #${number} がクローズされたため、マージ操作は終了しました。`);
    }
    await this.state.waitForPersistence?.();
  }
}

module.exports = { PullRequestMergeManager, RESERVATION_POLL_MS };
