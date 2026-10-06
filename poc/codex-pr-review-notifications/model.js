'use strict';

const CONTRACT = require('./fixture-contract');
const { createHash } = require('node:crypto');
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const CONFIG = ['vendor', 'model', 'effort', 'transport'];
const EXEC_FIELDS = ['provider', 'launchId', 'runId', 'attemptId'];
const PARENT_FIELDS = ['provider', 'sessionId', 'agentId', 'toolUseId'];
const key = (parts) => JSON.stringify(parts);
const validId = (value) => typeof value === 'string' && ID.test(value);
const validSha = (value) => typeof value === 'string' && SHA.test(value);
const obj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const execKey = (run) => key([run.provider, run.launchId, run.runId, run.attemptId]);
const prKey = (pr) => key([pr.owner, pr.repo, pr.number]);

function identity(value) {
  if (!obj(value) || Object.keys(value).length !== EXEC_FIELDS.length
    || !EXEC_FIELDS.every((field) => Object.hasOwn(value, field) && validId(value[field]))
    || !CONTRACT.providers.includes(value.provider)) return null;
  return Object.fromEntries(EXEC_FIELDS.map((field) => [field, value[field]]));
}
function parentIdentity(value) {
  if (value === undefined || value === null) return null;
  if (!obj(value) || Object.keys(value).length !== PARENT_FIELDS.length
    || !PARENT_FIELDS.every((field) => Object.hasOwn(value, field) && validId(value[field]))
    || !CONTRACT.providers.includes(value.provider)) return null;
  return Object.fromEntries(PARENT_FIELDS.map((field) => [field, value[field]]));
}
function config(value) {
  if (!obj(value) || Object.keys(value).length !== CONFIG.length
    || !CONFIG.every((field) => typeof value[field] === 'string' && value[field].trim() === value[field]
      && value[field].length > 0 && value[field].length <= 128)) return null;
  return Object.fromEntries(CONFIG.map((field) => [field, value[field]]));
}
function pullRequest(value) {
  if (!obj(value) || typeof value.owner !== 'string' || !value.owner.trim()
    || typeof value.repo !== 'string' || !value.repo.trim()
    || !Number.isSafeInteger(value.number) || value.number < 1) return null;
  return { owner: value.owner.toLowerCase(), repo: value.repo.toLowerCase(), number: value.number };
}
function branch(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && !value.startsWith('-') ? value : null;
}
function nativeIdentity(value) {
  const fields = ['provider', 'vendor', 'scope', 'nativeId'];
  if (!obj(value) || Object.keys(value).length !== fields.length
    || !fields.every((field) => Object.hasOwn(value, field) && validId(value[field]))
    || !CONTRACT.providers.includes(value.provider)) return null;
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}
function nativeKey(value) {
  return key([value.provider, value.vendor, value.scope, value.nativeId]);
}
function result(accepted, reason, extra = {}) {
  return { accepted, reason, ...extra };
}

class PrReviewModel {
  constructor(options = {}) {
    if (!obj(options)) throw new TypeError('options must be an object');
    this.routing = config(options.configuration || {
      vendor: 'codex', model: 'fixture-model', effort: 'medium', transport: 'fixture',
    });
    if (!this.routing) throw new TypeError('invalid routing configuration');
    this.runs = new Map();
    this.native = new Map();
    this.observations = new Set();
    this.prs = new Map();
    this.stacked = new Map();
    this.rounds = new Map();
    this.lanes = new Map();
    this.reservations = new Map();
    this.outbox = new Map();
  }

  updateRouting(value) {
    const next = config(value);
    if (!next) return false;
    this.routing = next;
    return true;
  }

  registerExecution(input) {
    if (!obj(input)) return null;
    const run = identity(Object.fromEntries(EXEC_FIELDS.map((field) => [field, input[field]])));
    const parent = parentIdentity(input.parent);
    const route = config(input.configuration || this.routing);
    if (!run || !route || !CONTRACT.origins.includes(input.origin) || !CONTRACT.purposes.includes(input.purpose)
      || input.parent !== undefined && input.parent !== null && !parent
      || input.origin === 'delegated' && !parent) return null;
    const runKey = execKey(run);
    const record = {
      identity: run, origin: input.origin, purpose: input.purpose, parent, routing: route,
      parentState: parent ? 'running' : null, runState: 'running', childEnded: false, resultReceived: false,
      parentReturned: false, cancelState: 'none', resultId: null, resultDigest: null, sources: new Set(),
    };
    if (this.runs.has(runKey)) return null;
    this.runs.set(runKey, record);
    return clone(run);
  }

