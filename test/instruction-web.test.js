const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { functionSource, pageContext } = require('./support/page-context');

const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8');

function composerContext(session, draft = {}) {
  const ui = {
    hideFinished: true,
    instructionDrafts: draft,
    instructionNotices: {},
    instructionRecords: [],
  };
  const context = pageContext(mock, {
    ui,
    commonQuestionsOf: item => item.commonQuestions || [],
    isFinishedCommonQuestion: question => question.cancelled || question.deliveryState === 'applied',
    isActiveDecision: decision => decision.kind === 'waiting' || decision.kind === 'provisional',
    instructionCard: () => '',
    esc: value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]),
  });
  for (const name of ['isFinishedInstructionRecord', 'instructionRecordsForSession', 'instructionTargetAvailability', 'instructionModeText', 'instructionComposer']) {
    const source = functionSource(mock, name);
    assert.ok(source, `${name} source`);
    vm.runInContext(source, context);
  }
  return { context, ui, product: { id: 'product-a' }, session };
}

test('mock instruction composer is nested in each session work region in both display modes', () => {
  const sessionBlock = functionSource(mock, 'sessionBlock');
  const renderProductMode = functionSource(mock, 'renderProductMode');
  const renderKindMode = functionSource(mock, 'renderKindMode');
  assert.match(sessionBlock, /now:[\s\S]*instructionComposer\(p, session\)/);
  assert.doesNotMatch(renderProductMode, /instructionComposer\(p\)/);
  assert.match(renderKindMode, /mainRow\(p, session, true\)[\s\S]*instructionComposer\(p, session\)/);
});

test('mock composer requires explicit target and mode selections and holds while session work is pending', () => {
  const session = { id: 'session-a', title: 'Session A', status: 'busy', perms: [], decisions: [], commonQuestions: [] };
  const { context, ui, product } = composerContext(session);
  const initial = context.instructionComposer(product, session);
  assert.match(initial, /role="region" aria-label="指示の保存と送信"/);
  assert.match(initial, /<h4>指示を保存して届ける<\/h4>/);
  assert.match(initial, /<option value="" selected>実行を選択してください<\/option>/);
  assert.match(initial, /<option value="" selected>指示の種類を選択してください<\/option>/);
  assert.match(initial, /<select data-instruction-mode="session-a" disabled>/);
  assert.match(initial, /data-instruction-save="session-a" disabled/);

  ui.instructionDrafts['session-a'] = { targetSessionId: 'session-a', mode: '', text: '次へ進む' };
  const targetSelected = context.instructionComposer(product, session);
  assert.match(targetSelected, /<option value="steer" >実行中へ伝える<\/option>/);
  assert.match(targetSelected, /data-instruction-save="session-a" disabled/);

  ui.instructionDrafts['session-a'].mode = 'steer';
  const explicitChoice = context.instructionComposer(product, session);
  assert.match(explicitChoice, /data-instruction-save="session-a"(?:[^>]*)>指示を保存する<\/button>/);
  assert.doesNotMatch(explicitChoice, /data-instruction-save="session-a" disabled/);

  session.perms = [{ id: 'permission-a' }];
  const permissionHold = context.instructionComposer(product, session);
  assert.match(permissionHold, /質問・許可・判断待ちがあるため、指示を保留中です。/);
  assert.doesNotMatch(permissionHold, /value="steer"/);
  assert.match(permissionHold, /data-instruction-save="session-a" disabled/);
});

test('stopped mock session with an open question cannot select a start instruction', () => {
  const session = {
    id: 'session-waiting', title: 'Session waiting', status: 'wait', perms: [], decisions: [],
    commonQuestions: [{ internalQuestionId: 'question-a', cancelled: false, deliveryState: null }],
  };
  const { context, product } = composerContext(session);
  const html = context.instructionComposer(product, session);
  assert.match(html, /質問・許可・判断待ちがあるため、指示を保留中です。/);
  assert.doesNotMatch(html, /value="start"/);
  assert.match(html, /data-instruction-mode="session-waiting" disabled/);
});
