'use strict';

const { validBranchName, validRepositoryPart } = require('./pull-request-utils');
const { safeRepo, crossReviewConvergedAtHead } = require('./pull-requests');

const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const METHODS = new Set(['merge', 'squash', 'rebase']);
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

function errorText(error) {
  return [error?.message, error?.stderr].filter((value) => typeof value === 'string').join('\n');
}

function isMissingRemoteBranchError(error) {
  const text = errorText(error);
  return /reference does not exist/i.test(text) && /(?:http\s+422|\b422\b)/i.test(text);
}

function isGitHubNotFoundError(error) {
  return /(?:http\s+404|\b404\s+not found\b)/i.test(errorText(error));
}

class PullRequestMergeManager {
  constructor({ state, tracker, answerDelivery, now = Date.now } = {}) {
    this.state = state;
    this.tracker = tracker;
    this.answerDelivery = answerDelivery;
    this.now = now;
    this.inFlight = new Map();
    this.handledMerges = new Set();
    this.mergeOutcomes = new Map();
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

  registeredPullRequestByKey(registrationKey) {
    const registration = this.state.pullRequestRegistrationByKey(registrationKey);
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

  requestConflictResolution(input) {
    const registration = this.registeredPullRequestByKey(input.key);
    if (!registration) return Promise.resolve(actionResult(404, '記録された PR が見つかりません'));
    if (!SHA_PATTERN.test(input.headRefOid || '')) {
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

  async processMergedPullRequest(owner, repo, pullRequest, mergedAt, confirmedIntent = null) {
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
      confirmedIntent,
      reservation: this.state.pullRequestMergeReservation(owner, repo, pullRequest.number),
      registrations,
      stackedPullRequests: this.stackedPullRequests({
        registration: { owner, repo },
        repository: this.tracker.repositories.get(`${owner.toLowerCase()}/${repo.toLowerCase()}`) || { openPullRequests: [] },
        pullRequest: { children: [] },
      }, pullRequest.number),
    });
  }

  async performMerge(registration, input, reserved = false) {
    const reservation = this.state.pullRequestMergeReservation(registration.owner, registration.repo, registration.number);
    if (reservation && !reserved) {
      return actionResult(409, 'この PR にはマージ予約があります。先に予約を取り消してください');
    }
    if (reserved && (!reservation || reservation.method !== input.method || reservation.deleteBranch !== input.deleteBranch)) {
      return actionResult(409, 'マージ予約の状態が変わりました');
    }
    const candidate = await this.freshCandidate(registration);
    if (candidate.error) return actionResult(409, candidate.error);
    let mergeInput = input;
    if (reserved) {
      const reservationStatus = this.reservationMergeInput(candidate, reservation);
      if (reservationStatus?.halted) return this.cancelHaltedReservation(reservation);
      if (!reservationStatus) return actionResult(409, 'レビュー収束後マージの条件が変わりました。予約は保持しています');
      mergeInput = reservationStatus.input;
    }
    const pullRequest = candidate.pullRequest;
    const repository = safeRepo(registration.owner, registration.repo);
    const deleteBranch = mergeInput.deleteBranch && candidate.repository.autoDeleteBranch !== true;
    if (deleteBranch && pullRequest.isCrossRepository) {
      return actionResult(400, 'fork からの PR の head ブランチは登録先リポジトリから削除できません');
    }
    const initialError = reserved ? null : mergeCandidateError(candidate, mergeInput, registration.number);
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
    if (reserved) {
      const reservationStatus = this.reservationMergeInput(latestCandidate, reservation);
      if (reservationStatus?.halted) return this.cancelHaltedReservation(reservation);
      if (!reservationStatus) {
        const completed = retargeted.length ? `#${retargeted.map((item) => item.number).join('、')} の base は付け替え済みです。` : '';
        return actionResult(409, `${completed}レビュー収束後マージの条件が変わりました。予約は保持しています`);
      }
      mergeInput = reservationStatus.input;
    }
    if (deleteBranch && latestCandidate.pullRequest.isCrossRepository) {
      const completed = retargeted.length ? `#${retargeted.map((item) => item.number).join('、')} の base は付け替え済みです。` : '';
      return actionResult(400, `${completed}fork からの PR の head ブランチは登録先リポジトリから削除できません`);
    }
    const latestError = reserved ? null : mergeCandidateError(latestCandidate, mergeInput, registration.number);
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
      headRefOid: mergeInput.headRefOid,
      headRefName: pullRequest.headRefName,
      defaultBranch: candidate.repository.defaultBranch,
      method: mergeInput.method,
      deleteBranch: deleteBranch && latestCandidate.repository.autoDeleteBranch !== true,
      automatic: reserved,
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
        `--${mergeInput.method}`, '--match-head-commit', mergeInput.headRefOid,
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
      this.state.setLastPullRequestMethod(registration.owner, registration.repo, mergeInput.method);
      if (reserved) {
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
      return actionResult(409, `PR #${registration.number} はマージされていません。GitHub の状態を確認してください`);
    }

    this.state.setLastPullRequestMethod(registration.owner, registration.repo, mergeInput.method);
    const mergedAt = view.mergedAt || new Date(this.now()).toISOString();
    // gh の後に MERGED を確かめたので、この操作の意図は方式と削除の根拠にしてよい。
    const outcome = await this.processMergedPullRequest(
      registration.owner, registration.repo, view.pullRequest, mergedAt,
      { ...mergeIntent, retargetedNumbers: retargeted.map((item) => item.number) },
    );
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
    const deleteBranch = input.deleteBranch && candidate.repository.autoDeleteBranch !== true;
    if (deleteBranch && pullRequest.isCrossRepository) {
      return actionResult(400, 'fork からの PR の head ブランチは登録先リポジトリから削除できません');
    }
    if (pullRequest.headRefOid.toLowerCase() !== input.headRefOid.toLowerCase()) {
      return actionResult(409, '表示していた head SHA と現在の head SHA が異なります。状態を確認してください');
    }
    if (!candidate.repository.mergeMethods.includes(input.method)) return actionResult(409, 'このリポジトリでは選んだマージ方式が許可されていません');
    if (this.state.pullRequestMergeReservation(registration.owner, registration.repo, registration.number)) {
      return actionResult(409, 'この PR にはすでにマージ予約があります');
    }

    const reservation = {
      session_id: registration.session_id,
      owner: registration.owner,
      repo: registration.repo,
      number: registration.number,
      url: pullRequest.url,
      method: input.method,
      deleteBranch,
      createdAt: new Date(this.now()).toISOString(),
    };
    if (!this.state.setPullRequestMergeReservation(reservation)) return actionResult(500, 'マージ予約を保存できませんでした');
    try {
      await this.state.flushStoreWrite();
    } catch {
      this.state.clearPullRequestMergeReservation(registration.owner, registration.repo, registration.number);
      await this.state.waitForPersistence?.().catch(() => {});
      return actionResult(500, 'マージ予約を保存できませんでした');
    }
    this.state.setLastPullRequestMethod(registration.owner, registration.repo, input.method);
    await this.state.waitForPersistence?.();
    await this.checkReservations(registration.owner, registration.repo);
    return { ok: true, reserved: true, reservation };
  }

  async performCancelReservation(registration, reason) {
    const reservation = this.state.pullRequestMergeReservation(registration.owner, registration.repo, registration.number);
    if (!reservation) return actionResult(404, 'マージ予約が見つかりません');
    const message = `${reason}。PR #${registration.number} のレビュー収束後マージの予約を取り消しました。`;
    return this.cancelSavedReservation(reservation, message);
  }

  async cancelSavedReservation(reservation, message) {
    if (!this.state.clearPullRequestMergeReservation(reservation.owner, reservation.repo, reservation.number)) return null;
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
    for (const reservation of reservations) {
      await this.withPullRequestLock(reservation.owner, reservation.repo, reservation.number, () => this.checkReservation(reservation));
    }
  }

  async checkReservation(original) {
    const reservation = this.state.pullRequestMergeReservation(original.owner, original.repo, original.number);
    if (!reservation) return null;
    const registration = this.state.pullRequestRegistrationForSession(reservation.session_id, reservation.owner, reservation.repo, reservation.number);
    if (!registration) return null;
    const candidate = this.tracker.mergeCandidate(registration);
    const reservationStatus = this.reservationMergeInput(candidate, reservation);
    if (reservationStatus?.halted) return this.cancelHaltedReservation(reservation);
    if (!reservationStatus) return null;
    return this.performMerge(registration, reservationStatus.input, true);
  }

  reservationMergeInput(candidate, reservation) {
    const pullRequest = candidate?.pullRequest;
    if (!candidate?.repository?.listAvailable || !candidate.repository.configAvailable || !pullRequest) return null;
    const review = pullRequest.crossReview;
    const triage = review?.triage;
    if (triage?.outcome === 'halted') return { halted: true };
    if (review?.notRequired === true || triage?.outcome !== 'converged' || triage.round !== review?.round ||
      !crossReviewConvergedAtHead(pullRequest) || !SHA_PATTERN.test(triage.sha || '') || pullRequest.ci !== 'pass' ||
      pullRequest.review !== 'approved') return null;
    const input = { headRefOid: triage.sha, method: reservation.method, deleteBranch: reservation.deleteBranch };
    if (mergeCandidateError(candidate, input, reservation.number)) return null;
    return { input };
  }

  cancelHaltedReservation(reservation) {
    const message = `PR #${reservation.number} のクロスレビューが halted になったため、レビュー収束後マージの予約を取り消しました。`;
    return this.cancelSavedReservation(reservation, message);
  }

  async deleteRemoteBranch(owner, repo, branch) {
    if (!validRepositoryPart(owner) || !validRepositoryPart(repo) || !validBranchName(branch)) throw new Error('invalid branch');
    const reference = `repos/${owner}/${repo}/git/ref/heads/${branch}`;
    try {
      await this.tracker.execute(['api', '-X', 'DELETE', `repos/${owner}/${repo}/git/refs/heads/${branch}`]);
    } catch (error) {
      if (isMissingRemoteBranchError(error)) return;
      try {
        await this.tracker.execute(['api', reference]);
      } catch (lookupError) {
        if (isGitHubNotFoundError(lookupError)) return;
      }
      throw error;
    }
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
    const { owner, repo, pullRequest, mergedAt, registrations = [], confirmedIntent = null } = event;
    if (!pullRequest) return null;
    const mergeKey = `${owner.toLowerCase()}/${repo.toLowerCase()}#${pullRequest.number}`;
    if (this.handledMerges.has(mergeKey)) return this.mergeOutcomes.get(mergeKey) || null;
    this.handledMerges.add(mergeKey);
    const reservation = event.reservation || this.state.pullRequestMergeReservation(owner, repo, pullRequest.number);
    const mergeIntent = this.state.pullRequestMergeIntent(owner, repo, pullRequest.number);
    const expectedHeadRefOid = confirmedIntent?.headRefOid || null;
    const headMismatch = expectedHeadRefOid && pullRequest.headRefOid.toLowerCase() !== expectedHeadRefOid.toLowerCase()
      ? { reserved: expectedHeadRefOid, merged: pullRequest.headRefOid }
      : null;
    this.state.clearPullRequestMergeReservation(owner, repo, pullRequest.number);
    this.state.clearPullRequestMergeIntent(owner, repo, pullRequest.number);

    const repositoryState = this.tracker.repositories.get(`${owner.toLowerCase()}/${repo.toLowerCase()}`);
    const defaultBranch = confirmedIntent?.defaultBranch || repositoryState?.defaultBranch;
    const savedStackedByNumber = new Map([
      ...(confirmedIntent?.stackedPullRequests || []),
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
    // 予約は条件待ちに戻ってから再実行されることがあるので、前の実行で付け替えた記録も結果に含める。
    const retargetedNumbers = confirmedIntent
      ? [...new Set([...(confirmedIntent.retargetedNumbers || []), ...retargeted.map((record) => record.number)])].sort((left, right) => left - right)
      : [];
    let warning = null;
    let branchDeleted = false;
    const deleteBranch = repositoryState?.autoDeleteBranch !== true
      && confirmedIntent?.deleteBranch === true;
    if (deleteBranch && pullRequest.isCrossRepository) {
      warning = [warning, 'fork からの PR の head ブランチは登録先リポジトリから削除しませんでした'].filter(Boolean).join('。');
    } else if (deleteBranch && !headMismatch && validBranchName(pullRequest.headRefName)) {
      try {
        await this.deleteRemoteBranch(owner, repo, pullRequest.headRefName);
        branchDeleted = true;
      } catch {
        warning = [warning, `PR はマージしましたが、リモートブランチ ${pullRequest.headRefName} を削除できませんでした`].filter(Boolean).join('。');
      }
    }
    const method = confirmedIntent?.method || null;
    const automaticResult = confirmedIntent?.automatic === true ? {
      branchDeleted,
      autoDeleteBranch: repositoryState?.autoDeleteBranch === true && !pullRequest.isCrossRepository,
      retargetedBase: retargetedNumbers.length ? defaultBranch : null,
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
      headMismatch: Boolean(headMismatch),
      ...(automaticResult ? { automaticResult } : {}),
    }, this.now());
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

  async handleDetectedClose({ owner, repo, number, reservation, mergeIntent, registrations = [] }) {
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