  bindNative(input) {
    if (!obj(input)) return false;
    const run = identity(input.execution);
    const nativeId = nativeIdentity(input.nativeIdentity);
    if (!run || !nativeId || run.provider !== nativeId.provider || !this.runs.has(execKey(run))
      || this.runs.get(execKey(run)).routing.vendor !== nativeId.vendor) return false;
    const nkey = nativeKey(nativeId);
    const prior = this.native.get(nkey);
    if (prior && prior !== execKey(run)) return false;
    this.native.set(nkey, execKey(run));
    this.runs.get(execKey(run)).sources.add('native');
    return true;
  }

  observe(input) {
    if (!obj(input) || !CONTRACT.observationSources.includes(input.source) || !validId(input.eventId)) return false;
    let run;
    if (input.source === 'native') {
      const nativeId = nativeIdentity(input.nativeIdentity);
      if (!nativeId) return false;
      const boundKey = this.native.get(nativeKey(nativeId));
      if (!boundKey) return false;
      run = this.runs.get(boundKey).identity;
      if (input.execution !== undefined) {
        const claimed = identity(input.execution);
        if (!claimed || execKey(claimed) !== boundKey) return false;
      }
    } else {
      run = identity(input.execution);
    }
    if (!run || !this.runs.has(execKey(run))) return false;
    const observationKey = key([execKey(run), input.source, input.eventId]);
    if (this.observations.has(observationKey)) return true;
    this.observations.add(observationKey);
    this.runs.get(execKey(run)).sources.add(input.source);
    return true;
  }

  setExecutionState(runInput, state) {
    const record = this.getRun(runInput);
    if (!record || !['running', 'stopped', 'ended'].includes(state)
      || record.runState === 'ended' && state !== 'ended'
      || state === 'running' && record.parentState === 'ended') return false;
    record.runState = state;
    return true;
  }

  setParentState(runInput, state) {
    const run = identity(runInput);
    const record = run && this.runs.get(execKey(run));
    if (!record || !record.parent || !['running', 'stopped', 'ended'].includes(state)
      || record.parentState === 'ended' && state !== 'ended') return false;
    record.parentState = state;
    return true;
  }
  receiveResult(runInput, evidence) {
    const record = this.getRun(runInput);
    if (!record || !obj(evidence) || !validId(evidence.resultId) || !validSha(evidence.resultDigest)) return false;
    if (record.resultReceived) {
      return record.resultId === evidence.resultId
        && record.resultDigest === evidence.resultDigest.toLowerCase();
    }
    if (record.childEnded || record.runState === 'ended') return false;
    record.resultReceived = true;
    record.resultId = evidence.resultId;
    record.resultDigest = evidence.resultDigest.toLowerCase();
    return true;
  }
  confirmChildEnded(runInput) {
    const record = this.getRun(runInput);
    if (!record) return false;
    record.childEnded = true;
    record.runState = 'ended';
    return true;
  }
  returnResult(runInput) {
    const record = this.getRun(runInput);
    if (!record || !record.parent || record.parentState !== 'running' || !record.childEnded
      || !record.resultReceived || record.cancelState !== 'none') return false;
    record.parentReturned = true;
    return true;
  }
  requestCancel(runInput) {
    const record = this.getRun(runInput);
    if (!record || record.parentReturned || record.parentState === 'ended' || record.childEnded
      || record.runState === 'ended' || record.cancelState === 'confirmed') return false;
    record.cancelState = 'requested';
    return true;
  }
  confirmCancel(runInput) {
    const record = this.getRun(runInput);
    if (!record || record.cancelState !== 'requested' || !record.childEnded) return false;
    record.cancelState = 'confirmed';
    return true;
  }
  lifecycle(runInput) {
    const record = this.getRun(runInput);
    if (!record) return null;
    return {
      parentState: record.parentState, runState: record.runState, childEnded: record.childEnded,
      resultReceived: record.resultReceived, parentReturned: record.parentReturned,
      cancelState: record.cancelState,
      successfulReturn: record.parentReturned && record.childEnded && record.resultReceived,
    };
  }

