const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8');

function loadNotice() {
  const table = mock.match(/const LINEAGE_ISSUES = \{[\s\S]*?\n\};/)?.[0];
  const threshold = mock.match(/const LINEAGE_TRANSIENT_MS = [^;]+;/)?.[0];
  const fn = mock.match(/function lineageNotice\([^]*?\n\}/)?.[0];
  assert.ok(table && threshold && fn);
  const context = vm.createContext({ esc: (value) => String(value).replace(/"/g, '&quot;') });
  vm.runInContext(`${table}\n${threshold}\n${fn}\nthis.lineageNotice = lineageNotice; this.LINEAGE_ISSUES = LINEAGE_ISSUES;`, context);
  return context;
}

test('照合に失敗したセッションに札を出し、理由ごとの直し方を title に入れる', () => {
  const { lineageNotice } = loadNotice();
  const now = Date.now();
  const html = lineageNotice({ claudeLineageIssue: { reason: 'claude_parent_unverified', at: new Date(now - 5 * 60_000).toISOString() } }, now);
  assert.match(html, /class="lineage-tag"/);
  assert.match(html, />フックを照合できません</);
  assert.match(html, /exec 形式\(command と args\)/);
  assert.match(html, /node を絶対パスで指定/);
});

test('失敗が無いセッションと未知の理由では札を出さない', () => {
  const { lineageNotice } = loadNotice();
  assert.equal(lineageNotice({}), '');
  assert.equal(lineageNotice({ claudeLineageIssue: { reason: 'unknown', at: new Date().toISOString() } }), '');
});

test('claude_session_mismatch は 1 分続いたときだけ札を出す', () => {
  const { lineageNotice } = loadNotice();
  const now = Date.now();
  const at = (ms) => new Date(now - ms).toISOString();
  assert.equal(lineageNotice({ claudeLineageIssue: { reason: 'claude_session_mismatch', at: at(59_000) } }, now), '');
  assert.match(lineageNotice({ claudeLineageIssue: { reason: 'claude_session_mismatch', at: at(60_000) } }, now), /lineage-tag/);
});

test('4 つの理由すべてに説明があり、メインの行に札を差し込み、サンプルが 1 件ある', () => {
  const { LINEAGE_ISSUES } = loadNotice();
  assert.deepEqual(Object.keys(LINEAGE_ISSUES).sort(), ['claude_parent_unverified', 'claude_registration_failed', 'claude_session_mismatch', 'claude_sessions_unreadable']);
  for (const info of Object.values(LINEAGE_ISSUES)) assert.ok(info.hint.length > 10);
  assert.match(mock, /\$\{conversation\}\$\{lineageNotice\(session\)\}/);
  assert.equal((mock.match(/claudeLineageIssue = \{/g) || []).length, 1);
});
