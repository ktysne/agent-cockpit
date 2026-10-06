'use strict';

module.exports = Object.freeze({
  schema: 'agent-cockpit-poc164-pr-review-notifications-v1',
  evidenceKind: 'synthetic-fixture-only',
  providers: Object.freeze(['claude', 'codex', 'external']),
  origins: Object.freeze(['independent', 'delegated']),
  purposes: Object.freeze(['work', 'review']),
  observationSources: Object.freeze(['shell', 'native', 'external']),
  registrationSources: Object.freeze([
    'claude_mcp', 'claude_gh', 'independent_codex_mcp', 'independent_codex_gh',
    'delegated_codex_mcp', 'delegated_codex_gh',
  ]),
  reviewConclusions: Object.freeze(['success', 'changes_requested', 'failed', 'not_required']),
  notificationTypes: Object.freeze(['merge', 'queue', 'conflict', 'restack']),
  notificationStates: Object.freeze(['queued', 'handed_off', 'acknowledged', 'unknown']),
  mergeMethods: Object.freeze(['merge', 'squash', 'rebase']),
  mergeOutcomes: Object.freeze(['MERGED', 'OPEN', 'CONFLICT', 'READ_FAILED']),
  prohibitedInferenceInputs: Object.freeze(['pid', 'cwd', 'timestamp']),
  mergeBoundary: 'Only an injected fixture object marked kind=fixture may receive a merge request.',
  restartRule: 'Restored notification state is inert; an identical event is never handed off again.',
});
