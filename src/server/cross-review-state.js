'use strict';

const TRIAGE_OUTCOMES = new Set(['fixing', 'converged', 'halted']);

function stateIssue(issues, path, code, value) {
  if (value !== undefined) issues.push({ path, code });
}

function isStateObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLastTriage(value, issues, path) {
  if (value == null) return null;
  if (!isStateObject(value)) {
    stateIssue(issues, path, 'invalid-type', value);
    return null;
  }
  if (!Number.isSafeInteger(value.round) || value.round < 1) {
    stateIssue(issues, [...path, 'round'], typeof value.round === 'number' ? 'out-of-range' : 'invalid-type', value.round);
    return null;
  }
  if (typeof value.sha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value.sha)) {
    stateIssue(issues, [...path, 'sha'], typeof value.sha === 'string' ? 'invalid-format' : 'invalid-type', value.sha);
    return null;
  }
  if (!TRIAGE_OUTCOMES.has(value.outcome)) {
    stateIssue(issues, [...path, 'outcome'], 'invalid-value', value.outcome);
    return null;
  }
  return { round: value.round, sha: value.sha.toLowerCase(), outcome: value.outcome };
}

function normalizeState(raw, issues) {
  const state = { branches: {} };
  if (!isStateObject(raw)) {
    stateIssue(issues, [], 'invalid-type', raw);
    return state;
  }
  if (!isStateObject(raw.branches)) {
    stateIssue(issues, ['branches'], 'invalid-type', raw.branches);
    return state;
  }
  for (const [name, value] of Object.entries(raw.branches)) {
    const path = ['branches', name];
    if (!name) {
      stateIssue(issues, path, 'invalid-format', name);
      continue;
    }
    if (!isStateObject(value)) stateIssue(issues, path, 'invalid-type', value);
    const branch = isStateObject(value) ? value : {};
    const round = Number.isSafeInteger(branch.round) && branch.round >= 0 ? branch.round : 0;
    if (!Number.isSafeInteger(branch.round) || branch.round < 0) {
      stateIssue(issues, [...path, 'round'], typeof branch.round === 'number' ? 'out-of-range' : 'invalid-type', branch.round);
    }
    const lastReviewedSha = typeof branch.lastReviewedSha === 'string' && branch.lastReviewedSha.trim()
      ? branch.lastReviewedSha.trim() : null;
    if (branch.lastReviewedSha != null && lastReviewedSha === null) {
      stateIssue(issues, [...path, 'lastReviewedSha'], typeof branch.lastReviewedSha === 'string' ? 'invalid-format' : 'invalid-type', branch.lastReviewedSha);
    }
    const dismissed = [];
    if (Array.isArray(branch.dismissed)) {
      branch.dismissed.forEach((summary, index) => {
        if (typeof summary === 'string' && summary.trim()) dismissed.push(summary.trim());
        else stateIssue(issues, [...path, 'dismissed', index], typeof summary === 'string' ? 'invalid-format' : 'invalid-type', summary);
      });
    } else {
      stateIssue(issues, [...path, 'dismissed'], 'invalid-type', branch.dismissed);
    }
    Object.defineProperty(state.branches, name, {
      enumerable: true, configurable: true, writable: true,
      value: { round, lastReviewedSha, dismissed, lastTriage: normalizeLastTriage(branch.lastTriage, issues, [...path, 'lastTriage']) },
    });
  }
  return state;
}

/** 上流の状態ファイルの契約に従い、本文の正規化結果と診断情報を返す。 */
function parseCrossReviewState(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: 'invalid', state: null, issues: [] };
  }
  const issues = [];
  return { kind: 'ok', state: normalizeState(raw, issues), issues };
}

module.exports = { parseCrossReviewState };
