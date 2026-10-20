const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify, isDeepStrictEqual } = require('node:util');
const { observe } = require('./doctor-observe');
const { evaluate, normalizedPath, execution, subtreeDigest, tomlTableName } = require('./doctor-evaluate');
const { compareVersions } = require('../server/update-check');

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
  const { groups, group, hook } = action.resolved;
  const hookIndex = group.hooks.indexOf(hook);
  if (hookIndex < 0) throw new Error('対象のフックがありません。');
  if (action.op === 'json-replace') group.hooks[hookIndex] = action.value;
  else if (action.op === 'json-remove') {
    group.hooks.splice(hookIndex, 1);
    if (!group.hooks.length) groups.splice(groups.indexOf(group), 1);
  } else throw new Error('対応していないフックの対処です。');
}

// 位置は編集前の配列で解決し、要素の参照で書き換える。先に取り除いた要素で後の位置がずれないようにするため。
function resolveHook(value, action) {
  const groups = parentAt(value, action.path.slice(0, -1), false)[action.path.at(-1)];
  const group = Array.isArray(groups) ? groups[action.match.groupIndex] : undefined;
  const hook = Array.isArray(group?.hooks) ? group.hooks[action.match.hookIndex] : undefined;
  if (!object(hook) || (group.matcher ?? null) !== action.match.matcher || execution(hook).script !== action.match.script) {
    throw new Error('対象のフックがありません。');
  }
  return { groups, group, hook };
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
    const resolved = actions.map(action => action.target === 'hook' ? { ...action, resolved: resolveHook(value, action) } : action);
    if (new Set(resolved.filter(action => action.resolved).map(action => action.resolved.hook)).size !== resolved.filter(action => action.resolved).length) {
      throw new Error('同じフックに複数の対処があります。');
    }
    for (const action of resolved.sort((a, b) => order[a.op] - order[b.op])) jsonEdit(value, action);
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
      const latest = await readFile(io, file);
      if (latest === null ? content !== null : content === null || !latest.equals(content)) {
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

async function updateCheckout(checkout, check, options, manual) {
  const result = { tool: checkout.tool, root: checkout.root, status: 'failed', reason: '', track: null, from: null, to: null, commits: [] };
  const git = async (...args) => (await (options.execFile || promisify(execFile))('git', ['-C', checkout.root, ...args],
    { windowsHide: true, encoding: 'utf8' })).stdout.trim();
  const finish = (status, reason) => Object.assign(result, { status, reason });
  if (!checkout.root) return finish('not-found', 'checkout の場所が分かりません。');
  if (checkout.tool === 'agent-cockpit' && /(?:^|\/)\.claude\/worktrees\//i.test(checkout.root.replace(/\\/g, '/'))) {
    return finish('blocked', 'worktree なので本体の checkout で行ってください。');
  }
  try {
    if (await git('status', '--porcelain')) return finish('blocked', '未コミットの変更があります。');
    if (await git('branch', '--show-current') !== 'main') return finish('blocked', 'ブランチが main ではありません。');
    await git('fetch', 'origin');
    result.from = await git('rev-parse', 'HEAD');
    if (await git('rev-list', '--count', 'origin/main..HEAD') !== '0') return finish('blocked', 'origin/main に無いローカルのコミットがあります。');
    result.track = 'main';
    result.to = await git('rev-parse', 'origin/main');
    let beforeVersion;
    if (checkout.tool === 'agent-cockpit') {
      beforeVersion = JSON.parse(await fs.readFile(path.join(checkout.root, 'package.json'), 'utf8')).version;
      if (await git('tag', '--points-at', 'HEAD', 'v*')) {
        result.track = 'release';
        const distribution = options.distributionUrl || 'https://github.com/ktysne/agent-cockpit.git';
        const tags = await git('ls-remote', '--tags', '--refs', distribution, 'v*');
        let latest = beforeVersion;
        for (const line of tags.split(/\r?\n/)) {
          const version = line.match(/\srefs\/tags\/v(\d+\.\d+\.\d+)$/)?.[1];
          if (version && compareVersions(version, latest) > 0) latest = version;
        }
        result.to = result.from;
        if (compareVersions(latest, beforeVersion) > 0) {
          const ref = `refs/tags/v${latest}`;
          await git('fetch', '--no-tags', distribution, `${ref}:${ref}`);
          result.to = await git('rev-list', '-n', '1', ref);
          if (JSON.parse(await git('show', `${result.to}:package.json`)).version !== latest) {
            return finish('failed', '更新先の package.json の version がタグと一致しません。');
          }
        }
      }
    }
    if (await git('rev-list', '--count', `HEAD..${result.to}`) === '0') return finish('up-to-date', '最新です。');
    try { await git('merge-base', '--is-ancestor', 'HEAD', result.to); }
    catch { return finish('blocked', '更新先の履歴が今の HEAD から分かれていて、fast-forward できません。'); }
    result.commits = (await git('log', '--oneline', '-n', '20', `HEAD..${result.to}`)).split(/\r?\n/).filter(Boolean);
    if (check) return finish('updatable', 'fast-forward で更新できます。');
    await git('merge', '--ff-only', result.to);
    if (await git('rev-parse', 'HEAD') !== result.to) return finish('failed', '更新後の HEAD が更新先と一致しません。');
    if (checkout.tool === 'agent-cockpit') {
      manual.push('常駐サーバーを再起動してから診断をやり直し、適用してください。');
      if (JSON.parse(await fs.readFile(path.join(checkout.root, 'package.json'), 'utf8')).version !== beforeVersion) {
        manual.push('docs/update.md の「バージョンごとの追加作業」を確かめてください。');
      }
    } else manual.push(`${checkout.tool} の写しの更新は、それぞれの手順に従ってください。`);
    return finish('updated', 'fast-forward で更新しました。');
  } catch {
    return finish('failed', 'git による確認または更新に失敗しました。checkout と接続先を確認してください。');
  }
}

async function updateCheckouts(argv, options, log) {
  const tools = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (['--update-checkouts', '--check', '--json'].includes(argv[index])) continue;
    if (argv[index] !== '--tool' || !['agent-cockpit', 'claude-codex-bridge', 'ai-cross-review'].includes(argv[index + 1])) throw new Error('引数が不正です。');
    tools.push(argv[++index]);
  }
  const check = argv.includes('--check');
  if (check ? tools.length : !tools.length) throw new Error('確認か更新対象を選んでください。');
  const observation = await observe(options);
  const report = { schemaVersion: 1, checkouts: [], manual: [] };
  const targets = check ? observation.checkouts
    : [...new Set(tools)].map(tool => observation.checkouts.find(checkout => checkout.tool === tool) || { tool, root: null });
  for (const checkout of targets) report.checkouts.push(await updateCheckout(checkout, check, options, report.manual));
  log(argv.includes('--json') ? JSON.stringify(report) : [
    ...report.checkouts.flatMap(item => [`${item.tool}: ${item.root || '場所不明'}: ${item.status}: ${item.reason}`,
      ...(item.to ? [`  更新先 (${item.track}): ${item.to}`] : []), ...item.commits]), ...report.manual,
  ].join('\n'));
  return report.checkouts.some(item => ['blocked', 'not-found', 'failed'].includes(item.status)) ? 1 : 0;
}

async function main(argv = process.argv.slice(2), options = {}) {
  const log = options.log || console.log;
  const logError = options.logError || console.error;
  try {
    if (argv.includes('--update-checkouts')) return await updateCheckouts(argv, options, log);
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
    const reason = '適用を開始できませんでした。使い方: node src/client/apply.js --from <診断の JSON> --item <id> [--item <id> ...] [--json]、または --update-checkouts (--check | --tool <名前> [--tool <名前> ...]) [--json]。入力と checkout を確認してください。';
    if (argv.includes('--json')) log(JSON.stringify({ schemaVersion: 1, error: reason }));
    else logError(reason);
    return 2;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });

module.exports = { main };
