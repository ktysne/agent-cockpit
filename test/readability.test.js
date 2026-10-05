const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { cssDeclarations, functionSource } = require('./support/page-context');

const web = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8');

function themeVariables(html, theme) {
  const selector = theme === 'light' ? ':root' : ':root[data-theme="dark"]';
  const variables = Object.fromEntries(cssDeclarations(html, selector));
  assert.ok(Object.keys(variables).length, `${theme} テーマの変数ブロックがある`);
  return (name) => {
    const value = variables[name];
    assert.match(value || '', /^#[\da-f]{6}$/i, `${theme} の ${name} が色として定義されている`);
    return value;
  };
}

function relativeLuminance(hex) {
  const [red, green, blue] = hex.slice(1).match(/../g)
    .map((channel) => parseInt(channel, 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground, background) {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((first, second) => second - first);
  return (lighter + 0.05) / (darker + 0.05);
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.className = '';
    this.textContent = '';
  }

  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
}

function textOf(node) {
  return node.children?.length ? node.children.map(textOf).join('') : node.textContent;
}

test('ライトとダークの状態色およびボタン文字のコントラストが4.5対1以上', () => {
  const cases = [
    {
      html: web,
      statuses: [
        ['--ok-text', '--ok-soft', ['.badge.done', '.badge.ok', '.chip.ok', '.answer-choice.ok:has(input:checked)']],
        ['--warn-text', '--warn-soft', ['.badge.wait', '.badge.warn', '.chip.warn']],
        ['--accent-text', '--accent-soft', ['.badge.busy', '.badge.accent', '.chip.accent', '.news-head']],
      ],
    },
    {
      html: mock,
      statuses: [
        ['--ok-text', '--ok-soft', ['.badge.done', '.badge.ok', '.state.done', '.chip.ok', '.check.ok:has(input:checked)']],
        ['--warn-text', '--warn-soft', ['.badge.wait', '.badge.warn', '.chip.warn']],
        ['--accent-text', '--accent-soft', ['.badge.busy', '.badge.accent', '.state.doing', '.chip.accent', '.news .nhead']],
      ],
    },
  ];

  for (const { html, statuses } of cases) {
    for (const theme of ['light', 'dark']) {
      const color = themeVariables(html, theme);
      for (const [foregroundToken, backgroundToken, selectors] of statuses) {
        for (const selector of selectors) {
          const declarations = cssDeclarations(html, selector);
          const colors = declarations.filter(([property]) => property === 'color');
          assert.ok(colors.length, `${selector} のルールがある`);
          assert.ok(colors.every(([, value]) => value === `var(${foregroundToken})`), `${selector} の文字色`);
        }
        const ratio = contrastRatio(color(foregroundToken), color(backgroundToken));
        assert.ok(ratio >= 4.5, `${theme} ${foregroundToken} / ${backgroundToken}: ${ratio.toFixed(2)}対1`);
      }

      for (const [foregroundToken, backgroundToken] of [
        ['--on-accent', '--accent'],
        ['--on-ok', '--ok'],
        ['--on-danger', '--danger'],
        ['--text-2', '--bg'],
      ]) {
        const ratio = contrastRatio(color(foregroundToken), color(backgroundToken));
        assert.ok(ratio >= 4.5, `${theme} ${foregroundToken} / ${backgroundToken}: ${ratio.toFixed(2)}対1`);
      }
    }

    const hiddenChip = Object.fromEntries(cssDeclarations(html, 'button.chip[aria-pressed="false"]'));
    assert.ok(Object.keys(hiddenChip).length);
    assert.equal(hiddenChip.background, 'transparent');
    assert.equal(hiddenChip['text-decoration'], 'line-through');
    assert.equal(hiddenChip.opacity, undefined);
  }
});

test('絶対時刻は今日と別の日で共通の書式を使う', () => {
  for (const html of [web, mock]) {
    const absoluteTimeLabel = functionSource(html, 'absoluteTimeLabel');
    assert.ok(absoluteTimeLabel);
    const context = vm.createContext({ Date });
    vm.runInContext(`${absoluteTimeLabel}\nthis.absoluteTimeLabel = absoluteTimeLabel;`, context);

    const now = new Date(2026, 9, 4, 16, 0).getTime();
    assert.equal(context.absoluteTimeLabel(new Date(2026, 9, 4, 9, 7), now), '09:07');
    assert.equal(context.absoluteTimeLabel(new Date(2026, 9, 3, 20, 5), now), '10/3 20:05');
    if (html === mock) assert.equal(context.absoluteTimeLabel('09:07', now), '09:07');
  }
});

test('相対時刻のtime要素はISO日時と絶対時刻を持つ', () => {
  const element = functionSource(web, 'element');
  const absoluteTimeLabel = functionSource(web, 'absoluteTimeLabel');
  const relativeTimeElement = functionSource(web, 'relativeTimeElement');
  assert.ok(element && absoluteTimeLabel && relativeTimeElement);
  const document = {
    createElement: (tagName) => new FakeElement(tagName),
  };
  const context = vm.createContext({ Date, document });
  vm.runInContext(`${element}\n${absoluteTimeLabel}\n${relativeTimeElement}\nthis.relativeTimeElement = relativeTimeElement; this.absoluteTimeLabel = absoluteTimeLabel;`, context);

  const now = new Date(2026, 9, 4, 16, 0).getTime();
  const timestamp = new Date(2026, 9, 4, 9, 7).toISOString();
  const time = context.relativeTimeElement(timestamp, 'since', '7 時間前', now);
  assert.equal(time.tagName, 'time');
  assert.equal(time.dateTime, timestamp);
  assert.equal(time.title, '09:07');
  assert.equal(context.relativeTimeElement('', 'since', '').dateTime, undefined);

  assert.match(web, /relativeTimeElement\(elapsedAt, 'since', durationAgoLabel\(elapsedAt\)\)/);
  assert.match(web, /relativeTimeElement\(agent\.startedAt, 'since'/);
  assert.match(web, /relativeTimeElement\([\s\S]*?elapsed\.label/);
});

test('待ち時間と許可待ちは期間表示の形式を使う', () => {
  const durationLabel = functionSource(web, 'durationLabel');
  const element = functionSource(web, 'element');
  const badge = functionSource(web, 'badge');
  const appendPermissionWaits = functionSource(web, 'appendPermissionWaits');
  assert.ok(durationLabel && element && badge && appendPermissionWaits);

  const document = {
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (text) => Object.assign(new FakeElement('#text'), { textContent: text }),
  };
  const context = vm.createContext({
    Date,
    document,
    shownPermissions: (session) => session.permissionWaits,
    newestFirst: (items) => items,
    isLongWait: () => false,
    appendContextTags() {},
    sessionDisplayName: (session) => session.title || session.session_id,
  });
  vm.runInContext(`${element}\n${badge}\n${durationLabel}\n${appendPermissionWaits}\nthis.appendPermissionWaits = appendPermissionWaits;`, context);

  const startedAt = new Date(Date.now() - (14 * 60 + 3) * 60_000 - 1_000).toISOString();
  const body = new FakeElement('div');
  context.appendPermissionWaits(body, {
    permissionWaits: [{ startedAt, agent_id: 'agent-1', tool_name: 'Bash', summary: 'npm test' }],
    agents: [{ agent_id: 'agent-1', agent_type: 'サブエージェント' }],
  }, { name: 'Product' });
  assert.match(textOf(body), /14 時間 3 分待機中/);
  assert.match(web, /durationLabel\(wait\.startedAt\)/);
  assert.match(mock, /durationLabel\(Date\.now\(\) - m \* 60_000\)/);

  const mockDuration = functionSource(mock, 'durationLabel');
  assert.ok(mockDuration);
  const mockContext = vm.createContext({ Date });
  vm.runInContext(`${mockDuration}\nthis.durationLabel = durationLabel;`, mockContext);
  const mockStartedAt = Date.now() - (14 * 60 + 3) * 60_000 - 1_000;
  assert.equal(mockContext.durationLabel(mockStartedAt), '14 時間 3 分');
});

test('SHAは確認欄とマージ警告で7桁を表示し、完全な値をtitleに残す', () => {
  const element = functionSource(web, 'element');
  const shortShaElement = functionSource(web, 'shortShaElement');
  assert.ok(element && shortShaElement);
  const document = { createElement: (tagName) => new FakeElement(tagName) };
  const context = vm.createContext({ document });
  vm.runInContext(`${element}\n${shortShaElement}\nthis.shortShaElement = shortShaElement;`, context);

  const sha = 'a'.repeat(40);
  const code = context.shortShaElement(sha);
  assert.equal(code.tagName, 'code');
  assert.equal(code.textContent, 'a'.repeat(7));
  assert.equal(code.title, sha);

  const mockSha = functionSource(mock, 'shortShaLabel');
  assert.ok(mockSha);
  const mockContext = vm.createContext({ esc: (value) => String(value).replace(/[&<>\"]/g, '') });
  vm.runInContext(`${mockSha}\nthis.shortShaLabel = shortShaLabel;`, mockContext);
  const markup = mockContext.shortShaLabel(sha);
  assert.match(markup, new RegExp(`<code title="${sha}">${sha.slice(0, 7)}<\\/code>`));

  for (const name of ['appendPullRequestMergeConfirmation', 'appendPullRequestConflictConfirmation']) {
    assert.match(functionSource(web, name), /shortShaElement\(pullRequest\.headRefOid\)/);
  }
  assert.match(functionSource(web, 'appendPullRequestBlock'), /shortShaElement\(record\.reservedHeadRefOid\)/);
  assert.match(functionSource(web, 'appendPullRequestBlock'), /shortShaElement\(record\.mergedHeadRefOid\)/);
  assert.match(mock, /shortShaLabel\(pr\.sha\)/);
  assert.match(mock, /shortShaLabel\(pr\.reservedHeadRefOid\)/);
  assert.match(mock, /shortShaLabel\(pr\.mergedHeadRefOid\)/);
});

test('操作名は一覧からの除外、再表示、クローズ済みPRへの移動先を表す', () => {
  const productCloseButton = functionSource(web, 'productCloseButton');
  const element = functionSource(web, 'element');
  assert.ok(productCloseButton && element);
  const document = { createElement: (tagName) => new FakeElement(tagName) };
  const context = vm.createContext({ document });
  vm.runInContext(`${element}\n${productCloseButton}\nthis.productCloseButton = productCloseButton;`, context);
  const button = context.productCloseButton({ sessions: [{}], key: 'product' }, 'product-heading');
  assert.equal(button.attributes['aria-label'], 'このプロダクトのセッションを一覧から外す');
  assert.equal(button.title, 'このプロダクトのセッションを一覧から外す');

  for (const html of [web, mock]) {
    assert.ok(html.includes('隠した種類をすべて表示する'));
    assert.ok(html.includes('外したセッションを戻す'));
    assert.ok(html.includes('GitHub で PR #${pullRequest.number} を開く') || html.includes('GitHub で PR #${pr.number} を開く'));
  }
});
