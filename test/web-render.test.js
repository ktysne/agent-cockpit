const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function renderHarness() {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const render = html.match(/function render\(state\) \{[\s\S]*?\n\}/)?.[0];
  const renderDeferredState = html.match(/function renderDeferredState\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(render);
  assert.ok(renderDeferredState);

  class FakeTextArea {}
  const note = new FakeTextArea();
  note.dataset = { sessionId: 'session-ui', decisionId: 'decision-ui' };
  note.hasAttribute = (attribute) => attribute === 'data-answer-note';
  note.focused = false;
  note.focus = () => { note.focused = true; };
  note.selection = null;
  note.setSelectionRange = (start, end) => { note.selection = [start, end]; };

  const activeNote = {
    dataset: { answerNote: 'true', sessionId: 'session-ui', decisionId: 'decision-ui' },
    selectionStart: 2,
    selectionEnd: 5,
    hasAttribute: () => false,
  };
  let renderCount = 0;
  const context = vm.createContext({
    answerNoteComposing: false,
    deferredRenderPending: false,
    lastState: { sessions: [{ session_id: 'session-ui' }] },
    activeNote,
    HTMLTextAreaElement: FakeTextArea,
    document: {
      get activeElement() { return activeNote; },
      querySelectorAll: () => [],
    },
    root: {
      replaceChildren: () => { renderCount += 1; },
      querySelectorAll: () => [note],
    },
    displayPreferences: { mode: 'product', pinned: [] },
    renderSummary() {},
    renderExcludedNote() {},
    updateTitle() {},
    orderedProducts: () => [{ key: 'product-ui' }],
    productSection: () => ({}),
  });
  vm.runInContext(`${render}\n${renderDeferredState}`, context);
  return {
    context,
    get renderCount() { return renderCount; },
    note,
    html,
  };
}

test('作業中ツールは表示幅を超えた部分を CSS の省略記号で示す', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8');

  assert.match(source, /\.tool-content\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(source, /\.tool-content\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(source, /\.tool-content\s*\{[^}]*overflow:\s*hidden/);
  assert.match(source, /\.tool-content\s*\{[^}]*min-width:\s*0/);
  assert.match(mock, /\.meta\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(mock, /\.meta\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(mock, /\.meta\s*\{[^}]*overflow:\s*hidden/);
  assert.match(mock, /\.now-row\s*\{[^}]*minmax\(0,\s*1fr\)/);
  assert.match(mock, /\.now-row\s*>\s*:nth-child\(2\)\s*\{[^}]*min-width:\s*0/);
});

test('指示欄にフォーカスがあっても変換中でなければ描き直して選択範囲を戻す', () => {
  const harness = renderHarness();
  harness.context.render(harness.context.lastState);

  assert.equal(harness.renderCount, 1);
  assert.equal(harness.note.focused, true);
  assert.deepEqual(harness.note.selection, [2, 5]);
  assert.doesNotMatch(harness.html, /addEventListener\(\s*['"]focusout['"]/);
});

test('指示欄の変換中は描き直しを保留し、変換終了後に反映する', () => {
  const harness = renderHarness();
  harness.context.answerNoteComposing = true;
  harness.context.render(harness.context.lastState);
  harness.context.renderDeferredState();

  assert.equal(harness.renderCount, 0);
  assert.equal(harness.context.deferredRenderPending, true);

  harness.context.answerNoteComposing = false;
  harness.context.renderDeferredState();

  assert.equal(harness.renderCount, 1);
  assert.equal(harness.note.focused, true);
  assert.deepEqual(harness.note.selection, [2, 5]);
});
