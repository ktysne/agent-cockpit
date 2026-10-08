'use strict';

const DEFAULT_PORT = 47821;
const APP_NAME = 'agent-cockpit';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_EXTERNAL_URL_LENGTH = 2048;
const MAX_NATIVE_PENDING_REQUESTS = 128;
const OWNED_STOP_FIELDS = Object.freeze(['launchRef', 'executionId', 'sessionId', 'expectedContextId',
  'expectedOwnerGeneration', 'stopRevision']);
const OWNED_PROCESS_STATES = new Set([
  'not_started', 'starting', 'running', 'stopping', 'stopped', 'stop_unconfirmed', 'disconnected', 'quarantined', 'failed',
]);
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_SCAN_INTERVAL_MS = 10_000;
const WRITER_CLAIM_FIELDS = Object.freeze([
  'provider', 'nativeIdKind', 'native_id_kind', 'hostId', 'host_id',
  'homeScopeId', 'home_scope_id', 'nativeId', 'native_id', 'identity',
  'sessionId', 'conversationId', 'conversation_id', 'executionId', 'execution_id',
  'periodId', 'period_id', 'contextId', 'context_id', 'evidence', 'evidenceId',
  'evidence_id', 'evidenceMetadata', 'evidence_metadata', 'observationId',
  'observation_id', 'registration', 'registrationId', 'registration_id',
  'verified', 'verification', 'writerToken', 'writer_token', 'claudeCodeSessionId',
  'claude_code_session_id', 'originBinding', 'executionBinding', 'actorId', 'launchId', 'runId',
]);
const MANUAL_CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
});

module.exports = { DEFAULT_PORT, APP_NAME, MAX_BODY_BYTES, MAX_EXTERNAL_URL_LENGTH, MAX_NATIVE_PENDING_REQUESTS, OWNED_STOP_FIELDS, OWNED_PROCESS_STATES, IDLE_TIMEOUT_MS, SESSION_SCAN_INTERVAL_MS, WRITER_CLAIM_FIELDS, MANUAL_CONTENT_TYPES };