  registerPr(input) {
    if (!obj(input) || !CONTRACT.registrationSources.includes(input.source)) return null;
    const pr = pullRequest(input);
    const createdBy = input.createdBy == null ? null : identity(input.createdBy);
    const registeredBy = input.registeredBy == null ? null : identity(input.registeredBy);
    if (!pr || input.createdBy != null && !createdBy || input.registeredBy != null && !registeredBy
      || createdBy && !this.runs.has(execKey(createdBy))
      || registeredBy && !this.runs.has(execKey(registeredBy))) return null;
    const pkey = prKey(pr);
    let record = this.prs.get(pkey);
    if (!record) {
      record = {
        pr, sources: new Set(), origins: new Map(), targets: new Map(),
        base: null, head: null, mergeState: 'open', mergeMethod: null,
      };
      this.prs.set(pkey, record);
    }
    record.sources.add(input.source);
    if (createdBy) {
      record.origins.set(key([input.source, execKey(createdBy)]), { source: input.source, run: createdBy });
      record.targets.set(execKey(createdBy), createdBy);
    }
    if (registeredBy) record.targets.set(execKey(registeredBy), registeredBy);
    return this.prProjection(record);
  }

  registerStackedPr(input) {
    if (!obj(input)) return false;
    const lower = pullRequest(input.lowerPr);
    const upper = pullRequest(input.stackedPr);
    if (!lower || !upper || prKey(lower) === prKey(upper)
      || lower.owner !== upper.owner || lower.repo !== upper.repo
      || !this.prs.has(prKey(lower)) || !this.prs.has(prKey(upper))) return false;
    let targets = this.stacked.get(prKey(lower));
    if (!targets) {
      targets = new Map();
      this.stacked.set(prKey(lower), targets);
    }
    targets.set(prKey(upper), upper);
    return true;
  }

  setPrState(input) {
    const pr = pullRequest(input);
    if (!pr || !branch(input.base) || !validSha(input.head)) return false;
    const record = this.prs.get(prKey(pr));
    if (!record || record.mergeState === 'merged') return false;
    const nextHead = input.head.toLowerCase();
    if (record.mergeState === 'conflict' && record.head !== nextHead) record.mergeState = 'open';
    record.base = input.base;
    record.head = nextHead;
    return true;
  }

  startReview(input) {
    const pr = pullRequest(input.pr);
    const run = identity(input.run);
    const refBranch = branch(input.branch);
    const round = Number.isSafeInteger(input.round) && input.round > 0 ? input.round : null;
    if (!pr || !run || !refBranch || !validId(input.roundId) || !round
      || !this.prs.has(prKey(pr)) || this.runs.get(execKey(run))?.purpose !== 'review') return null;
    const lane = key([prKey(pr), refBranch]);
    const current = this.lanes.get(lane) || [];
    if (current.some((entry) => entry.round === round)
      || [...this.rounds.values()].some((entry) => execKey(entry.run) === execKey(run))) return null;
    const entry = {
      pr, branch: refBranch, run, round, roundId: input.roundId,
      status: 'in_progress', conclusion: null, reviewedHead: null, convergenceHead: null,
    };
    const roundKey = key([lane, round, input.roundId, execKey(run)]);
    this.rounds.set(roundKey, entry);
    this.lanes.set(lane, [...current, { round, roundKey }].sort((a, b) => a.round - b.round));
    return this.reviewProjection(entry);
  }

  concludeReview(input) {
    const pr = pullRequest(input.pr);
    const run = identity(input.run);
    const refBranch = branch(input.branch);
    const lane = pr && refBranch ? key([prKey(pr), refBranch]) : null;
    const roundKey = lane && key([lane, input.round, input.roundId, run && execKey(run)]);
    const entry = roundKey && this.rounds.get(roundKey);
    if (!entry || entry.status !== 'in_progress' || !validSha(input.reviewedHead)
      || !CONTRACT.reviewConclusions.includes(input.conclusion)) return false;
    const convergence = input.convergenceHead == null ? null
      : (validSha(input.convergenceHead) ? input.convergenceHead.toLowerCase() : false);
    if (convergence === false
      || input.conclusion === 'success' && convergence !== input.reviewedHead.toLowerCase()
      || input.conclusion !== 'success' && convergence !== null) return false;
    entry.status = 'concluded';
    entry.conclusion = input.conclusion;
    entry.reviewedHead = input.reviewedHead.toLowerCase();
    entry.convergenceHead = convergence;
    return true;
  }

