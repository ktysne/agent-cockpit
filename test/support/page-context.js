const path = require('node:path');
const vm = require('node:vm');
const { composeUiTemplateSync } = require('../../src/server/ui-template');

function readWebPage() {
  return composeUiTemplateSync(path.join(__dirname, '../../src/web/index.html')).toString('utf8');
}

function functionSource(source, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`(?:async\\s+)?function\\s+${escapedName}\\s*\\([^]*?\\n\\}`))?.[0];
}

function sourceBetween(source, startMarker, endMarker, includeEnd = false) {
  const start = source.indexOf(startMarker);
  if (start < 0) return undefined;
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return undefined;
  return source.slice(start, includeEnd ? end + endMarker.length : end);
}

function withoutMediaBlocks(css) {
  let result = '';
  let index = 0;
  for (let start = css.indexOf('@media', index); start >= 0; start = css.indexOf('@media', index)) {
    result += css.slice(index, start);
    let depth = 0;
    let end = css.indexOf('{', start);
    if (end < 0) return result;
    for (; end < css.length; end += 1) {
      if (css[end] === '{') depth += 1;
      else if (css[end] === '}' && --depth === 0) break;
    }
    index = end + 1;
  }
  return result + css.slice(index);
}

// 既定では @media の中を外し、通常の画面幅で効く宣言だけを返す。@media の中を調べるときは、その塊を切り出して渡す。
function cssDeclarations(html, selector, options = {}) {
  const css = withoutMediaBlocks([...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .map(([, contents]) => contents.replace(/\/\*[\s\S]*?\*\//g, ''))
    .join('\n'));
  const declarations = [];
  const rules = /([^{}]+)\{([^{}]*)\}/g;

  for (const [, prelude, body] of css.matchAll(rules)) {
    const selectors = prelude.split(',').map((value) => value.trim());
    if (!selectors.some((value) => value === selector || (
      options.includeMoreSpecific && value.endsWith(` ${selector}`)
    ))) continue;
    for (const declaration of body.split(';')) {
      const separator = declaration.indexOf(':');
      if (separator < 0) continue;
      const property = declaration.slice(0, separator).trim();
      const value = declaration.slice(separator + 1).trim();
      if (property && value) declarations.push([property, value]);
    }
  }

  if (options.includeRepeated) return declarations;
  const lastValueByProperty = new Map();
  for (const [property, value] of declarations) lastValueByProperty.set(property, value);
  return [...lastValueByProperty];
}

const BROWSER_GLOBALS = new Set([
  'alert',
  'clearTimeout',
  'confirm',
  'CSS',
  'Date',
  'document',
  'fetch',
  'getComputedStyle',
  'HTMLTextAreaElement',
  'localStorage',
  'location',
  'navigator',
  'ResizeObserver',
  'setInterval',
  'setTimeout',
  'URL',
  'window',
]);

function declaredNames(html) {
  const names = new Set();
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];

  for (const [, script] of scripts) {
    for (const match of script.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) {
      names.add(match[1]);
    }
    for (const match of script.matchAll(/^class\s+([A-Za-z_$][\w$]*)\b/gm)) {
      names.add(match[1]);
    }
    for (const match of script.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/gm)) {
      names.add(match[1]);
    }
    for (const [, bindings] of script.matchAll(/^(?:const|let|var)\s+\{([^}]+)\}\s*=/gm)) {
      for (const binding of bindings.split(',')) {
        const name = binding.trim().split(/\s*:\s*/).pop().split(/\s*=\s*/)[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
      }
    }
  }

  return names;
}

function pageContext(html, sandbox = {}) {
  const names = declaredNames(html);
  const unknownNames = Object.keys(sandbox).filter((name) => !names.has(name) && !BROWSER_GLOBALS.has(name));

  if (unknownNames.length) {
    throw new Error(`画面で宣言されていない名前をサンドボックスに指定しています: ${unknownNames.join(', ')}`);
  }

  return vm.createContext(sandbox);
}

function displayPageContext(html, sandbox = {}) {
  const context = pageContext(html, {
    hiddenKindsUndo: null, restoredHiddenSessionsUndo: null,
    ...(html.includes('let showFinishedTemporarily') ? { showFinishedTemporarily: false } : {}),
    ...sandbox,
  });
  vm.runInContext(functionSource(html, 'hidesFinished'), context);
  return context;
}

module.exports = { displayPageContext, readWebPage, cssDeclarations, functionSource, pageContext, sourceBetween };
