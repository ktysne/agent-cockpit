const crypto = require('node:crypto');
const { sanitizeQuestions, sanitizeCodexQuestions } = require('./events');
const { isStoredSessionId } = require('./session-ids');
const { TaskNudges } = require('./task-nudges');

const ANSWER_WAIT_MS = 5 * 60_000;
const MAX_LONG_POLL_MS = 25_000;
const REVIEW_REMINDER_WAIT_MS = 3_000;
const MAX_ASK_POLL_GAP_MS = 30_000;
const HOOK_DELIVERY_TTL_MS = 10 * 60_000;
const MAX_HOOK_DELIVERY_RECORDS_PER_SESSION = 128;
const MAX_SESSION_NOTIFICATIONS = 20;
const ANSWER_HOOK_DENY_REASON = '開発者は離席中です。AskUserQuestion で尋ねずに、推奨の選択肢を適用して作業を続けてください。判断事項の id は「{id}」です。推奨で進めたら cockpit_update_decision でこの id を provisional にし、選んだ選択肢を書いてください。判断が必要だった事項と仮に適用した推奨は、最後の報告の「あなたの判断が必要なこと」に一覧で書いてください。破壊的な操作は行わず、判断待ちとして残してください。';
// 知らせはフックの英語の定型文に包まれて届き、返答が英語に引きずられやすいため、毎回添える。
const SESSION_NOTIFICATION_REPLY_LANGUAGE = 'この知らせへの返答と、続けて開発者に見せる文は日本語で書く。';

function keyFor(sessionId, id) {
  return `${sessionId}\0${id}`;
}

function hasDuplicateQuestions(decision) {
  const questions = decision.questions || [];
  return new Set(questions.map((question) => question.question)).size !== questions.length;
}

function recommendedOptions(decision) {
  return (decision.questions || []).map((question) => {
    if (question.multiSelect) return null;
    const matches = question.options.filter((option) => option.recommended === true);
    return matches.length === 1 ? matches[0] : null;
  });
}

function validPicks(decision, picks, note) {
  const questions = decision.questions || [];
  if (!Array.isArray(picks) || picks.length !== questions.length || typeof note !== 'string') return false;
  const recommendations = recommendedOptions(decision);
  let selectedCount = 0;
  for (const [index, question] of questions.entries()) {
    const labels = picks[index];
    if (!Array.isArray(labels) || (!question.multiSelect && labels.length > 1)) return false;
    if (labels.some((label) => typeof label !== 'string' || !question.options.some((option) => option.label === label))) return false;
    selectedCount += labels.length;
    if (!labels.length && !recommendations[index] && !note.trim()) return false;
  }
  return selectedCount > 0;
}

function canAnswerDecision(decision) {
  return ['waiting', 'provisional'].includes(decision.state) && !hasDuplicateQuestions(decision) && decision.questions.length > 0;
}

function denyAnswerOutput(decisionId, provider = 'claude', toolName = 'AskUserQuestion', questions = []) {
  let reason = ANSWER_HOOK_DENY_REASON.replace('AskUserQuestion', toolName);
  if (provider === 'codex' && recommendedOptions({ questions }).some((option) => !option)) {
    reason = reason.replace('推奨の選択肢を適用して作業を続けてください。',
      '推奨のある質問は推奨の選択肢を適用し、推奨の無い質問は仮定を置いて自分の判断で作業を続けてください。')
      .replace('推奨で進めたら', '推奨または仮定で進めたら')
      .replace('選んだ選択肢を書いてください。', '選んだ選択肢と置いた仮定を書いてください。');
  }
  // Codex の選択肢には推奨の印が無く、先頭が推奨という約束だけなので、適用する推奨を書き添える。
  if (provider === 'codex') {
    const recommendations = recommendedOptions({ questions });
    const lines = questions.flatMap((question, index) => (recommendations[index] ? [`推奨: ${question.question} → ${recommendations[index].label}`] : []));
    if (lines.length) reason = [reason, ...lines].join('\n');
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason.replace('{id}', String(decisionId || '不明').slice(0, 256).replace(/[\r\n]/g, '')),
    },
  };
}

function askAnswers(decision, answer) {
  const recommendations = recommendedOptions(decision);
  const selected = answer.choice === 'ok'
    ? recommendations
    : decision.questions.map(() => null);
  if (answer.choice === 'pick' && !validPicks(decision, answer.picks, answer.note)) return null;
  if (selected.some((option) => !option) && answer.choice !== null && answer.choice !== 'pick') return null;

  return Object.fromEntries(decision.questions.map((question, index) => [
    question.question,
    answer.choice === null
      ? answer.note
      : answer.choice === 'pick'
        ? answer.picks[index].length ? answer.picks[index].join(', ') : recommendations[index]?.label || answer.note
        : selected[index].label,
  ]));
}