  reserveMerge(input) {
    if (!obj(input)) return result(false, 'invalid_input');
    const pr = pullRequest(input.pr);
    const refBranch = branch(input.branch);
    const record = pr && this.prs.get(prKey(pr));
    if (!record || !refBranch || !branch(input.defaultBranch) || !validSha(input.screenHead)) {
      return result(false, 'invalid_input');
    }
    if (record.base !== input.defaultBranch) return result(false, 'not_lowest_pr');
    if (!record.head || record.head !== input.screenHead.toLowerCase()) return result(false, 'screen_head_stale');
    const reservationKey = key([prKey(pr), refBranch]);
    const currentReservation = this.reservations.get(reservationKey);
    if (currentReservation && currentReservation.active) return result(false, 'reservation_exists');
    const reservation = { pr, branch: refBranch, active: true, confirmedHead: record.head };
    this.reservations.set(reservationKey, reservation);
    return result(true, 'reserved');
  }

  cancelMerge(input) {
    const pr = pullRequest(input.pr);
    const refBranch = branch(input.branch);
    const reservation = pr && refBranch && this.reservations.get(key([prKey(pr), refBranch]));
    if (!reservation || !reservation.active) return false;
    const lower = this.prs.get(prKey(pr));
    if (lower && lower.mergeState === 'in_flight') return false;
    reservation.active = false;
    return true;
  }

  async attemptMerge(input, gh) {
    const pr = pullRequest(input.pr);
    const record = pr && this.prs.get(prKey(pr));
    if (!record || !branch(input.defaultBranch)) return result(false, 'invalid_input');
    if (record.base !== input.defaultBranch) return result(false, 'not_lowest_pr');
    if (!record.head || ['merged', 'unknown', 'queued', 'in_flight', 'conflict'].includes(record.mergeState)) return result(false, 'state_unavailable');
    let expectedHead;
    let suffix;
    if (input.mode === 'manual') {
      if (!validSha(input.screenHead) || input.screenHead.toLowerCase() !== record.head) return result(false, 'screen_head_stale');
      expectedHead = input.screenHead.toLowerCase();
      suffix = 'screen';
    } else if (input.mode === 'review_reservation') {
      const refBranch = branch(input.branch);
      const reservation = refBranch && this.reservations.get(key([prKey(pr), refBranch]));
      if (!reservation || !reservation.active) return result(false, 'reservation_missing');
      const rounds = this.lanes.get(key([prKey(pr), refBranch])) || [];
      const latest = rounds.length && this.rounds.get(rounds[rounds.length - 1].roundKey);
      if (!latest) return result(false, 'no_review_round');
      if (latest.status !== 'concluded') return result(false, 'latest_round_unfinished');
      if (latest.conclusion !== 'success') return result(false, 'latest_round_not_successful');
      if (latest.convergenceHead !== record.head) return result(false, 'head_not_converged');
      expectedHead = latest.convergenceHead;
      suffix = 'review-' + latest.round + '-' + latest.roundId;
    } else return result(false, 'invalid_mode');

    if (!gh || gh.kind !== 'fixture' || typeof gh.merge !== 'function') return result(false, 'fixture_gh_required');
    record.mergeState = 'in_flight';
    let response;
    try {
      response = await gh.merge({
        owner: pr.owner, repo: pr.repo, number: pr.number,
        expectedHead, base: record.base, mode: input.mode,
      });
    } catch {
      response = { status: 'READ_FAILED' };
    }
    const digest = createHash('sha256').update(JSON.stringify([prKey(pr), suffix, expectedHead])).digest('hex');
    const eventId = 'pr-' + digest;
    if (record.head !== expectedHead) {
      record.mergeState = 'unknown';
      this.notifyPr(pr, { eventId: eventId + '-unknown', type: 'merge', payload: { status: 'unknown' } });
      return result(true, 'merge_unknown');
    }
    if (!obj(response) || !CONTRACT.mergeOutcomes.includes(response.status) || response.status === 'READ_FAILED') {
      record.mergeState = 'unknown';
      this.notifyPr(pr, { eventId: eventId + '-unknown', type: 'merge', payload: { status: 'unknown' } });
      return result(true, 'merge_unknown');
    }
    if (response.status === 'OPEN') {
      record.mergeState = 'queued';
      this.notifyPr(pr, { eventId: eventId + '-queue', type: 'queue', payload: { status: 'open' } });
      return result(true, 'merge_queued');
    }
    if (response.status === 'CONFLICT') {
      record.mergeState = 'conflict';
      this.notifyPr(pr, { eventId: eventId + '-conflict', type: 'conflict', payload: { status: 'conflict' } });
      return result(true, 'merge_conflict');
    }
    record.mergeState = 'merged';
    const method = CONTRACT.mergeMethods.includes(response.method) ? response.method : null;
    record.mergeMethod = method;
    this.notifyPr(pr, { eventId: eventId + '-merged', type: 'merge', payload: { status: 'merged' } });
    if (method === 'squash' || method === 'rebase') {
      for (const stackedPr of (this.stacked.get(prKey(pr)) || new Map()).values()) {
        this.notifyPr(stackedPr, {
          eventId: eventId + '-restack-' + method,
          type: 'restack',
          payload: { method, mergedPr: pr },
        });
      }
    }
    return result(true, 'merged', { method });
  }

