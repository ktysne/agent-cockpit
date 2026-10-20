const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify, isDeepStrictEqual } = require('node:util');
const { observe } = require('./doctor-observe');
const { evaluate, normalizedPath, execution, subtreeDigest, tomlTableName } = require('./doctor-evaluate');

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const RESTART = 'node src/client/restart-server.js --json';
const CHANGED = '診断の後にファイルか checkout が変わりました。診断し直してください。';
const CONCURRENCY_NOTICE = 'セッションが応答を書いている最中の適用は避けてください。';

async function readFile(io, file) {
  try { return await io.readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function matches(content, actions) {
  try {
    return actions.every(action => action.observedDigest === (action.digestPath
      ? subtreeDigest(content === null ? null : JSON.parse(content.toString('utf8')), action.digestPath)
      : content === null ? null : digest(content.toString('utf8'))));
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

function parentAt(value, keys, create) {
  for (const key of keys) {
    if (!object(value)) throw new Error('途中の値がオブジェクトではありません。');
    if (!Object.hasOwn(value, key) && create) Object.defineProperty(value, key, { value: {}, enumerable: true, writable: true, configurable: true });
    value = Object.hasOwn(value, key) ? value[key] : undefined;
  }
  if (!object(value)) throw new Error('途中の値がオブジェクトではありません。');
  return value;
}

function jsonEdit(value, action) {
  const parent = parentAt(value, action.path.slice(0, -1), action.op === 'json-add');
  const key = action.path.at(-1);
  if (!action.target) {
    if (action.op !== 'json-add' && !Object.hasOwn(parent, key)) throw new Error('対象のキーがありません。');
    if (action.op === 'json-remove') delete parent[key];
    else Object.defineProperty(parent, key, { value: action.value, enumerable: true, writable: true, configurable: true });
    return;
  }
  if (action.op === 'json-add' && action.target === 'group') {
    if (!Object.hasOwn(parent, key)) parent[key] = [];
    if (!Array.isArray(parent[key])) throw new Error('対象の値が配列ではありません。');
    parent[key].push(action.value);
    return;
  }
  const groups = parent[key];
  if (!Array.isArray(groups)) throw new Error('対象の値が配列ではありません。');
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if ((group.matcher ?? null) !== action.match.matcher || !Array.isArray(group.hooks)) continue;
    const hook = group.hooks.findIndex(entry => execution(entry).script === action.match.script);
    if (hook < 0) continue;
    if (action.op === 'json-replace') group.hooks[hook] = action.value;
    else if (action.op === 'json-remove') {
      group.hooks.splice(hook, 1);
      if (!group.hooks.length) groups.splice(index, 1);
    } else throw new Error('対応していないフックの対処です。');
    return;
  }
  throw new Error('対象のフックがありません。');
}

function tomlEdit(text, action) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => tomlTableName(line) === action.table);
  const assignment = `${action.key} = ${Array.isArray(action.value) ? `[${action.value.map(value => JSON.stringify(value)).join(', ')}]` : JSON.stringify(action.value)}`;
  if (start < 0) return `${text}${text && !text.endsWith('\n') ? newline : ''}${newline}[${action.table}]${newline}${assignment}${newline}`;
  let end = start + 1;
  while (end < lines.length && !lines[end].trimStart().startsWith('[')) end += 1;
  for (let index = start + 1; index < end; index += 1) {
    const key = lines[index].match(/^\s*(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([\w-]+))\s*=/);
    if (key && (key[1] ?? key[2] ?? key[3]) === action.key) {
      lines[index] = assignment;
      return lines.join(newline);
    }
  }
  while (end > start + 1 && !lines[end - 1].trim()) end -= 1;
  lines.splice(end, 0, assignment);
  return lines.join(newline);
}

async function editedContent(io, root, content, actions) {
  const text = content?.toString('utf8') || '';
  if (actions.every(action => action.op.startsWith('json-'))) {
    const value = content === null ? {} : JSON.parse(text);
    const order = { 'json-remove': 0, 'json-replace': 1, 'json-add': 2 };
    for (const action of [...actions].sort((a, b) => order[a.op] - order[b.op])) jsonEdit(value, action);
    const indent = text.match(/\r?\n([\t ]+)\S/)?.[1] || 2;
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    return JSON.stringify(value, null, indent).replace(/\n/g, newline) + (text.endsWith('\n') ? newline : '');
  }
  let result = content;
  for (const action of actions) {
    if (action.op === 'toml-set') result = tomlEdit(result?.toString('utf8') || '', action);
    else if (action.op === 'copy') result = await io.readFile(path.join(root, action.from));
    else throw new Error('対応していないファイルの対処です。');
  }
  return result;
}

function backups(io, home, now) {
  const base = path.join(home, 'backups');
  let directory = null;
  const manifest = [];
  return {
    get directory() { return directory; },
    async save(file, content) {
      if (content === null) return;
      if (!directory) {
        await io.mkdir(base, { recursive: true, mode: 0o700 });
        let timeMs = now().getTime();
        while (!directory) {
          const candidate = path.join(base, new Date(timeMs).toISOString().replace(/[:.]/g, '-'));
          try {
            await io.mkdir(candidate, { mode: 0o700 });
            directory = candidate;
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            timeMs += 1;
          }
        }
      }
      const backup = path.join(directory, `${manifest.length + 1}-${path.basename(file)}`);
      await io.writeFile(backup, content, { flag: 'wx', mode: 0o600 });
      manifest.push({ original: file, backup, sha256: digest(content) });
      await io.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      const entries = (await io.readdir(base, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(entry.name))
        .map(entry => entry.name).sort();
      for (const entry of entries.slice(0, -10)) await io.rm(path.join(base, entry), { recursive: true, force: true });
    },
  };
}

async function applySelected(from, ids, options) {
  const observation = await observe({ ...options, root: from.checkout.resolvedBy === 'root' ? from.checkout.root : undefined });
  const current = evaluate(observation);
  const io = options.fs || fs;
  const backup = backups(io, observation.homes.cockpit, options.now || (() => new Date()));
  const report = { schemaVersion: 1, backupDir: null, results: [], commands: [], manual: [] };
  const candidates = [];
  const files = new Map();
  for (const id of ids) {
    const previous = from.items.find(item => item.id === id);
    const item = current.items.find(item => item.id === id);
    const result = { id, status: 'applied', reason: '対処を適用しました。' };
    report.results.push(result);
    if (normalizedPath(current.checkout.root) !== normalizedPath(from.checkout.root)) Object.assign(result, { status: 'skipped', reason: 'checkout が変わりました。診断し直してください。' });
    else if (previous.result !== 'mismatch') Object.assign(result, { status: 'skipped', reason: '診断の時点で不一致ではありませんでした。' });
    else if (!item) Object.assign(result, { status: 'skipped', reason: '項目が無くなりました。' });
    else if (item.result === 'ok') Object.assign(result, { status: 'already-ok', reason: '既に一致しています。' });
    else if (item.result !== 'mismatch') Object.assign(result, { status: 'skipped', reason: '適用できる状態ではありません。' });
    else if (!isDeepStrictEqual(previous.actions, item.actions)) Object.assign(result, { status: 'skipped', reason: CHANGED });
    else {
      const actions = item.actions.filter(action => !['manual', 'command'].includes(action.op));
      const targets = [...new Set(actions.map(action => action.op === 'copy' ? action.to : action.file))];
      if (targets.length > 1) Object.assign(result, { status: 'failed', reason: '1 つの項目が複数のファイルを対象にしています。' });
      else {
        candidates.push({ item, result });
        if (targets.length) {
          if (!files.has(targets[0])) files.set(targets[0], { actions: [], results: [] });
          files.get(targets[0]).actions.push(...actions);
          files.get(targets[0]).results.push(result);
        }
      }
    }
  }
  for (const [file, { actions, results }] of files) {
    let temporary;
    try {
      const content = await readFile(io, file);
      if (!matches(content, actions)) {
        results.forEach(result => Object.assign(result, { status: 'skipped', reason: CHANGED }));
        continue;
      }
      await backup.save(file, content);
      const edited = await editedContent(io, current.checkout.root, content, actions);
      await io.mkdir(path.dirname(file), { recursive: true });
      temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
      const mode = content === null ? 0o600 : (await io.stat(file)).mode & 0o777;
      await io.writeFile(temporary, edited, { flag: 'wx', mode });
      if (!matches(await readFile(io, file), actions)) {
        results.forEach(result => Object.assign(result, { status: 'skipped', reason: CHANGED }));
        continue;
      }
      await io.rename(temporary, file);
    } catch {
      results.forEach(result => Object.assign(result, { status: 'failed', reason: '退避またはファイルの対処に失敗しました。設定の形とアクセス権を確認してください。' }));
    } finally {
      if (temporary) await io.rm(temporary, { force: true }).catch(() => {});
    }
  }
  for (const { item, result } of candidates) {
    if (result.status !== 'applied') continue;
    for (const action of item.actions.filter(action => action.op === 'command')) {
      if (action.command !== RESTART || normalizedPath(action.cwd) !== normalizedPath(current.checkout.root)) {
        Object.assign(result, { status: 'failed', reason: '許可されていないコマンドです。' });
        break;
      }
      let exitCode = 0;
      try {
        await (options.execFile || promisify(execFile))(process.execPath,
          [path.join(current.checkout.root, 'src/client/restart-server.js'), '--json'], { cwd: current.checkout.root });
      } catch (error) { exitCode = Number.isInteger(error.code) && error.code !== 0 ? error.code : 1; }
      report.commands.push({ command: action.command, exitCode });
      if (exitCode) Object.assign(result, { status: 'failed', reason: '常駐サーバーの再起動に失敗しました。' });
    }
    if (result.status === 'applied') report.manual.push(...item.actions.filter(action => action.op === 'manual').map(action => action.text));
  }
  report.backupDir = backup.directory;
  report.manual = [...new Set([...report.manual, CONCURRENCY_NOTICE])];
  return report;
}

async function main(argv = process.argv.slice(2), options = {}) {
  const log = options.log || console.log;
  const logError = options.logError || console.error;
  try {
    let source;
    const ids = [];
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === '--json') continue;
      if (!['--from', '--item'].includes(arg) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('引数が不正です。');
      if (arg === '--from') {
        if (source) throw new Error('入力が重複しています。');
        source = argv[++index];
      } else ids.push(argv[++index]);
    }
    if (!source || !ids.length) throw new Error('入力がありません。');
    const from = JSON.parse(await (options.fs || fs).readFile(source, 'utf8'));
    if (from.schemaVersion !== 1 || !Array.isArray(from.items) || ids.some(id => !from.items.some(item => item.id === id))) throw new Error('診断または項目が不正です。');
    const report = await applySelected(from, [...new Set(ids)], options);
    const labels = { applied: '適用した', 'already-ok': '既に一致', skipped: '適用しなかった', failed: '失敗' };
    log(argv.includes('--json') ? JSON.stringify(report) : [
      ...report.results.map(result => `${labels[result.status]}: ${result.id}: ${result.reason}`),
      ...(report.backupDir ? [`退避先: ${report.backupDir}`] : []), ...report.manual,
    ].join('\n'));
    return report.results.some(result => ['skipped', 'failed'].includes(result.status)) ? 1 : 0;
  } catch {
    const reason = '適用を開始できませんでした。使い方: node src/client/apply.js --from <診断の JSON> --item <id> [--item <id> ...] [--json]。入力と checkout を確認してください。';
    if (argv.includes('--json')) log(JSON.stringify({ schemaVersion: 1, error: reason }));
    else logError(reason);
    return 2;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });

module.exports = { main };