function askAnswerOutput(decision, answer, provider = 'claude', toolName = 'AskUserQuestion') {
  const answers = askAnswers(decision, answer);
  if (!answers) return denyAnswerOutput(decision.id, provider, toolName, decision.questions);
  const additionalContext = [];
  if (['ok', 'pick'].includes(answer.choice) && answer.note) additionalContext.push(`開発者の指示: ${answer.note}`);
  if (provider === 'codex') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: [
          '開発者がダッシュボードで回答しました。次の回答に沿って作業を続けてください。',
          ...Object.entries(answers).map(([question, value]) => `${question} → ${value}`),
          ...additionalContext,
        ].join('\n'),
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: {
        questions: decision.questions.map(({ question, header, multiSelect, options }) => ({
          question,
          header,
          multiSelect,
          options: options.map(({ label, description }) => ({ label, description })),
        })),
        answers,
      },
      ...(additionalContext.length ? { additionalContext: additionalContext.join('\n') } : {}),
    },
  };
}

function decisionAnswerText(decision) {
  const answer = decision.answer;
  // 選ばなかった質問も askAnswerOutput と同じ規則で埋めて書く。省くと再送で前の答えが残るため。
  const recommendations = recommendedOptions(decision);
  const pickedQuestions = answer.choice === 'pick'
    ? decision.questions.map((question, index) => {
      const labels = answer.picks?.[index] || [];
      if (labels.length) return `「${question.question}」は「${labels.join(', ')}」`;
      return recommendations[index]
        ? `「${question.question}」は推奨の「${recommendations[index].label}」`
        : `「${question.question}」は指示のとおり`;
    }).join('、')
    : '';
  const answerKind = answer.choice === 'ok' ? '推奨案で OK'
    : answer.choice === 'pick' ? `選択肢を選んだ(${pickedQuestions})`
      : '指示のみ';
  const instruction = answer.note || 'なし';
  return `開発者がダッシュボードから判断事項 ${decision.id}「${decision.title}」に回答した: ${answerKind}。指示: ${instruction}。回答に沿って作業を直し、cockpit_update_decision で状態を更新する。`;
}

class DecisionAnswerDelivery {
  constructor({ state, away, pullRequestTracker, diagnostics, reviewReminderWaitMs = REVIEW_REMINDER_WAIT_MS, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, maxLongPollMs = MAX_LONG_POLL_MS, answerWaitMs = ANSWER_WAIT_MS, maxAskPollGapMs = MAX_ASK_POLL_GAP_MS } = {}) {
    this.state = state;
    this.pullRequestTracker = pullRequestTracker;
    this.diagnostics = diagnostics;
    this.reviewReminderWaitMs = reviewReminderWaitMs;
    this.stopReviewReminders = new Map();
    this.remindedReviewHeads = new Map();
    this.away = away;
    this.now = now;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
    this.maxLongPollMs = maxLongPollMs;
    this.answerWaitMs = answerWaitMs;
    this.maxAskPollGapMs = maxAskPollGapMs;
    this.taskNudges = new TaskNudges({ state, now });
    this.pendingHookDeliveries = state.pendingHookDeliveries;
    this.pendingSessionNotifications = state.pendingSessionNotifications;
    this.pendingSessionNotificationOverflow = state.pendingSessionNotificationOverflow;
    this.askWaits = new Map();
    this.stopGenerations = new Map();
    this.lastLifecycleAt = new Map();
    this.endedSessions = new Set();
    this.waiters = new Map();
    this.sessionNotifications = this.pendingSessionNotifications;
    this.closed = false;
  }

  registerAsk({ sessionId, toolUseId, questions, agentId, provider = 'claude', toolName = 'AskUserQuestion' }) {
    const sanitized = provider === 'codex' ? sanitizeCodexQuestions(toolName, questions) : sanitizeQuestions(questions);
    const deny = (id) => denyAnswerOutput(id, provider, toolName, sanitized);
    const awayEnabled = this.away.snapshot().enabled === true;
    if (agentId) return { awaiting: false, hookOutput: awayEnabled ? deny(toolUseId) : null };
    if (provider === 'codex' && this.state.sessions.get(sessionId)?.provider !== 'codex') return { awaiting: false, hookOutput: null };
    const key = keyFor(sessionId, toolUseId);
    const existing = this.askWaits.get(key);
    if (existing) return { awaiting: true, decisionId: existing.decisionId, deadline: existing.deadline, fallbackOutput: existing.fallbackOutput };
    if (!awayEnabled) return { awaiting: false, hookOutput: null };

    const createdAt = this.now();
    const event = {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      hookAt: createdAt,
      provider,
      tool_name: toolName,
      tool_use_id: toolUseId,
      questions: sanitized,
    };
    if (!event.questions.length || !this.state.addEvent(event)) return { awaiting: false, hookOutput: null };
    const decisionId = this.state.decisionIdForToolUse(sessionId, toolUseId);
    if (!decisionId) return { awaiting: false, hookOutput: null };
    if (hasDuplicateQuestions({ questions: event.questions })) {
      this.releaseAskWaitsForDecision(sessionId, decisionId);
      this.state.deleteDecisionLifecycle(sessionId, decisionId);
      return { awaiting: false, hookOutput: null };
    }
    const answerWaitMs = typeof this.answerWaitMs === 'function' ? this.answerWaitMs() : this.answerWaitMs;
    const deadline = createdAt + answerWaitMs;
    const record = { sessionId, toolUseId, decisionId, provider, toolName, fallbackOutput: deny(decisionId), deadline, timer: null, pollTimer: null, lastPollAt: createdAt };
    this.askWaits.set(key, record);
    record.timer = this.setTimeout(() => this.expireAsk(record), answerWaitMs);
    this.scheduleAskPollTimeout(record);
    this.state.setDecisionLifecycle(sessionId, decisionId, {
      answer: null,
      awaitingAnswerUntil: new Date(deadline).toISOString(),
      state: null,
      askToolUseId: toolUseId,
    }, createdAt);
    return { awaiting: true, decisionId, deadline, fallbackOutput: record.fallbackOutput };
  }

