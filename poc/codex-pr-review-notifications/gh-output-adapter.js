'use strict';

const CONTRACT = require('./fixture-contract');

const EXECUTION_FIELDS = ['provider', 'launchId', 'runId', 'attemptId'];
const NATIVE_FIELDS = ['provider', 'vendor', 'scope', 'nativeId'];
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const SOURCES_BY_ORIGIN = { independent: 'independent_codex_gh', delegated: 'delegated_codex_gh' };

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasStringFields(value, fields) {
  return isRecord(value) && Object.keys(value).length === fields.length
    && fields.every((field) => typeof value[field] === 'string');
}

function sameFields(left, right, fields) {
  return hasStringFields(left, fields) && hasStringFields(right, fields)
    && fields.every((field) => left[field] === right[field]);
}

function identityKey(value, fields) {
  return JSON.stringify(fields.map((field) => value[field]));
}

function pullRequestKey(pr) {
  return JSON.stringify([pr.owner.toLowerCase(), pr.repo.toLowerCase(), pr.number]);
}

function findPullRequests(output) {
  const urlPattern = /(?:^|[\s"'(<])https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)(?:\/)?(?=$|[\s"'<>),.;!?])/g;
  const matches = new Map();
  let match;
  while ((match = urlPattern.exec(output)) !== null) {
    const number = Number(match[3]);
    if (!Number.isSafeInteger(number)) continue;
    const pr = { owner: match[1], repo: match[2], number };
    matches.set(pullRequestKey(pr), pr);
  }
  return [...matches.values()];
}

class GhOutputRegistrationAdapter {
  constructor({ model, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
    if (!model || typeof model.getRun !== 'function' || typeof model.bindNative !== 'function'
      || typeof model.registerPr !== 'function' || typeof model.project !== 'function'
      || model.project().evidenceKind !== CONTRACT.evidenceKind) throw new TypeError('a PR review fixture model is required');
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
      throw new TypeError('maxOutputBytes must be a positive safe integer');
    }
    this.model = model;
    this.maxOutputBytes = maxOutputBytes;
    this.sourceItems = new Map();
    this.registeredItems = new Map();
  }

  bindSourceItem({ sourceItemId, execution, nativeIdentity } = {}) {
    if (typeof sourceItemId !== 'string' || !ITEM_ID.test(sourceItemId)) return false;
    const run = this.model.getRun(execution);
    if (!run || !sameFields(run.identity, execution, EXECUTION_FIELDS)
      || run.identity.provider !== 'codex' || run.purpose !== 'work'
      || !SOURCES_BY_ORIGIN[run.origin] || !hasStringFields(nativeIdentity, NATIVE_FIELDS)) return false;

    const binding = {
      execution: Object.fromEntries(EXECUTION_FIELDS.map((field) => [field, run.identity[field]])),
      nativeIdentity: Object.fromEntries(NATIVE_FIELDS.map((field) => [field, nativeIdentity[field]])),
      source: SOURCES_BY_ORIGIN[run.origin],
    };
    const prior = this.sourceItems.get(sourceItemId);
    if (prior && (identityKey(prior.execution, EXECUTION_FIELDS) !== identityKey(binding.execution, EXECUTION_FIELDS)
      || identityKey(prior.nativeIdentity, NATIVE_FIELDS) !== identityKey(binding.nativeIdentity, NATIVE_FIELDS))) return false;
    if (!this.model.bindNative({ execution: binding.execution, nativeIdentity: binding.nativeIdentity })) return false;
    this.sourceItems.set(sourceItemId, binding);
    return true;
  }

  observeCommandExecution(event) {
    if (!isRecord(event) || event.kind !== 'commandExecution') return { accepted: false, reason: 'invalid_event' };
    if (event.status !== 'completed') return { accepted: false, reason: 'execution_incomplete' };
    if (typeof event.sourceItemId !== 'string' || !ITEM_ID.test(event.sourceItemId)
      || !hasStringFields(event.nativeIdentity, NATIVE_FIELDS)
      || !hasStringFields(event.execution, EXECUTION_FIELDS)) {
      return { accepted: false, reason: 'missing_execution_binding' };
    }

    const binding = this.sourceItems.get(event.sourceItemId);
    if (!binding) return { accepted: false, reason: 'source_item_unbound' };
    const run = this.model.getRun(event.execution);
    if (!run) return { accepted: false, reason: 'execution_unregistered' };
    if (!sameFields(run.identity, event.execution, EXECUTION_FIELDS)
      || identityKey(binding.execution, EXECUTION_FIELDS) !== identityKey(event.execution, EXECUTION_FIELDS)
      || identityKey(binding.nativeIdentity, NATIVE_FIELDS) !== identityKey(event.nativeIdentity, NATIVE_FIELDS)) {
      return { accepted: false, reason: 'execution_binding_mismatch' };
    }
    if (!Array.isArray(event.argv) || event.argv.length < 3
      || event.argv[0] !== 'gh' && event.argv[0] !== 'gh.exe'
      || event.argv[1] !== 'pr' || event.argv[2] !== 'create'
      || event.argv.some((part) => typeof part !== 'string')) {
      return { accepted: false, reason: 'not_gh_pr_create' };
    }
    if (event.exitCode !== 0) return { accepted: false, reason: 'command_failed' };
    if (typeof event.aggregatedOutput !== 'string') return { accepted: false, reason: 'output_missing' };
    if (Buffer.byteLength(event.aggregatedOutput, 'utf8') > this.maxOutputBytes) {
      return { accepted: false, reason: 'output_too_large' };
    }

    const pullRequests = findPullRequests(event.aggregatedOutput);
    if (pullRequests.length === 0) return { accepted: false, reason: 'pull_request_url_missing' };
    if (pullRequests.length > 1) return { accepted: false, reason: 'ambiguous_pull_request_urls' };

    const [pr] = pullRequests;
    const prior = this.registeredItems.get(event.sourceItemId);
    if (prior) {
      if (prior.key !== pullRequestKey(pr)) return { accepted: false, reason: 'source_item_already_registered' };
      return { accepted: true, reason: 'duplicate', evidenceKind: CONTRACT.evidenceKind, pullRequest: prior.pullRequest };
    }

    const pullRequest = this.model.registerPr({
      ...pr,
      source: binding.source,
      createdBy: binding.execution,
      registeredBy: binding.execution,
    });
    if (!pullRequest) return { accepted: false, reason: 'registration_rejected' };
    this.registeredItems.set(event.sourceItemId, { key: pullRequestKey(pr), pullRequest });
    return { accepted: true, reason: 'registered', evidenceKind: CONTRACT.evidenceKind, pullRequest };
  }
}

module.exports = { GhOutputRegistrationAdapter, DEFAULT_MAX_OUTPUT_BYTES };
