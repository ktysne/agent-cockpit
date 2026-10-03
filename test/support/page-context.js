const vm = require('node:vm');

const BROWSER_GLOBALS = new Set([
  'alert',
  'clearTimeout',
  'confirm',
  'document',
  'fetch',
  'getComputedStyle',
  'HTMLTextAreaElement',
  'localStorage',
  'location',
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

module.exports = { pageContext };