  async waitForAsk({ sessionId, toolUseId }) {
    const record = this.askWaits.get(keyFor(sessionId, toolUseId));
    if (!record) return { outcome: 'server-lost' };
    if (record.result) return { outcome: record.result.outcome };
    if (this.closed) return { outcome: 'server-lost' };
    if (this.now() - record.lastPollAt >= this.maxAskPollGapMs) {
      this.releaseStaleAsk(record);
      if (record.result) return { outcome: record.result.outcome };
    }
    record.lastPollAt = this.now();
    this.scheduleAskPollTimeout(record);
    const outcome = this.askOutcome(record);
    if (outcome !== 'waiting') return { outcome };
    const remaining = record.deadline - this.now();
    await this.waitForSignal(sessionId, Math.min(this.maxLongPollMs, Math.max(0, remaining)));
    if (record.result) return { outcome: record.result.outcome };
    return { outcome: this.closed ? 'server-lost' : this.askOutcome(record) };
  }

  askOutcome(record) {
    if (record.result) return record.result.outcome;
    const decision = this.state.decisionFor(record.sessionId, record.decisionId);
    const answer = decision?.answer;
    if (answer?.sentAt && Date.parse(answer.sentAt) <= record.deadline) {
      return 'answered';
    }
    if (this.away.snapshot().enabled !== true) return 'released';
    if (this.endedSessions.has(record.sessionId)) return 'released';
    if (!decision) return 'released';
    if (this.now() >= record.deadline) return 'timeout';
    return 'waiting';
  }

  finishAsk({ sessionId, toolUseId, decisionId, outcome, provider = 'claude', toolName = 'AskUserQuestion' }) {
    const record = this.askWaits.get(keyFor(sessionId, toolUseId));
    if (!record) {
      const decision = decisionId && this.state.decisionFor(sessionId, decisionId);
      if (outcome === 'server-lost' && this.away.snapshot().enabled === true) {
        if (decision) this.state.setDecisionLifecycle(sessionId, decisionId, { state: 'provisional', awaitingAnswerUntil: null }, this.now());
        return { outcome: 'server-lost', hookOutput: denyAnswerOutput(decisionId, provider, toolName, decision?.questions) };
      }
      return { outcome: 'released', hookOutput: null };
    }
    if (record.result) return record.result;
    const askOutcome = this.askOutcome(record);
    const currentOutcome = outcome === 'server-lost' && askOutcome !== 'answered'
      ? (this.away.snapshot().enabled === true ? 'server-lost' : 'released')
      : askOutcome;
    if (currentOutcome === 'waiting') return { outcome: 'waiting', hookOutput: null };
    const decision = this.state.decisionFor(sessionId, record.decisionId);
    const at = new Date(this.now()).toISOString();
    if (currentOutcome === 'released') {
      this.state.deleteDecisionLifecycle(sessionId, record.decisionId);
      this.clearAskWait(record);
      record.result = { outcome: 'released', hookOutput: null };
      return record.result;
    }

    if (currentOutcome === 'answered') {
      const answer = { ...decision.answer };
      this.state.setDecisionLifecycle(sessionId, record.decisionId, {
        answer,
        awaitingAnswerUntil: null,
      }, this.now());
      this.clearAskWait(record);
      const latest = this.state.decisionFor(sessionId, record.decisionId);
      const hookOutput = askAnswerOutput(latest, latest.answer, record.provider, record.toolName);
      if (record.provider === 'codex') {
        this.state.updateDecision(sessionId, record.decisionId, 'resolved', Object.values(askAnswers(latest, latest.answer)), latest.answer.note, this.now());
        this.afterDecisionUpdate(sessionId, record.decisionId);
      }
      record.result = { outcome: currentOutcome, hookOutput };
      return record.result;
    }

    this.state.setDecisionLifecycle(sessionId, record.decisionId, {
      state: 'provisional',
      awaitingAnswerUntil: null,
    }, this.now());
    this.clearAskWait(record);
    record.result = { outcome: outcome === 'server-lost' ? 'server-lost' : 'timeout', hookOutput: record.fallbackOutput };
    return record.result;
  }

