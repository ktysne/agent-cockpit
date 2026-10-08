const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { sanitizeManagedCollectorSnapshot } = require('../managed-collector');
const { codexAgentScriptPaths } = require('../identity');
const { escapeHtmlAttribute, jsonResponse, textResponse } = require('../http-helpers');
const { ownedExecutionProjection } = require('../request-validation');
const { APP_NAME } = require('../server-constants');

function createReadRoutes(ctx) {
  const {
    away, claudeHome, claudeIssuer, codexAgentScriptExists,
    crossReviewToolExists, dev, instructionService, instructionServiceReady,
    instructionTargetList, instructionTargetState, launchRegistry, managedCollectors,
    ownedExecutionSnapshot, providerEventProjection, pullRequestTracker, questionService,
    registrationSnapshotForInstructions, routing, safeInstructionRecovery, state,
    userHome, validatedSessionProjectionRecords, webPath,
  } = ctx;

  let cachedUiFileStamp = null;
  let uiVersion = null;

  async function currentUiVersion() {
    try {
      const stat = await fs.stat(webPath);
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (stamp !== cachedUiFileStamp) {
        const content = await fs.readFile(webPath);
        uiVersion = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
        cachedUiFileStamp = stamp;
      }
    } catch {}
    return uiVersion;
  }

  async function handleHealth({ response, info }) {
    jsonResponse(response, 200, { app: APP_NAME, pid: info.pid, startedAt: info.startedAt });
    return;
  }

  async function handleState({ response }) {
    let commonQuestionSnapshot = null;
    let questionRegistrationSnapshot = null;
    let commonQuestionSnapshotUnavailable = false;
    if (questionService) {
      try {
        const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
        commonQuestionSnapshot = await questionService.dashboardSnapshot();
        if (!isRecord(commonQuestionSnapshot) || !Array.isArray(commonQuestionSnapshot.questions) ||
            commonQuestionSnapshot.questions.some((question) => !isRecord(question))) throw new Error();
        questionRegistrationSnapshot = registrationSnapshotForInstructions();
        if (!questionRegistrationSnapshot ||
            questionRegistrationSnapshot.conversations.some((conversation) => !isRecord(conversation)) ||
            questionRegistrationSnapshot.executions.some((execution) => !isRecord(execution))) throw new Error();
      } catch {
        commonQuestionSnapshot = null;
        questionRegistrationSnapshot = null;
        commonQuestionSnapshotUnavailable = true;
      }
    }
    let instructionDashboard = null;
    let instructionRegistrationSnapshot = null;
    let instructionTargets = [];
    let instructionDashboardUnavailable = !instructionService || !instructionServiceReady;
    let instructionTargetsUnavailable = !launchRegistry;
    if (launchRegistry) {
      try {
        instructionRegistrationSnapshot = registrationSnapshotForInstructions();
        if (!instructionRegistrationSnapshot) throw new Error();
        instructionTargets = instructionTargetList(instructionRegistrationSnapshot);
        instructionTargetsUnavailable = false;
      } catch {
        instructionRegistrationSnapshot = null;
        instructionTargets = [];
        instructionTargetsUnavailable = true;
      }
    }
    if (instructionService && instructionServiceReady) {
      try {
        instructionDashboard = await instructionService.dashboardSnapshot();
        if (!instructionDashboard || typeof instructionDashboard !== "object" ||
            !Array.isArray(instructionDashboard.instructions)) throw new Error();
        instructionDashboardUnavailable = false;
      } catch { instructionDashboardUnavailable = true; }
    }
    if (launchRegistry && instructionService && instructionServiceReady &&
        (!instructionDashboard || !instructionRegistrationSnapshot)) {
      instructionDashboard = null;
      instructionRegistrationSnapshot = null;
    }
    const snapshot = state.snapshot();
    const pullRequests = pullRequestTracker?.snapshot() || [];
    const now = Date.now();
    const awayState = away.snapshot();
    const sinceSeen = state.snapshotSinceSeen(snapshot.sessions, pullRequests, now, awayState.periods);
    // 版と時刻は中身と同じ同期処理の中で確定する。後で待つと、待つ間の更新の版が古い中身に付く。
    snapshot.version = state.version;
    snapshot.generatedAt = state.generatedAt;
    void away.prune?.([...state.seenAtByProduct.values()], now);
    const stateSessionIds = new Set(snapshot.sessions.map((session) => session.session_id));
    const sessions = snapshot.sessions.filter((session) => {
      const rowProviders = state.sessionProviderSourcesFor?.(session.session_id) || [];
      return !(rowProviders.length === 1 && state.projectionDisplayRecordsForSession(session.session_id)
        .some((record) => record.provider === rowProviders[0] && record.deletedAt !== undefined));
    }).map((session) => {
      const seenAt = session.product && sinceSeen.seenAtByProduct[session.product.key];
      const seenMilliseconds = Date.parse(seenAt || '');
      return {
        ...session,
        decisions: session.decisions.map((decision) => ({
          ...decision,
          isNew: Number.isFinite(seenMilliseconds) && Date.parse(decision.createdAt) > seenMilliseconds,
        })),
      };
    });
    const sessionsById = new Map(sessions.map((session) => [session.session_id, session]));
    const projectionRecords = validatedSessionProjectionRecords(
      commonQuestionSnapshot, questionRegistrationSnapshot, instructionDashboard, instructionRegistrationSnapshot);
    const projectionProvidersBySession = new Map();
    for (const projection of [...projectionRecords.questions, ...projectionRecords.instructions]) {
      const providers = projectionProvidersBySession.get(projection.sessionId) || new Set();
      providers.add(projection.provider);
      projectionProvidersBySession.set(projection.sessionId, providers);
    }
    function projectionCanMerge(sessionId, provider) {
      const providers = new Set([
        ...(projectionProvidersBySession.get(sessionId) || []),
        ...state.projectionDisplayRecordsForSession(sessionId).map((record) => record.provider),
      ]);
      if (providers.size !== 1 || !providers.has(provider)) return false;
      const rowProviders = state.sessionProviderSourcesFor?.(sessionId) || [];
      if (stateSessionIds.has(sessionId)) return rowProviders.length === 1 && rowProviders[0] === provider;
      return rowProviders.length === 0 || (rowProviders.length === 1 && rowProviders[0] === provider);
    }
    const orphanedCommonQuestions = projectionRecords.orphanedCommonQuestions;
    for (const { question, link, provider, sessionId } of projectionRecords.questions) {
      if (!projectionCanMerge(sessionId, provider)) continue;
      const display = state.projectionDisplayFor(provider, sessionId);
      if (display?.deletedAt) continue;
      let session = sessionsById.get(sessionId);
      if (!session) {
        session = {
          session_id: sessionId,
          provider,
          title: question.identity.nativeId,
          product: null,
          status: '待機中',
          tools: [],
          agents: [],
          permissionWaits: [],
          decisions: [],
          tasks: [],
          tasksUpdatedAt: null,
        };
        sessionsById.set(sessionId, session);
        sessions.push(session);
      }
      if (display?.hiddenAt) {
        session.hidden = true;
        if (!session.hiddenAt || Date.parse(display.hiddenAt) > Date.parse(session.hiddenAt)) session.hiddenAt = display.hiddenAt;
      }
      if (!Array.isArray(session.commonQuestions)) session.commonQuestions = [];
      const seenAt = session.product && sinceSeen.seenAtByProduct[session.product.key];
      const seenMilliseconds = Date.parse(seenAt || '');
      session.commonQuestions.push({
        ...question,
        sessionId,
        executionState: link.execution.state,
        isNew: Number.isFinite(seenMilliseconds) && question.createdAt > seenMilliseconds,
      });
    }
    const unmatchedInstructions = projectionRecords.unmatchedInstructions;
    for (const { instruction, link, provider, sessionId } of projectionRecords.instructions) {
      if (!projectionCanMerge(sessionId, provider)) continue;
      const display = state.projectionDisplayFor(provider, sessionId);
      if (display?.deletedAt) continue;
      let session = sessionsById.get(sessionId);
      if (!session) {
        session = { session_id: sessionId, provider, title: instruction.identity.nativeId, product: null,
          status: "待機中", tools: [], agents: [], permissionWaits: [], decisions: [], tasks: [], tasksUpdatedAt: null };
        sessionsById.set(sessionId, session);
        sessions.push(session);
      }
      if (display?.hiddenAt) {
        session.hidden = true;
        if (!session.hiddenAt || Date.parse(display.hiddenAt) > Date.parse(session.hiddenAt)) session.hiddenAt = display.hiddenAt;
      }
      if (!Array.isArray(session.instructions)) session.instructions = [];
      session.instructions.push({ ...instruction, registrationExecutionId: link.execution.executionId,
        executionState: link.execution.state });
    }
    const instructionRecovery = safeInstructionRecovery(instructionDashboard?.recovery);
    const instructionConfigured = Boolean(instructionService || launchRegistry || instructionTargetState);
    const instructionDiagnostics = {
      configuration: instructionConfigured ? "configured" : "unconfigured",
      service: instructionDashboardUnavailable ? "unavailable" : instructionRecovery?.status || "ready",
      targets: instructionTargetsUnavailable ? "unavailable" : "available",
      ...(instructionRecovery?.blocked === true ? { blocked: true } : {}),
      ...(instructionRecovery?.errorCode ? { errorCode: instructionRecovery.errorCode } : {}),
      ...(unmatchedInstructions ? { unmatchedCount: unmatchedInstructions } : {}),
    };
    const uiVersion = await currentUiVersion();
    let codexAgent = false;
    for (const scriptPath of codexAgentScriptPaths(claudeHome, userHome)) {
      if (await codexAgentScriptExists(scriptPath) === true) {
        codexAgent = true;
        break;
      }
    }
    let crossReview = false;
    for (const cwd of state.knownCwds()) {
      if (await crossReviewToolExists(cwd) === true) {
        crossReview = true;
        break;
      }
    }
    const managedCollectorSnapshots = Array.isArray(managedCollectors)
      ? managedCollectors.map((collector) => {
        try {
          return typeof collector?.snapshot === 'function'
            ? sanitizeManagedCollectorSnapshot(collector.snapshot())
            : null;
        } catch { return null; }
      }).filter(Boolean)
      : [];
    const commonQuestionDiagnostics = commonQuestionSnapshotUnavailable
      ? { recovery: { status: 'unavailable', errorCode: 'common_question_state_unavailable' } }
      : commonQuestionSnapshot?.recovery || orphanedCommonQuestions.length
      ? { ...(commonQuestionSnapshot?.recovery ? { recovery: commonQuestionSnapshot.recovery } : {}),
        ...(orphanedCommonQuestions.length ? { orphanedQuestions: orphanedCommonQuestions } : {}) }
      : undefined;
    let ownedExecutions = [];
    let ownedExecutionDiagnostics = { status: ownedExecutionSnapshot ? 'unavailable' : 'unconfigured' };
    if (ownedExecutionSnapshot) {
      try {
        const rawOwnedExecutions = await ownedExecutionSnapshot();
        if (!Array.isArray(rawOwnedExecutions) || rawOwnedExecutions.length > 4096) throw new Error();
        const seenLaunchRefs = new Set();
        ownedExecutions = rawOwnedExecutions.map((value) => {
          const projected = ownedExecutionProjection(value);
          if (!projected || seenLaunchRefs.has(projected.launchRef)) throw new Error();
          seenLaunchRefs.add(projected.launchRef);
          return projected;
        });
        ownedExecutionDiagnostics = { status: 'ready' };
      } catch {
        ownedExecutions = [];
      }
    }
    jsonResponse(response, 200, { ...snapshot, sessions, pullRequests, sinceSeen: sinceSeen.sinceSeen, away: away.snapshot(), routing: routing.snapshot(), integrations: { codexAgent, crossReview }, providerEvents: providerEventProjection.snapshot(), managedCollectors: managedCollectorSnapshots, uiVersion, instructionTargets, instructionDiagnostics, ownedExecutions, ownedExecutionDiagnostics, ...(commonQuestionDiagnostics ? { commonQuestionDiagnostics } : {}) });
    return;
  }

  async function handleContext({ response, params }) {
    const sessionId = params[1];
    const displayId = claudeIssuer?.activeProjectionFor({ sessionId }) || sessionId;
    jsonResponse(response, 200, { ...away.snapshot(), ...state.planSummary(displayId) });
    return;
  }

  async function handleDevFields({ response }) {
    if (!dev) {
      textResponse(response, 404, 'Not Found');
      return;
    }
    jsonResponse(response, 200, state.devFields());
    return;
  }

  async function handleIndex({ response, info }) {
    try {
      let beforeStat = null;
      try {
        beforeStat = await fs.stat(webPath);
      } catch {}
      const content = await fs.readFile(webPath);
      let afterStat = null;
      try {
        afterStat = await fs.stat(webPath);
      } catch {}
      uiVersion = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
      const sameFile = beforeStat && afterStat && beforeStat.mtimeMs === afterStat.mtimeMs && beforeStat.size === afterStat.size && content.length === afterStat.size;
      cachedUiFileStamp = sameFile ? `${afterStat.mtimeMs}:${afterStat.size}` : null;
      const template = content.toString('utf8');
      const html = template.replace(
        '<meta name="cockpit-secret" content="">',
        `<meta name="cockpit-secret" content="${escapeHtmlAttribute(info.uiSecret)}">`,
      ).replace(
        '<meta name="cockpit-ui-version" content="">',
        `<meta name="cockpit-ui-version" content="${uiVersion}">`,
      );
      textResponse(response, 200, html, 'text/html; charset=utf-8');
    } catch {
      textResponse(response, 500, 'Dashboard unavailable');
    }
    return;
  }

  return { handleHealth, handleState, handleContext, handleDevFields, handleIndex };
}

module.exports = { createReadRoutes };
