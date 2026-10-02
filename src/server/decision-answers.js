const { sanitizeQuestions } = require('./events');
const { TaskNudges } = require('./task-nudges');

const ANSWER_WAIT_MS = 5 * 60_000;
const MAX_LONG_POLL_MS = 25_000;
const MAX_ASK_POLL_GAP_MS = 30_000;
const ANSWER_HOOK_DENY_REASON = '開発者は離席中です。AskUserQuestion で尋ねずに、推奨の選択肢を適用して作業を続けてください。判断事項の id は「{id}」です。推奨で進めたら cockpit_update_decision でこの id を provisional にし、選んだ選択肢を書いてください。判断が必要だった事項と仮に適用した推奨は、最後の報告の「あなたの判断が必要なこと」に一覧で書いてください。破壊的な操作、PR のマージ、main への push は行わず、判断待ちとして残してください。';
const HOLD_CONTEXT = '開発者が判断を保留した。推奨のまま進め、あとで見直せるよう最後の報告に書いてください。';

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

function canAnswerDecision(decision) {
  return ['waiting', 'provisional'].includes(decision.state) && !hasDuplicateQuestions(decision) && decision.questions.length > 0;
}

function denyAnswerOutput(decisionId) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: ANSWER_HOOK_DENY_REASON.replace('{id}', String(decisionId || '不明').slice(0, 256).replace(/[\r\n]/g, '')),
    },
  };
}

function askAnswerOutput(decision, answer) {
  const selected = answer.choice === 'ok' || answer.choice === 'hold'
    ? recommendedOptions(decision)
    : decision.questions.map(() => null);
  if (selected.some((option) => !option) && answer.choice !== null) return denyAnswerOutput(decision.id);

  const answers = Object.fromEntries(decision.questions.map((question, index) => [
    question.question,
    answer.choice === null ? answer.note : selected[index].label,
  ]));
  const additionalContext = [];
  if (answer.choice === 'hold') additionalContext.push(HOLD_CONTEXT);
  if (answer.choice === 'ok' && answer.note) additionalContext.push(`開発者の指示: ${answer.note}`);
  if (answer.choice === 'hold' && answer.note) additionalContext.push(`開発者の指示: ${answer.note}`);
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
  const answerKind = answer.choice === 'ok' ? '推奨案で OK' : answer.choice === 'hold' ? '判断を保留(推奨のまま進め、最後の報告に書く)' : '指示のみ';
  const instruction = answer.note || 'なし';
  return `開発者がダッシュボードから判断事項 ${decision.id}「${decision.title}」に回答した: ${answerKind}。指示: ${instruction}。回答に沿って作業を直し、cockpit_update_decision で状態を更新する。`;
}

class DecisionAnswerDelivery {
  constructor({ state, away, now = Date.now, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, maxLongPollMs = MAX_LONG_POLL_MS, answerWaitMs = ANSWER_WAIT_MS, maxAskPollGapMs = MAX_ASK_POLL_GAP_MS } = {}) {
    this.state = state;
    this.away = away;
    this.now = now;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
    this.maxLongPollMs = maxLongPollMs;
    this.answerWaitMs = answerWaitMs;
    this.maxAskPollGapMs = maxAskPollGapMs;
    this.taskNudges = new TaskNudges({ state, now });
    this.askWaits = new Map();
    this.stopGenerations = new Map();
    this.lastLifecycleAt = new Map();
    this.endedSessions = new Set();
    this.waiters = new Map();
    this.closed = false;
  }