  submitAnswer(sessionId, decisionId, choice, note, picks = []) {
    const decision = this.state.decisionFor(sessionId, decisionId);
    if (!decision || !canAnswerDecision(decision)) return null;
    if (decision.state === 'waiting' && decision.source !== 'mcp' && !decision.awaitingAnswerUntil && !decision.answer?.sentAt) return null;
    if (choice !== null && !['ok', 'pick'].includes(choice)) return false;
    if (choice === null && !note.trim()) return false;
    if (choice === 'ok' && recommendedOptions(decision).some((option) => !option)) return false;
    if (choice === 'pick' && !validPicks(decision, picks, note)) return false;
    const answer = {
      choice,
      note,
      ...(choice === 'pick' ? { picks: picks.map((labels) => [...labels]) } : {}),
      sentAt: new Date(this.now()).toISOString(),
      version: crypto.randomUUID(),
      deliveredAt: null,
      reflectedAt: null,
      promptDeliveries: 0,
    };
    const updated = this.state.setDecisionLifecycle(sessionId, decisionId, { answer }, this.now());
    this.signal(sessionId);
    return updated;
  }

  deliverPending(sessionId) {
    const pending = this.state.decisionsFor(sessionId).filter((decision) => (
      decision.answer?.sentAt && !decision.answer.deliveredAt && !decision.answer.ignoredAt && !decision.awaitingAnswerUntil && ['waiting', 'provisional'].includes(decision.state)
    ));
    if (!pending.length) return null;
    for (const decision of pending) {
      if (typeof decision.answer.version === 'string') continue;
      this.state.setDecisionLifecycle(sessionId, decision.id, {
        answer: { ...decision.answer, version: crypto.randomUUID() },
      }, this.now());
    }
    return pending.map((decision) => decisionAnswerText(this.state.decisionFor(sessionId, decision.id))).join('\n');
  }

  deliverPostToolBatch(sessionId) {
    const context = [this.deliverSessionNotifications(sessionId), this.deliverPending(sessionId), this.taskNudges.reminderFor(sessionId)].filter(Boolean);
    return context.length ? context.join('\n') : null;
  }

  notifySessions(sessionIds, message) {
    if (!Array.isArray(sessionIds) || typeof message !== 'string' || !message.trim()) return false;
    let accepted = true;
    let changed = false;
    for (const sessionId of new Set(sessionIds)) {
      if (!isStoredSessionId(sessionId)) continue;
      changed = true;
      const pending = this.pendingSessionNotifications.get(sessionId) || [];
      if (pending.length >= MAX_SESSION_NOTIFICATIONS) {
        accepted = false;
        const previous = this.pendingSessionNotificationOverflow.get(sessionId);
        this.pendingSessionNotificationOverflow.set(sessionId, {
          id: crypto.randomUUID(),
          count: (previous?.count || 0) + 1,
          updatedAt: new Date(this.now()).toISOString(),
        });
      } else {
        pending.push({ id: crypto.randomUUID(), message: message.slice(0, 8000), createdAt: new Date(this.now()).toISOString() });
        this.pendingSessionNotifications.set(sessionId, pending);
      }
      this.signal(sessionId);
    }
    if (changed) {
      this.state.touch();
      this.state.requestStoreWrite(true);
    }
    return accepted;
  }

  deliverSessionNotifications(sessionId) {
    const pending = this.pendingSessionNotifications.get(sessionId) || [];
    const overflow = this.pendingSessionNotificationOverflow.get(sessionId);
    if (!pending.length && !overflow) return null;
    const messages = pending.map((record) => record.message);
    if (overflow) messages.push(`${overflow.count} 件の通知は、未受領通知の上限に達したため登録されませんでした。ダッシュボードの最新状態を確認してください。`);
    return [...messages, SESSION_NOTIFICATION_REPLY_LANGUAGE].join('\n');
  }

  hookDeliveryRequestKey(action, requestId, generation = null) {
    return JSON.stringify([action, requestId, generation]);
  }

  getHookDelivery(sessionId, action, requestId, generation = null) {
    const records = this.pendingHookDeliveries.get(sessionId);
    if (!records) return null;
    let changed = false;
    for (const [key, record] of records) {
      if (Date.parse(record.expiresAt) <= this.now()) {
        records.delete(key);
        changed = true;
      }
    }
    if (!records.size) this.pendingHookDeliveries.delete(sessionId);
    if (changed) {
      this.state.touch();
      this.state.requestStoreWrite(true);
    }
    return records.get(this.hookDeliveryRequestKey(action, requestId, generation)) || null;
  }

  canReplayStopDelivery(sessionId, record, parentAlive = true) {
    return Number.isSafeInteger(record.generation) && parentAlive && !this.closed && !this.endedSessions.has(sessionId) &&
      this.stopGenerations.get(sessionId) === record.generation &&
      !this.state.sessionHasEnded?.(sessionId);
  }