  enqueueNotification(input) {
    if (!obj(input) || !validId(input.eventId) || !CONTRACT.notificationTypes.includes(input.type)) {
      return result(false, 'invalid_notification');
    }
    const pr = pullRequest(input.pr);
    const target = identity(input.target);
    const source = input.source == null ? null : identity(input.source);
    const payload = input.payload == null ? null : input.payload;
    if (!pr || !target || input.source != null && !source || payload !== null && !obj(payload)
      || !this.runs.has(execKey(target)) || source && !this.runs.has(execKey(source))) {
      return result(false, 'invalid_notification');
    }
    const nkey = key([input.eventId, execKey(target)]);
    const fingerprint = JSON.stringify([input.type, prKey(pr), payload]);
    const existing = this.outbox.get(nkey);
    if (existing) return existing.fingerprint === fingerprint
      ? result(false, 'duplicate', { state: existing.state })
      : result(false, 'event_id_conflict', { state: existing.state });
    this.outbox.set(nkey, {
      eventId: input.eventId, type: input.type, pr, target, source, payload: clone(payload),
      state: 'queued', fingerprint,
    });
    return result(true, 'queued', { state: 'queued' });
  }

  notificationHandoff(input) {
    const entry = this.getNotification(input);
    if (!entry || entry.state !== 'queued') return false;
    const target = this.runs.get(execKey(entry.target));
    if (!target || target.runState !== 'running' || target.childEnded || target.cancelState !== 'none'
      || target.parent && target.parentState !== 'running') return false;
    entry.state = 'handed_off';
    return true;
  }
  acknowledgeNotification(input) {
    const entry = this.getNotification(input);
    if (!entry || entry.state !== 'handed_off') return false;
    entry.state = 'acknowledged';
    return true;
  }
  markNotificationUnknown(input) {
    const entry = this.getNotification(input);
    if (!entry || entry.state !== 'handed_off') return false;
    entry.state = 'unknown';
    return true;
  }
  notifyPr(prInput, event) {
    const pr = pullRequest(prInput);
    const record = pr && this.prs.get(prKey(pr));
    if (!record) return [];
    return [...record.targets.values()].map((target) => this.enqueueNotification({
      eventId: event.eventId, type: event.type, pr, target, payload: event.payload,
    }));
  }

  snapshot() {
    return {
      schema: CONTRACT.schema,
      version: 1,
      routing: clone(this.routing),
      runs: [...this.runs.values()].map((run) => ({
        identity: clone(run.identity), origin: run.origin, purpose: run.purpose,
        parent: clone(run.parent), routing: clone(run.routing), parentState: run.parentState,
        runState: run.runState, childEnded: run.childEnded, resultReceived: run.resultReceived,
        parentReturned: run.parentReturned, cancelState: run.cancelState,
        resultId: run.resultId, resultDigest: run.resultDigest, sources: [...run.sources],
      })),
      outbox: [...this.outbox.values()].map((entry) => ({ ...clone(entry) })),
    };
  }

