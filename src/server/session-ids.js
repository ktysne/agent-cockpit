'use strict';

// フックと API の ID は Claude Code の英数字・ハイフン形式、保存値は互換用のアンダースコアを許容し、短い ID は既存の 100 文字上限を保つ。
const HOOK_SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const STORED_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SHORT_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

function isHookSessionId(value) {
  return typeof value === 'string' && HOOK_SESSION_ID_PATTERN.test(value);
}

function isRequestSessionId(value) {
  return isHookSessionId(value);
}

function isStoredSessionId(value) {
  return typeof value === 'string' && STORED_SESSION_ID_PATTERN.test(value);
}

function isShortSessionId(value) {
  return typeof value === 'string' && SHORT_SESSION_ID_PATTERN.test(value);
}

module.exports = { isHookSessionId, isRequestSessionId, isShortSessionId, isStoredSessionId };