  registerAsk({ sessionId, toolUseId, questions, agentId }) {
    const awayEnabled = this.away.snapshot().enabled === true;
    if (agentId) return { awaiting: false, hookOutput: awayEnabled ? denyAnswerOutput(toolUseId) : null };
    const key = keyFor(sessionId, toolUseId);
    const existing = this.askWaits.get(key);
    if (existing) return { awaiting: true, decisionId: existing.decisionId, deadline: existing.deadline, fallbackOutput: denyAnswerOutput(existing.decisionId) };
    if (!awayEnabled) return { awaiting: false, hookOutput: null };

    const createdAt = this.now();
    const event = {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      hookAt: createdAt,
      tool_name: 'AskUserQuestion',
      tool_use_id: toolUseId,
      questions: sanitizeQuestions(questions),
    };
    if (!event.questions.length || !this.state.addEvent(event)) return { awaiting: false, hookOutput: null };
    const decisionId = this.state.decisionIdForToolUse(sessionId, toolUseId);
    if (!decisionId) return { awaiting: false, hookOutput: null };
    this.state.setDecisionLifecycle(sessionId, decisionId, {
      answer: null,
      state: null,
      awaitingAnswerUntil: null,
    }, createdAt);
    if (hasDuplicateQuestions({ questions: event.questions })) {
      this.releaseAskWaitsForDecision(sessionId, decisionId);
      this.state.setDecisionLifecycle(sessionId, decisionId, {
        answer: null,
        awaitingAnswerUntil: null,
        state: null,
      }, createdAt);
      return { awaiting: false, hookOutput: null };
    }
    const deadline = createdAt + this.answerWaitMs;
    const record = { sessionId, toolUseId, decisionId, deadline, timer: null, pollTimer: null, lastPollAt: createdAt };
    this.askWaits.set(key, record);
    record.timer = this.setTimeout(() => this.expireAsk(record), this.answerWaitMs);
    this.scheduleAskPollTimeout(record);
    this.state.setDecisionLifecycle(sessionId, decisionId, {
      answer: null,
      awaitingAnswerUntil: new Date(deadline).toISOString(),
      state: null,
    }, createdAt);
    return { awaiting: true, decisionId, deadline, fallbackOutput: denyAnswerOutput(decisionId) };
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
      if (answer.choice === 'hold' && recommendedOptions(decision).some((option) => !option)) {
        return this.away.snapshot().enabled === true ? 'timeout' : 'released';
      }
      return answer.choice === 'hold' ? 'hold' : 'answered';
    }
    if (this.away.snapshot().enabled !== true) return 'released';
    if (this.endedSessions.has(record.sessionId)) return 'released';
    if (!decision) return 'released';
    if (this.now() >= record.deadline) return 'timeout';
    return 'waiting';
  }

  finishAsk({ sessionId, toolUseId, decisionId, outcome }) {
    const record = this.askWaits.get(keyFor(sessionId, toolUseId));
    if (!record) {
      const decision = decisionId && this.state.decisionFor(sessionId, decisionId);
      if (outcome === 'server-lost' && this.away.snapshot().enabled === true) {
        if (decision) this.state.setDecisionLifecycle(sessionId, decisionId, { state: 'provisional', awaitingAnswerUntil: null }, this.now());
        return { outcome: 'server-lost', hookOutput: denyAnswerOutput(decisionId) };
      }
      return { outcome: 'released', hookOutput: null };
    }
    if (record.result) return record.result;
    const currentOutcome = outcome === 'server-lost'
      ? (this.away.snapshot().enabled === true ? 'server-lost' : 'released')
      : this.askOutcome(record);
    if (currentOutcome === 'waiting') return { outcome: 'waiting', hookOutput: null };
    const decision = this.state.decisionFor(sessionId, record.decisionId);
    const at = new Date(this.now()).toISOString();
    if (currentOutcome === 'released') {
      this.state.setDecisionLifecycle(sessionId, record.decisionId, { answer: null, awaitingAnswerUntil: null, state: null }, this.now());
      this.clearAskWait(record);
      record.result = { outcome: 'released', hookOutput: null };
      return record.result;
    }

    if (currentOutcome === 'answered' || currentOutcome === 'hold') {
      const answer = { ...decision.answer, deliveredAt: decision.answer.deliveredAt || at };
      this.state.setDecisionLifecycle(sessionId, record.decisionId, {
        answer,
        awaitingAnswerUntil: null,
        ...(currentOutcome === 'hold' ? { state: 'provisional' } : {}),
      }, this.now());
      this.clearAskWait(record);
      const latest = this.state.decisionFor(sessionId, record.decisionId);
      record.result = { outcome: currentOutcome, hookOutput: askAnswerOutput(latest, latest.answer) };
      return record.result;
    }

    this.state.setDecisionLifecycle(sessionId, record.decisionId, {
      ...(decision?.answer?.choice === 'hold' && recommendedOptions(decision).some((option) => !option)
        ? { answer: { ...decision.answer, ignoredAt: at } }
        : {}),
      state: 'provisional',
      awaitingAnswerUntil: null,
    }, this.now());
    this.clearAskWait(record);
    record.result = { outcome: outcome === 'server-lost' ? 'server-lost' : 'timeout', hookOutput: denyAnswerOutput(record.decisionId) };
    return record.result;
  }

  submitAnswer(sessionId, decisionId, choice, note) {
    const decision = this.state.decisionFor(sessionId, decisionId);
    if (!decision || !canAnswerDecision(decision)) return null;
    if (decision.state === 'waiting' && !decision.awaitingAnswerUntil && !decision.answer?.sentAt) return null;
    if (choice === null && !note.trim()) return false;
    if (choice === 'ok' && recommendedOptions(decision).some((option) => !option)) return false;
    const answer = { choice, note, sentAt: new Date(this.now()).toISOString(), deliveredAt: null, reflectedAt: null, promptDeliveries: 0 };
    const updated = this.state.setDecisionLifecycle(sessionId, decisionId, { answer }, this.now());
    this.signal(sessionId);
    return updated;
  }

  deliverPending(sessionId) {
    const pending = this.state.decisionsFor(sessionId).filter((decision) => (
      decision.answer?.sentAt && !decision.answer.deliveredAt && !decision.answer.ignoredAt && !decision.awaitingAnswerUntil && ['waiting', 'provisional'].includes(decision.state)
    ));
    if (!pending.length) return null;
    const at = new Date(this.now()).toISOString();
    const messages = pending.map((decision) => decisionAnswerText(decision));
    for (const decision of pending) {
      this.state.setDecisionLifecycle(sessionId, decision.id, {
        answer: { ...decision.answer, deliveredAt: at },
      }, this.now());
    }
    return messages.join('\n');
  }

  deliverPostToolBatch(sessionId) {
    const context = [this.deliverPending(sessionId), this.taskNudges.reminderFor(sessionId)].filter(Boolean);
    return context.length ? context.join('\n') : null;
  }

  deliverPrompt(sessionId, eventId, hookAt = this.now()) {
    this.taskNudges.afterEvent({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', hookAt });
    this.handleLifecycleEvent(sessionId, 'UserPromptSubmit', eventId, hookAt);
    const pending = this.state.decisionsFor(sessionId).filter((decision) => (
      decision.answer?.sentAt && !decision.answer.reflectedAt && !decision.answer.ignoredAt && !decision.awaitingAnswerUntil && decision.answer.promptDeliveries < 3 && ['waiting', 'provisional'].includes(decision.state)
    ));
    if (!pending.length) return null;
    const messages = pending.map((decision) => decisionAnswerText(decision));
    for (const decision of pending) {
      this.state.setDecisionLifecycle(sessionId, decision.id, {
        answer: {
          ...decision.answer,
          deliveredAt: decision.answer.deliveredAt || new Date(this.now()).toISOString(),
          promptDeliveries: decision.answer.promptDeliveries + 1,
        },
      }, this.now());
    }
    return messages.join('\n');
  }

  startStop(sessionId, eventId, hookAt = this.now()) {
    if (hookAt < (this.lastLifecycleAt.get(sessionId) ?? -1)) return null;
    this.handleLifecycleEvent(sessionId, 'Stop', eventId, hookAt);
    const generation = (this.stopGenerations.get(sessionId) || 0) + 1;
    this.stopGenerations.set(sessionId, generation);
    this.signal(sessionId);
    return generation;
  }

  async waitForStopAnswer(sessionId, generation, parentAlive = true) {
    if (this.stopWaitEnded(sessionId, generation, parentAlive)) return { stderrText: null, done: true };
    const text = this.deliverPending(sessionId);
    if (text) return { stderrText: text, done: true };
    await this.waitForSignal(sessionId, this.maxLongPollMs);
    if (this.stopWaitEnded(sessionId, generation, parentAlive)) return { stderrText: null, done: true };
    const nextText = this.deliverPending(sessionId);
    return nextText ? { stderrText: nextText, done: true } : { stderrText: null, done: false };
  }

  stopWaitEnded(sessionId, generation, parentAlive) {
    return this.closed || !parentAlive || this.endedSessions.has(sessionId) || this.stopGenerations.get(sessionId) !== generation;
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

  afterEvent(event) {
    this.taskNudges.afterEvent(event);
    const { session_id: sessionId, hook_event_name: eventName, tool_use_id: toolUseId } = event;
    if (eventName === 'SessionStart') {
      if (this.endedSessions.has(sessionId)) this.clearSessionAskWaits(sessionId);
      this.endedSessions.delete(sessionId);
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
    if (eventName === 'SessionEnd' || eventName === 'UserPromptSubmit') {
      this.handleLifecycleEvent(sessionId, eventName, `${eventName}:${event.hookAt}`, event.hookAt);
    }
    if (eventName === 'SessionEnd') this.clearSessionAskWaits(sessionId);
    if (eventName === 'PreToolUse' && event.tool_name === 'AskUserQuestion' && toolUseId && !event.agent_id) {
      const key = keyFor(sessionId, toolUseId);
      const decisionId = this.state.decisionIdForToolUse(sessionId, toolUseId);
      if (decisionId && !this.askWaits.has(key)) {
        this.state.setDecisionLifecycle(sessionId, decisionId, {
          answer: null,
          state: null,
          awaitingAnswerUntil: null,
        }, this.now());
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
    } else if (decision.answer?.choice === 'hold') {
      this.state.setDecisionLifecycle(sessionId, decisionId, {
        answer: {
          ...decision.answer,
          deliveredAt: decision.answer.deliveredAt || new Date(this.now()).toISOString(),
          reflectedAt: decision.answer.reflectedAt || new Date(this.now()).toISOString(),
        },
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
    const decision = this.state.decisionFor(record.sessionId, record.decisionId);
    this.state.setDecisionLifecycle(record.sessionId, record.decisionId, {
      ...(decision?.answer?.choice === 'hold' && recommendedOptions(decision).some((option) => !option)
        ? { answer: { ...decision.answer, ignoredAt: new Date(this.now()).toISOString() } }
        : {}),
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
  DecisionAnswerDelivery,
  hasDuplicateQuestions,
  recommendedOptions,
  canAnswerDecision,
  denyAnswerOutput,
  askAnswerOutput,
  decisionAnswerText,
};