  static restore(snapshot) {
    if (!obj(snapshot) || snapshot.schema !== CONTRACT.schema || snapshot.version !== 1
      || !Array.isArray(snapshot.runs) || !Array.isArray(snapshot.outbox)) return null;
    let model;
    try { model = new PrReviewModel({ configuration: snapshot.routing }); } catch { return null; }
    for (const row of snapshot.runs) {
      if (!obj(row)) return null;
      const run = model.registerExecution({
        ...row.identity, origin: row.origin, purpose: row.purpose,
        parent: row.parent, configuration: row.routing,
      });
      if (!run || !['running', 'stopped', 'ended', 'unknown', null].includes(row.parentState)
        || !['running', 'stopped', 'ended', 'unknown'].includes(row.runState)
        || typeof row.childEnded !== 'boolean' || typeof row.resultReceived !== 'boolean'
        || typeof row.parentReturned !== 'boolean' || !['none', 'requested', 'confirmed'].includes(row.cancelState)
        || row.resultReceived && (!validId(row.resultId) || !validSha(row.resultDigest))
        || !row.resultReceived && (row.resultId !== null || row.resultDigest !== null)
        || !Array.isArray(row.sources) || row.sources.some((item) => !CONTRACT.observationSources.includes(item))) return null;
      const stored = model.runs.get(execKey(run));
      stored.parentState = stored.parent
        ? (row.parentState === 'ended' ? 'ended' : 'unknown') : null;
      stored.runState = row.runState === 'ended' || row.childEnded ? 'ended' : 'unknown';
      stored.childEnded = row.childEnded;
      stored.resultReceived = row.resultReceived;
      stored.parentReturned = row.parentReturned;
      stored.cancelState = row.cancelState;
      stored.resultId = row.resultId;
      stored.resultDigest = row.resultDigest === null ? null : row.resultDigest.toLowerCase();
      stored.sources = new Set(row.sources);
    }
    for (const row of snapshot.outbox) {
      if (!obj(row) || !CONTRACT.notificationStates.includes(row.state)) return null;
      const enqueued = model.enqueueNotification(row);
      if (!enqueued.accepted) return null;
      model.outbox.get(key([row.eventId, execKey(row.target)])).state = row.state === 'handed_off' ? 'unknown' : row.state;
    }
    return model;
  }

  project() {
    return {
      evidenceKind: CONTRACT.evidenceKind,
      executions: [...this.runs.values()].map((run) => ({
        identity: clone(run.identity), origin: run.origin, purpose: run.purpose,
        parent: clone(run.parent), routing: clone(run.routing), runState: run.runState,
        sources: [...run.sources].sort(),
        lifecycle: this.lifecycle(run.identity),
      })),
      pullRequests: [...this.prs.values()].map((record) => this.prProjection(record)),
      reviewRounds: [...this.rounds.values()].map((entry) => this.reviewProjection(entry)),
      notifications: [...this.outbox.values()].map((entry) => ({
        eventId: entry.eventId, type: entry.type, pr: clone(entry.pr),
        target: clone(entry.target), state: entry.state, payload: clone(entry.payload),
      })),
    };
  }

  getRun(input) {
    const run = identity(input);
    return run ? this.runs.get(execKey(run)) || null : null;
  }
  getNotification(input) {
    if (!obj(input) || !validId(input.eventId)) return null;
    const target = identity(input.target);
    return target ? this.outbox.get(key([input.eventId, execKey(target)])) || null : null;
  }
  prProjection(record) {
    return {
      ...clone(record.pr), key: prKey(record.pr),
      registrationSources: [...record.sources].sort(),
      creationOrigins: [...record.origins.values()].map((item) => ({
        source: item.source, run: clone(item.run),
      })),
      notificationTargets: [...record.targets.values()].map(clone)
        .sort((left, right) => execKey(left).localeCompare(execKey(right))),
      base: record.base, head: record.head, mergeState: record.mergeState,
      mergeMethod: record.mergeMethod,
    };
  }
  reviewProjection(entry) {
    return {
      pr: clone(entry.pr), branch: entry.branch, run: clone(entry.run),
      round: entry.round, roundId: entry.roundId, status: entry.status,
      conclusion: entry.conclusion, reviewedHead: entry.reviewedHead,
      convergenceHead: entry.convergenceHead,
    };
  }
}

module.exports = { PrReviewModel, execKey, prKey, identity };
