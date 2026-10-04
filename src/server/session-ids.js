'use strict';

// フックと API は Claude Code 形式の ID を128文字まで受け付け、保存値は旧データに含まれるアンダースコアも許可する。
// 推定と非表示の API は URL と要求値を制限するため、ID を100文字まで受け付ける。
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
