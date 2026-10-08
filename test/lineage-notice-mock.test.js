const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8').replace(/\r\n/g, '\n');

function loadNotice() {
  const table = mock.match(/const LINEAGE_ISSUES = \{[\s\S]*?\n\};/)?.[0];
  const threshold = mock.match(/const LINEAGE_PERSIST_MS = [^;]+;/)?.[0];
  const fns = ['lineagePersisted', 'lineageNotice', 'lineageDiagnosticItems']
    .map((name) => mock.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0]);
  assert.ok(table && threshold && fns.every(Boolean));
  const context = vm.createContext({ esc: (value) => String(value).replace(/"/g, '&quot;') });
  vm.runInContext(`${table}\n${threshold}\n${fns.join('\n')}\nthis.lineageNotice = lineageNotice; this.lineageDiagnosticItems = lineageDiagnosticItems; this.LINEAGE_ISSUES = LINEAGE_ISSUES;`, context);
  return context;
}

const now = Date.now();
const issue = (reason, spanMs, extra = {}) => ({
  reason, since: new Date(now - spanMs - 10_000).toISOString(), lastAt: new Date(now - 10_000).toISOString(), ...extra,
});

test('1 分続いた失敗のセッションに札を出し、理由ごとの直し方を title に入れる', () => {
  const { lineageNotice } = loadNotice();
  const html = lineageNotice({ claudeLineageIssue: issue('claude_session_mismatch', 3 * 60_000) });
  assert.match(html, /class="lineage-tag"/);
  assert.match(html, />フックを照合できません</);
  assert.match(html, /Claude を起動し直して/);
});

test('どの理由でも、失敗が 1 分続かなければ札を出さない', () => {
  const { lineageNotice, LINEAGE_ISSUES } = loadNotice();
  for (const reason of Object.keys(LINEAGE_ISSUES)) {
    assert.equal(lineageNotice({ claudeLineageIssue: issue(reason, 0) }), '', reason);
    assert.equal(lineageNotice({ claudeLineageIssue: issue(reason, 59_000) }), '', reason);
    assert.match(lineageNotice({ claudeLineageIssue: issue(reason, 60_000) }), /lineage-tag/, reason);
  }
});

test('失敗が無いセッションと未知の理由では札を出さない', () => {
  const { lineageNotice } = loadNotice();
  assert.equal(lineageNotice({}), '');
  assert.equal(lineageNotice({ claudeLineageIssue: issue('unknown', 5 * 60_000) }), '');
});

test('/clear の直後の一時的な失敗として session_mismatch を案内しない', () => {
  const { LINEAGE_ISSUES } = loadNotice();
  assert.doesNotMatch(LINEAGE_ISSUES.claude_session_mismatch.hint, /\/clear/);
});

test('カードに付けられない失敗は、1 分続いたものだけを診断に親の pid と経路付きで出す', () => {
  const { lineageDiagnosticItems } = loadNotice();
  const items = lineageDiagnosticItems([
    issue('claude_parent_unverified', 5 * 60_000, { source: 'hook', ppid: 31872 }),
    issue('claude_parent_unverified', 0, { source: 'mcp', ppid: 271644 }),
    issue('claude_sessions_unreadable', 2 * 60_000, { source: 'mcp', ppid: 4100 }),
  ]);
  assert.equal(items.length, 2);
  assert.match(items[0], /親の pid 31872 から来たフックを照合できません/);
  assert.match(items[0], /exec 形式\(command と args\)/);
  assert.match(items[1], /親の pid 4100 から来たMCP サーバーを照合できません/);
  assert.equal(lineageDiagnosticItems(undefined).length, 0);
});

test('4 つの理由すべてに説明があり、札はメインの行に、診断は設定の先頭に置き、サンプルがそれぞれ 1 件ある', () => {
  const { LINEAGE_ISSUES } = loadNotice();
  assert.deepEqual(Object.keys(LINEAGE_ISSUES).sort(), ['claude_parent_unverified', 'claude_registration_failed', 'claude_session_mismatch', 'claude_sessions_unreadable']);
  for (const info of Object.values(LINEAGE_ISSUES)) assert.ok(info.hint.length > 10);
  assert.match(mock, /\$\{conversation\}\$\{lineageNotice\(session\)\}/);
  assert.match(mock, /<h2 id="settings-title">設定<\/h2>\n  <section id="settings-diagnostics"[^>]*hidden>/);
  assert.match(mock, /renderRouting\(\);\n  renderLineageDiagnostics\(\);/);
  assert.equal((mock.match(/claudeLineageIssue = \{/g) || []).length, 1);
  assert.equal((mock.match(/claudeLineageIssues: \[/g) || []).length, 1);
});