  answerVersionsForDelivery(sessionId, action, decisionId = null, response = null) {
    let decisions;
    if (action === 'ask-finish') {
      const decision = decisionId ? this.state.decisionFor(sessionId, decisionId) : null;
      decisions = response?.outcome === 'answered' && decision ? [decision] : [];
    } else {
      decisions = this.state.decisionsFor(sessionId).filter((decision) => {
        if (action === 'user-prompt-submit') {
          return decision.answer?.sentAt && !decision.answer.reflectedAt && !decision.answer.ignoredAt &&
            !decision.awaitingAnswerUntil && decision.answer.promptDeliveries < 3 && ['waiting', 'provisional'].includes(decision.state);
        }
        return decision.answer?.sentAt && !decision.answer.deliveredAt && !decision.answer.ignoredAt &&
          !decision.awaitingAnswerUntil && ['waiting', 'provisional'].includes(decision.state);
      });
    }
    return decisions.flatMap((decision) => decision.answer?.version
      ? [{ decisionId: decision.id, version: decision.answer.version, prompt: action === 'user-prompt-submit' }]
      : []);
  }

  recordHookDelivery({ sessionId, action, requestId, response, requestGeneration = null, generation = null, decisionId = null }) {
    const requestKey = this.hookDeliveryRequestKey(action, requestId, requestGeneration);
    const existing = this.getHookDelivery(sessionId, action, requestId, requestGeneration);
    if (existing) return existing;
    let records = this.pendingHookDeliveries.get(sessionId);
    if (!records) {
      records = new Map();
      this.pendingHookDeliveries.set(sessionId, records);
    }
    const now = this.now();
    for (const [key, record] of records) {
      if (Date.parse(record.expiresAt) <= now) records.delete(key);
    }
    while (records.size >= MAX_HOOK_DELIVERY_RECORDS_PER_SESSION) {
      const oldestAcknowledged = [...records].filter(([, record]) => record.acknowledgedAt)
        .sort((left, right) => Date.parse(left[1].createdAt) - Date.parse(right[1].createdAt))[0];
      if (!oldestAcknowledged) return null;
      records.delete(oldestAcknowledged[0]);
    }
    const deliveryId = crypto.randomUUID();
    const delivery = {
      deliveryId,
      requestKey,
      action,
      requestId,
      generation: Number.isSafeInteger(generation) ? generation : null,
      response: { ...response, deliveryId },
      answerVersions: this.answerVersionsForDelivery(sessionId, action, decisionId, response),
      notificationIds: action === 'ask-finish' ? [] : (this.pendingSessionNotifications.get(sessionId) || []).map((record) => record.id),
      overflowId: action === 'ask-finish' ? null : this.pendingSessionNotificationOverflow.get(sessionId)?.id || null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + HOOK_DELIVERY_TTL_MS).toISOString(),
      acknowledgedAt: null,
    };
    records.set(requestKey, delivery);
    this.state.touch();
    this.state.requestStoreWrite(true);
    return delivery;
  }

  acknowledgeHookDelivery(sessionId, deliveryId) {
    const records = this.pendingHookDeliveries.get(sessionId);
    const record = records && [...records.values()].find((candidate) => candidate.deliveryId === deliveryId);
    if (!record) return false;
    if (record.acknowledgedAt) return true;
    const acknowledgedAt = new Date(this.now()).toISOString();
    for (const item of record.answerVersions) {
      const decision = this.state.decisionFor(sessionId, item.decisionId);
      if (decision?.answer?.version !== item.version) continue;
      const answer = {
        ...decision.answer,
        deliveredAt: decision.answer.deliveredAt || acknowledgedAt,
        ...(item.prompt ? { promptDeliveries: Math.min(3, (Number.isInteger(decision.answer.promptDeliveries) ? decision.answer.promptDeliveries : 0) + 1) } : {}),
      };
      this.state.setDecisionLifecycle(sessionId, item.decisionId, { answer }, this.now());
    }
    if (record.notificationIds.length) {
      const pending = this.pendingSessionNotifications.get(sessionId) || [];
      const retained = pending.filter((notification) => !record.notificationIds.includes(notification.id));
      if (retained.length) this.pendingSessionNotifications.set(sessionId, retained);
      else this.pendingSessionNotifications.delete(sessionId);
    }
    if (record.overflowId && this.pendingSessionNotificationOverflow.get(sessionId)?.id === record.overflowId) {
      this.pendingSessionNotificationOverflow.delete(sessionId);
    }
    record.acknowledgedAt = acknowledgedAt;
    this.state.touch();
    this.state.requestStoreWrite(true);
    return true;
  }

  deliverPrompt(sessionId, eventId, hookAt = this.now()) {
    this.taskNudges.afterEvent({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', hookAt });
    this.handleLifecycleEvent(sessionId, 'UserPromptSubmit', eventId, hookAt);
    const pending = this.state.decisionsFor(sessionId).filter((decision) => (
      decision.answer?.sentAt && !decision.answer.reflectedAt && !decision.answer.ignoredAt && !decision.awaitingAnswerUntil && decision.answer.promptDeliveries < 3 && ['waiting', 'provisional'].includes(decision.state)
    ));
    for (const decision of pending) {
      if (typeof decision.answer.version !== 'string') {
        this.state.setDecisionLifecycle(sessionId, decision.id, {
          answer: { ...decision.answer, version: crypto.randomUUID() },
        }, this.now());
      }
    }
    const messages = [this.deliverSessionNotifications(sessionId), ...pending.map((decision) => decisionAnswerText(decision))].filter(Boolean);
    return messages.length ? messages.join('\n') : null;
  }

  // stop-start のフックは 1 秒で打ち切るので、判定はここで待たず、最初の stop-poll と stop-check で待つ。
  startStop(sessionId, eventId, hookAt = this.now()) {
    if (hookAt < (this.lastLifecycleAt.get(sessionId) ?? -1)) return null;
    this.handleLifecycleEvent(sessionId, 'Stop', eventId, hookAt);
    const generation = (this.stopGenerations.get(sessionId) || 0) + 1;
    this.stopGenerations.set(sessionId, generation);
    if (this.pullRequestTracker) this.stopReviewReminders.set(sessionId, { generation, candidates: this.reviewReminderCandidates(sessionId) });
    else this.stopReviewReminders.delete(sessionId);
    this.signal(sessionId);
    return generation;
  }

  async reviewReminderCandidates(sessionId) {
    let timer;
    try {
      return await Promise.race([
        this.pullRequestTracker.missingReviewRecords(sessionId),
        new Promise((resolve) => { timer = this.setTimeout(() => resolve(null), this.reviewReminderWaitMs); }),
      ]);
    } catch {
      return null;
    } finally {
      this.clearTimeout(timer);
    }
  }

  async checkStop(sessionId, eventId, hookAt = this.now()) {
    const generation = this.startStop(sessionId, eventId, hookAt);
    if (generation === null) return { hookOutput: null, generation: null, wait: false };
    const reminder = await this.deliverReviewReminder(sessionId, generation);
    if (this.closed || this.endedSessions.has(sessionId) || this.stopGenerations.get(sessionId) !== generation) return { hookOutput: null, generation: null, wait: false };
    const reason = [reminder, this.deliverSessionNotifications(sessionId), this.deliverPending(sessionId)].filter(Boolean).join('\n');
    return {
      hookOutput: reason ? { decision: 'block', reason } : null,
      generation,
      // セッション行の無い委譲した thread を待たせると、離席中は委譲した実行がそのたびに上限まで止まるため。
      wait: !reason && this.away.snapshot().enabled === true && this.state.sessions.get(sessionId)?.provider === 'codex',
    };
  }

  // provisional は自走中に長く残るので抑止の条件にしない。記録が要るのは自走中の省略も同じため。
  async deliverReviewReminder(sessionId, generation) {
    const pending = this.stopReviewReminders.get(sessionId);
    if (pending?.generation !== generation) return null;
    this.stopReviewReminders.delete(sessionId);
    const candidates = await pending.candidates;
    if (!candidates?.length || this.closed || this.endedSessions.has(sessionId) || this.stopGenerations.get(sessionId) !== generation) return null;
    if (this.state.decisionsFor(sessionId).some((decision) => decision.state === 'waiting')) return null;
    const seen = this.remindedReviewHeads.get(sessionId) || new Set();
    const targets = candidates.filter(({ owner, repo, number, headRefOid }) => !seen.has(`${owner.toLowerCase()}/${repo.toLowerCase()}#${number}:${headRefOid.toLowerCase()}`));
    if (!targets.length) return null;
    for (const { owner, repo, number, headRefOid } of targets) {
      seen.add(`${owner.toLowerCase()}/${repo.toLowerCase()}#${number}:${headRefOid.toLowerCase()}`);
      this.diagnostics?.record('info', 'merge', 'review.reminder', { repository: `${owner}/${repo}`, number, session: sessionId.slice(0, 8) });
    }
    this.remindedReviewHeads.set(sessionId, seen);
    return [
      '次の PR には、クロスレビューの記録もレビュー不要の記録もありません:',
      ...targets.map(({ owner, repo, number }) => `PR #${number} (${owner}/${repo})。`),
      'ダッシュボードではレビュー未実施と表示され、レビューを条件にしたマージの対象になりません。レビューを省略した場合は、PR の現在の head SHA を確かめ、`cockpit_skip_review` に理由と一緒に渡して記録してください。これからレビューする場合は、対応は不要です。',
      SESSION_NOTIFICATION_REPLY_LANGUAGE,
    ].join('\n');
  }

  async waitForStopAnswer(sessionId, generation, parentAlive = true, provider = 'claude') {
    if (this.stopWaitEnded(sessionId, generation, parentAlive, provider)) return { stderrText: null, done: true };
    // 判定が無い世代では await を挟まない。挟むと合図の待ち受けの登録が遅れ、その間の合図を取りこぼすため。
    const reminder = this.stopReviewReminders.get(sessionId)?.generation === generation
      ? await this.deliverReviewReminder(sessionId, generation) : null;
    if (this.stopWaitEnded(sessionId, generation, parentAlive, provider)) return { stderrText: null, done: true };
    const text = [reminder, this.deliverSessionNotifications(sessionId), this.deliverPending(sessionId)].filter(Boolean).join('\n');
    if (text) return { stderrText: text, done: true };
    await this.waitForSignal(sessionId, this.maxLongPollMs);
    if (this.stopWaitEnded(sessionId, generation, parentAlive, provider)) return { stderrText: null, done: true };
    const nextText = [this.deliverSessionNotifications(sessionId), this.deliverPending(sessionId)].filter(Boolean).join('\n');
    return nextText ? { stderrText: nextText, done: true } : { stderrText: null, done: false };
  }

  stopWaitEnded(sessionId, generation, parentAlive, provider = 'claude') {
    return this.closed || !parentAlive || this.endedSessions.has(sessionId) || this.stopGenerations.get(sessionId) !== generation ||
      (provider === 'codex' && this.away.snapshot().enabled !== true);
  }

  handleLifecycleEvent(sessionId, eventName, eventId, hookAt = this.now()) {
    if (eventName !== 'Stop' && eventName !== 'UserPromptSubmit' && eventName !== 'SessionEnd') return;
    const key = sessionId;
    const previous = this.lastLifecycleAt.get(key) ?? -1;
    if (hookAt < previous) return;
    this.lastLifecycleAt.set(key, hookAt);
    if (eventName === 'UserPromptSubmit') {
      this.stopGenerations.set(sessionId, (this.stopGenerations.get(sessionId) || 0) + 1);
    } else if (eventName === 'SessionEnd') {
      this.endedSessions.add(sessionId);
      this.stopGenerations.set(sessionId, (this.stopGenerations.get(sessionId) || 0) + 1);
    }
    this.signal(sessionId);
  }

  sessionEnded(sessionId, endedAt = this.now()) {
    this.taskNudges.sessionEnded(sessionId);
    this.stopReviewReminders.delete(sessionId);
    this.remindedReviewHeads.delete(sessionId);
    this.handleLifecycleEvent(sessionId, 'SessionEnd', `SessionEnd:${endedAt}`, endedAt);
    this.clearSessionAskWaits(sessionId);
    // 待ちの印が残ると、再開後に送った回答が通常の配信経路から外れたままになる。
    this.state.clearAwaitingAnswers?.(sessionId, endedAt);
  }

  sessionReopened(sessionId) {
    if (this.endedSessions.has(sessionId)) this.clearSessionAskWaits(sessionId);
    this.endedSessions.delete(sessionId);
  }

  afterEvent(event) {
    const { session_id: sessionId, hook_event_name: eventName, tool_use_id: toolUseId } = event;
    if (eventName === 'SessionEnd') {
      this.sessionEnded(sessionId, event.hookAt);
      return;
    }
    this.taskNudges.afterEvent(event);
    if (eventName === 'SessionStart') {
      this.sessionReopened(sessionId);
      if (['startup', 'resume', 'clear'].includes(event.source)) this.lastLifecycleAt.delete(sessionId);
    }
    if (
      !event.agent_id && ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(eventName) &&
      event.hookAt > (this.lastLifecycleAt.get(sessionId) ?? -1)
    ) {
      this.lastLifecycleAt.set(sessionId, event.hookAt);
      this.stopGenerations.set(sessionId, (this.stopGenerations.get(sessionId) || 0) + 1);
      this.signal(sessionId);
    }
    if (eventName === 'UserPromptSubmit') {
      this.handleLifecycleEvent(sessionId, eventName, `${eventName}:${event.hookAt}`, event.hookAt);
    }
    if (eventName === 'PreToolUse' && event.tool_name === 'AskUserQuestion' && toolUseId && !event.agent_id) {
      const key = keyFor(sessionId, toolUseId);
      const decisionId = this.state.decisionIdForToolUse(sessionId, toolUseId);
      // 開始の送信と回答待ちの登録は別のフックなので、時刻の前後では同じ呼び出しかを決められない。
      // 記録より古い開始は、別の呼び出しのものでも記録を消す根拠にならない。
      if (decisionId && !this.askWaits.has(key)) {
        this.state.deleteDecisionLifecycle(sessionId, decisionId, { exceptAskToolUseId: toolUseId, updatedBefore: event.hookAt });
      }
      return;
    }
    if (!['PostToolUse', 'PostToolUseFailure'].includes(eventName) || event.tool_name !== 'AskUserQuestion' || !toolUseId || event.agent_id) return;
    const decisionId = this.state.decisionIdForToolUse(sessionId, toolUseId);
    const decision = decisionId && this.state.decisionFor(sessionId, decisionId);
    if (!decision) return;
    if (eventName === 'PostToolUseFailure') {
      this.state.setDecisionLifecycle(sessionId, decisionId, {
        ...(decision.state === 'provisional' ? {} : { state: null }),
        awaitingAnswerUntil: null,
      }, this.now());
      const record = this.askWaits.get(keyFor(sessionId, toolUseId));
      if (record) {
        record.result = { outcome: 'released', hookOutput: null };
        this.clearAskWait(record);
      }
      this.signal(sessionId);
      return;
    }
    if (decision.answer?.ignoredAt) {
      this.state.setDecisionLifecycle(sessionId, decisionId, {
        state: 'provisional',
        awaitingAnswerUntil: null,
      }, this.now());
    } else if (decision.answer?.sentAt) {
      this.state.setDecisionLifecycle(sessionId, decisionId, {
        answer: {
          ...decision.answer,
          deliveredAt: decision.answer.deliveredAt || new Date(this.now()).toISOString(),
          reflectedAt: new Date(this.now()).toISOString(),
        },
        state: null,
        awaitingAnswerUntil: null,
      }, this.now());
    }
    this.signal(sessionId);
  }

  afterDecisionUpdate(sessionId, decisionId) {
    const decision = this.state.decisionFor(sessionId, decisionId);
    if (!decision?.answer?.sentAt || !decision.answer.deliveredAt || decision.answer.ignoredAt) return;
    this.state.setDecisionLifecycle(sessionId, decisionId, {
      answer: { ...decision.answer, reflectedAt: decision.answer.reflectedAt || new Date(this.now()).toISOString() },
      state: null,
    }, this.now());
  }

  async waitForSignal(sessionId, milliseconds) {
    await new Promise((resolve) => {
      let done = false;
      let timer;
      const finish = () => {
        if (done) return;
        done = true;
        this.clearTimeout(timer);
        const listeners = this.waiters.get(sessionId);
        listeners?.delete(finish);
        if (listeners?.size === 0) this.waiters.delete(sessionId);
        resolve();
      };
      let listeners = this.waiters.get(sessionId);
      if (!listeners) {
        listeners = new Set();
        this.waiters.set(sessionId, listeners);
      }
      listeners.add(finish);
      timer = this.setTimeout(finish, Math.max(0, milliseconds));
    });
  }

  signal(sessionId) {
    const listeners = this.waiters.get(sessionId);
    if (!listeners) return;
    for (const listener of [...listeners]) listener();
  }

  signalAll() {
    for (const sessionId of [...this.waiters.keys()]) this.signal(sessionId);
  }

  close() {
    this.closed = true;
    for (const record of this.askWaits.values()) this.clearAskWait(record);
    this.signalAll();
  }

  afterTasksWrite(sessionId, writtenAt) {
    this.taskNudges.tasksWritten(sessionId, writtenAt);
  }

  clearSessionAskWaits(sessionId) {
    for (const [key, record] of this.askWaits) {
      if (record.sessionId !== sessionId) continue;
      this.clearAskWait(record);
      this.askWaits.delete(key);
    }
  }

  releaseAskWaitsForDecision(sessionId, decisionId) {
    for (const record of this.askWaits.values()) {
      if (record.sessionId !== sessionId || record.decisionId !== decisionId || record.result) continue;
      record.result = { outcome: 'released', hookOutput: null };
      this.clearAskWait(record);
    }
    this.signal(sessionId);
  }

  expireAsk(record) {
    if (this.askWaits.get(keyFor(record.sessionId, record.toolUseId)) !== record) return;
    if (this.endedSessions.has(record.sessionId)) {
      record.result = { outcome: 'released', hookOutput: null };
      this.clearAskWait(record);
      this.signal(record.sessionId);
      return;
    }
    if (this.now() < record.deadline || this.askOutcome(record) !== 'timeout') {
      this.signal(record.sessionId);
      return;
    }
    this.state.setDecisionLifecycle(record.sessionId, record.decisionId, {
      state: 'provisional',
      awaitingAnswerUntil: null,
    }, this.now());
    this.signal(record.sessionId);
  }

  clearAskWait(record) {
    this.clearTimeout(record.timer);
    this.clearTimeout(record.pollTimer);
  }

  scheduleAskPollTimeout(record) {
    this.clearTimeout(record.pollTimer);
    record.pollTimer = this.setTimeout(() => this.releaseStaleAsk(record), this.maxAskPollGapMs);
  }

  releaseStaleAsk(record) {
    if (this.askWaits.get(keyFor(record.sessionId, record.toolUseId)) !== record || record.result) return;
    const elapsed = this.now() - record.lastPollAt;
    if (elapsed < this.maxAskPollGapMs) {
      this.scheduleAskPollTimeout(record);
      return;
    }
    const decision = this.state.decisionFor(record.sessionId, record.decisionId);
    if (decision) {
      this.state.setDecisionLifecycle(record.sessionId, record.decisionId, {
        answer: null,
        ...(decision.state === 'provisional' ? {} : { state: null }),
        awaitingAnswerUntil: null,
      }, this.now());
    }
    record.result = { outcome: 'released', hookOutput: null };
    this.clearAskWait(record);
    this.signal(record.sessionId);
  }
}

module.exports = {
  ANSWER_WAIT_MS,
  MAX_LONG_POLL_MS,
  MAX_ASK_POLL_GAP_MS,
  REVIEW_REMINDER_WAIT_MS,
  DecisionAnswerDelivery,
  hasDuplicateQuestions,
  recommendedOptions,
  validPicks,
  canAnswerDecision,
  denyAnswerOutput,
  askAnswerOutput,
  decisionAnswerText,
};
