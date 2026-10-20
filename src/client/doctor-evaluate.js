const path = require('node:path');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const SESSION_ACTION = { op: 'manual', text: '登録と写しを直した後に新しいセッションを開いてください。開き直したセッションだけが新しい内容で動きます。' };
const TRUST_ACTION = { op: 'manual', text: 'Codex の /hooks でフックを信頼し直してください。' };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = text => createHash('sha256').update(text).digest('hex');

function subtreeDigest(value, keys) {
  for (const key of keys) value = object(value) && Object.hasOwn(value, key) ? value[key] : null;
  return digest(JSON.stringify(value ?? null));
}

function tomlTableName(line) {
  return line.trim().match(/^\[\s*(.*?)\s*\]\s*(?:#.*)?$/)?.[1]
    .replace(/"([\w-]+)"|'([\w-]+)'/g, (_, basic, literal) => basic || literal).replace(/\s*\.\s*/g, '.');
}

function normalizedPath(value) {
  const paths = path.sep === '\\' || /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\') ? path.win32 : path.posix;
  const normalized = paths.normalize(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return paths === path.win32 ? normalized.toLowerCase() : normalized;
}

function nodeCommand(command) {
  return typeof command === 'string' && /^node(?:\.exe)?$/i.test(command.replace(/\\/g, '/').split('/').pop());
}

function execution(hook) {
  if (Array.isArray(hook.args)) return { command: hook.command, script: hook.args[0], args: hook.args.slice(1) };
  if (typeof hook.command !== 'string') return { command: null, script: null, args: [] };
  const parts = [...hook.command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map(match => match[1] ?? match[2] ?? match[3]);
  return { command: parts[0], script: parts[1], args: parts.slice(2) };
}

// Claude Code と Codex は、matcher が無い、空、"*" のどれでもすべてのツールに一致する。
function matcherKey(matcher) {
  return matcher === undefined || matcher === null || matcher === '' || matcher === '*' ? '' : matcher;
}

function hookValue(hook) {
  const run = execution(hook);
  return { type: hook.type ?? null, command: nodeCommand(run.command) ? 'node' : run.command ?? null,
    script: typeof run.script === 'string' ? normalizedPath(run.script) : null, args: run.args,
    timeout: hook.timeout ?? null, async: hook.async ?? false, asyncRewake: hook.asyncRewake ?? false };
}

function hookEntries(document) {
  if (!object(document.value?.hooks)) return [];
  return Object.entries(document.value.hooks).flatMap(([event, groups]) => Array.isArray(groups)
    ? groups.flatMap((group, groupIndex) => Array.isArray(group?.hooks) ? group.hooks.flatMap((hook, hookIndex) => {
      if (!object(hook)) return [];
      const run = execution(hook);
      const match = typeof run.script === 'string' && run.script.replace(/\\/g, '/').match(/^(.*)\/src\/hooks\/([^/]+)\.js$/i);
      return [{ event, matcher: group.matcher ?? null, matcherKey: matcherKey(group.matcher), hook, groupIndex, hookIndex,
        root: match ? match[1] : null, name: match ? match[2] : null }];
    }) : []) : []);
}

function parseMcpToml(text) {
  const tables = new Map();
  let current = null;
  let tableName = '';
  let invalid = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      const header = line.match(/^\[\s*(.*?)\s*\]\s*(?:#.*)?$/);
      const name = tomlTableName(line);
      tableName = name ?? '';
      current = name === 'mcp_servers.agent-cockpit' || name?.startsWith('mcp_servers.agent-cockpit.tools.') ? name : null;
      if (current) {
        if (tables.has(current)) invalid = true;
        tables.set(current, {});
      } else if (line.includes('mcp_servers.agent-cockpit') && !header) invalid = true;
      continue;
    }
    // インラインテーブルやドット付きのキーで書いた登録とツールの設定は読まないので、読めない設定として扱う。
    const key = line.split('=')[0].trim().replace(/["']/g, '').replace(/\s*\.\s*/g, '.');
    if (!current) {
      const fullKey = tableName ? `${tableName}.${key}` : key;
      const otherSubtable = tableName.startsWith('mcp_servers.agent-cockpit.') && tableName !== 'mcp_servers.agent-cockpit.tools';
      if (!otherSubtable && (fullKey === 'mcp_servers.agent-cockpit' || fullKey.startsWith('mcp_servers.agent-cockpit.')
        || (fullKey === 'mcp_servers' && line.includes('agent-cockpit')))) invalid = true;
      continue;
    }
    if (current === 'mcp_servers.agent-cockpit' && (key === 'tools' || key.startsWith('tools.'))) { invalid = true; continue; }
    const pair = line.match(/^(command|args|approval_mode)\s*=\s*(.*?)\s*$/);
    if (!pair) continue;
    const value = pair[2].replace(/#(?=(?:[^"']*["'][^"']*["'])*[^"']*$).*$/, '').trim();
    try {
      const parsed = /^'[^']*'$/.test(value) ? value.slice(1, -1) : JSON.parse(value);
      if (Object.hasOwn(tables.get(current), pair[1])) invalid = true;
      tables.get(current)[pair[1]] = parsed;
    } catch { invalid = true; }
  }
  return { tables, invalid };
}

// 同じグループに利用者のフックが同居しうるため、置き換えと削除はフック 1 件だけを対象にする。
// matcher はグループの属性なので、違うときはフックを外して期待するグループを足す。
function hookActions(document, provider, entry, expectedGroup) {
  const target = { file: document.file, path: ['hooks', entry.event], observedDigest: document.observedDigest };
  // 同じ matcher とスクリプトのフックが重複しうるので、観測した位置で 1 件を指す。位置は observedDigest が一致する間だけ有効である。
  const remove = { op: 'json-remove', target: 'hook', ...target, match: { matcher: entry.matcher, script: execution(entry.hook).script ?? null,
    groupIndex: entry.groupIndex, hookIndex: entry.hookIndex } };
  const edits = !expectedGroup ? [remove]
    : entry.matcherKey === matcherKey(expectedGroup.matcher) ? [{ ...remove, op: 'json-replace', value: expectedGroup.hooks[0] }]
      : [remove, addGroupAction(document, entry.event, expectedGroup)];
  return [...edits, ...(provider === 'codex' ? [TRUST_ACTION] : []), SESSION_ACTION];
}

function addGroupAction(document, event, group) {
  return { op: 'json-add', target: 'group', file: document.file, path: ['hooks', event],
    match: { matcher: group.matcher ?? null, script: execution(group.hooks[0]).script }, value: group, observedDigest: document.observedDigest };
}

function checkHooks(provider, document, entries, manifest, add, conflictingRoots, bridgeInstalled = false) {
  if (document.invalid || (!document.missing && document.value.hooks !== undefined && !object(document.value.hooks)) ||
      Object.values(document.value?.hooks || {}).some(groups => !Array.isArray(groups) || groups.some(group => !Array.isArray(group?.hooks)))) {
    add(provider, 'hooks', 'file', document.file, null, null, 'unverified', 'フックの設定を読めないため、導入手順と手で見比べてください。');
    return;
  }
  const remaining = [...entries];
  const hookSets = [
    ...Object.entries(manifest.hooks).map(([event, groups]) => ({ event, groups, bridge: false })),
    ...Object.entries(manifest.routeHooks || {}).map(([event, groups]) => ({ event, groups, bridge: true })),
  ];
  for (const { event, groups, bridge } of hookSets) {
    for (const group of groups) {
      const expected = group.hooks[0];
      const name = path.basename(execution(expected).script, '.js');
      const matcher = group.matcher ?? null;
      const key = matcherKey(matcher);
      const required = !bridge || bridgeInstalled;
      const index = remaining.findIndex(entry => entry.event === event && entry.name === name && (bridge || entry.matcherKey === key));
      const entry = index < 0 ? null : remaining.splice(index, 1)[0];
      if (!entry && !required) continue;
      const agrees = entry && entry.matcherKey === key && isDeepStrictEqual(hookValue(entry.hook), hookValue(expected));
      const otherCheckout = entry && entry.root && normalizedPath(entry.root) !== normalizedPath(path.dirname(path.dirname(path.dirname(execution(expected).script))));
      const actions = entry ? hookActions(document, provider, entry, group)
        : [addGroupAction(document, event, group), ...(provider === 'codex' ? [TRUST_ACTION] : []), SESSION_ACTION];
      const ok = agrees && !conflictingRoots.length;
      const reason = ok ? 'フックの登録は対象の checkout と一致しています。'
        : conflictingRoots.length ? 'フックが複数の checkout を指しているため、使う checkout にそろえてください。'
          : !entry ? 'フックが登録されていないため、導入手順の登録を足してください。'
            : otherCheckout ? 'フックが別の checkout を指しているため、対象の checkout を指す登録に直してください。'
              : 'フックの matcher、引数、timeout のどれかが導入手順と違うため、導入手順の値に直してください。';
      add(provider, 'hooks', `${event}.${key || 'all'}.${name}`, document.file, { matcher: key, ...hookValue(expected) },
        entry ? { matcher: entry.matcherKey, ...hookValue(entry.hook), ...(conflictingRoots.length ? { checkoutCandidates: conflictingRoots } : {}) } : null,
        ok ? 'ok' : 'mismatch', reason, ok ? [] : actions);
    }
  }
  remaining.filter(entry => entry.name !== 'route').forEach((entry, index) => add(provider, 'hooks', `extra.${entry.event}.${entry.name}.${index}`, document.file, null,
    hookValue(entry.hook), 'mismatch', '期待する登録に無いフックがあるため、この登録を取り除いてください。', hookActions(document, provider, entry, null)));
}

function mcpExecution(value) {
  if (!object(value)) return null;
  return { command: nodeCommand(value.command) ? 'node' : typeof value.command === 'string' ? value.command : null,
    args: Array.isArray(value.args) ? value.args.map((arg, index) => index === 0 && typeof arg === 'string' ? normalizedPath(arg) : arg) : null };
}

function checkMcp(provider, document, registration, manifest, add, shadowed, invalid) {
  if (document.invalid || invalid || shadowed) {
    add(provider, 'mcp', 'registration', document.file, mcpExecution(manifest.mcp), null, 'unverified', shadowed
      ? 'プロジェクトの同名の MCP 登録が優先されるため、プロジェクトの登録を手で確認してください。'
      : 'MCP の設定を解釈できないため、導入手順と手で見比べてください。');
    return;
  }
  const expected = mcpExecution(manifest.mcp);
  const observed = mcpExecution(registration);
  const agrees = isDeepStrictEqual(expected, observed);
  const actions = ['command', 'args'].map(key => provider === 'claude'
    ? { op: registration && Object.hasOwn(registration, key) ? 'json-replace' : 'json-add', file: document.file,
      path: ['mcpServers', 'agent-cockpit', key], match: { name: 'agent-cockpit' }, value: manifest.mcp[key],
      digestPath: ['mcpServers', 'agent-cockpit'], observedDigest: subtreeDigest(document.value, ['mcpServers', 'agent-cockpit']) }
    : { op: 'toml-set', file: document.file, table: 'mcp_servers.agent-cockpit', key, value: manifest.mcp[key], observedDigest: document.observedDigest });
  add(provider, 'mcp', 'registration', document.file, expected, observed, agrees ? 'ok' : 'mismatch', agrees
    ? 'MCP サーバーの実行先は対象の checkout と一致しています。'
    : 'MCP サーバーの実行先が違うため、対象の checkout を指す登録に直してください。', agrees ? [] : [...actions, SESSION_ACTION]);
  if (provider === 'codex') {
    for (const [name, tool] of Object.entries(manifest.mcp.tools)) {
      const approval = registration?.tools?.[name]?.approval_mode ?? null;
      const matches = approval === tool.approval_mode;
      add(provider, 'mcp', `tools.${name}`, document.file, tool.approval_mode, approval, matches ? 'ok' : 'mismatch', matches
        ? 'MCP ツールは許可待ちで止まらない設定です。' : 'MCP ツールが許可待ちで止まるため、approval_mode を approve にしてください。', matches ? []
        : [{ op: 'toml-set', file: document.file, table: `mcp_servers.agent-cockpit.tools.${name}`, key: 'approval_mode',
          value: tool.approval_mode, observedDigest: document.observedDigest }, SESSION_ACTION]);
    }
  }
}

function checkSkills(provider, skills, add) {
  for (const { source, destination, target, original, copy } of skills) {
    const optional = destination.includes('/update-tools/');
    const result = copy.missing && optional ? 'not-installed' : original.missing || original.invalid || copy.invalid ? 'unverified'
      : copy.missing || original.text.replace(/\r\n/g, '\n') !== copy.text.replace(/\r\n/g, '\n') ? 'mismatch' : 'ok';
    add(provider, 'skills', optional ? 'update-tools' : 'agent-cockpit', target,
      original.text === null ? null : digest(original.text.replace(/\r\n/g, '\n')),
      copy.text === null ? null : digest(copy.text.replace(/\r\n/g, '\n')), result,
      result === 'ok' ? 'スキルの写しは対象の checkout と一致しています。'
        : result === 'not-installed' ? '更新用スキルは未導入です。必要なときは導入手順で追加できます。'
        : result === 'unverified' ? 'スキルを読めないため、正本と写しを手で確認してください。'
        : 'スキルの写しが無いか内容が違うため、対象の checkout からコピーし直してください。', result === 'mismatch'
        ? [{ op: 'copy', from: source, to: target, observedDigest: copy.observedDigest }, SESSION_ACTION] : []);
  }
}

function checkServer(home, root, expected, server, add) {
  const { port, pid, startedAt, health, sourceState, entries } = server;
  const observed = health ? { version: health.version ?? null, commit: health.commit ?? null, sourceState: health.sourceState ?? null,
    port, pid, startedAt } : null;
  const wrong = health && (health.app !== 'agent-cockpit' || health.pid !== pid || health.startedAt !== startedAt ||
    health.version !== expected.version || (expected.commit !== null && health.commit !== expected.commit) ||
    (!['unknown', 'pending'].includes(sourceState) && !['unknown', 'pending', undefined].includes(health.sourceState) && health.sourceState !== sourceState));
  const result = wrong ? 'mismatch' : !health || expected.commit === null || ['unknown', 'pending'].includes(sourceState) ||
    !health.sourceState || ['unknown', 'pending'].includes(health.sourceState) ? 'unverified' : 'ok';
  add(null, 'server', 'running', path.join(home, 'server.json'), { ...expected, sourceState }, observed, result,
    result === 'ok' ? '常駐サーバーは対象の checkout と一致しています。' : result === 'mismatch'
      ? '常駐サーバーが対象の checkout と違うため、対象の checkout から再起動してください。'
      : '常駐サーバーの一致を確認できませんでした。停止中なら新しいセッションの SessionStart が起動します。', result === 'mismatch'
      ? [{ op: 'command', command: 'node src/client/restart-server.js --json', cwd: root }] : []);
  const identities = entries.filter(entry => entry.msg === 'mcp.write' && typeof entry.data?.version === 'string')
    .map(entry => ({ version: entry.data.version, commit: entry.data.commit ?? null }));
  const unique = [...new Map(identities.map(identity => [JSON.stringify(identity), identity])).values()];
  const mismatch = unique.some(identity => identity.version !== expected.version || (expected.commit !== null && identity.commit !== null && identity.commit !== expected.commit));
  const verified = unique.length && expected.commit !== null && unique.every(identity => identity.commit !== null);
  // 記録はセッションを閉じた後も起動のあいだ残るので、古い記録があっても今動いているとは言えない。
  add(null, 'mcp-runtime', 'current', '/api/diagnostics', expected, unique, verified && !mismatch ? 'ok' : 'unverified', mismatch
    ? '今の起動に、対象の checkout より古い MCP プロセスの記録があります。その頃から開いているセッションがあれば開き直してください。'
    : verified ? '今の起動に記録された MCP プロセスは対象の checkout と一致しています。'
      : '今の起動の MCP のバージョンとコミットの記録が足りないため、実行中の MCP は未確認です。', mismatch ? [SESSION_ACTION] : []);
}

function evaluate(observation) {
  const { homes, hooks, candidates, root, resolvedBy, expected, manifest, generatedAt, bridgeInstalled,
    claudeHooks, codexHooks, claudeMcp, codexConfig, skills, skillPresent, server } = observation;
  const items = [];
  const add = (provider, category, suffix, target, wanted, observed, result, reason, actions = []) => items.push({
    id: `${provider || 'cockpit'}.${category}.${suffix}`, tool: 'agent-cockpit', provider, category, target,
    expected: wanted, observed, observedAt: generatedAt, result, reason, actions,
  });
  const toml = parseMcpToml(codexConfig.text || '');
  const codexRegistration = toml.tables.get('mcp_servers.agent-cockpit');
  if (codexRegistration) codexRegistration.tools = Object.fromEntries([...toml.tables].filter(([table]) => table.startsWith('mcp_servers.agent-cockpit.tools.'))
    .map(([table, value]) => [table.slice('mcp_servers.agent-cockpit.tools.'.length), value]));
  for (const provider of ['claude', 'codex']) {
    const hookDocument = provider === 'claude' ? claudeHooks : codexHooks;
    const mcpDocument = provider === 'claude' ? claudeMcp : codexConfig;
    const registration = provider === 'claude' ? claudeMcp.value?.mcpServers?.['agent-cockpit'] : codexRegistration;
    const entries = hooks[provider].filter(entry => entry.cockpit || (entry.root && normalizedPath(entry.root) === normalizedPath(root)));
    const shadowed = provider === 'claude' && Object.values(claudeMcp.value?.projects || {}).some(project => object(project?.mcpServers) && Object.hasOwn(project.mcpServers, 'agent-cockpit'));
    const installed = entries.length || registration !== undefined || skillPresent[provider] || shadowed;
    if (!installed) {
      if (hookDocument.invalid || mcpDocument.invalid || (provider === 'codex' && toml.invalid)) {
        add(provider, 'hooks', 'installation', homes[provider], null, null, 'unverified', '設定を読めないため、導入済みかを確認できませんでした。');
      } else add(provider, 'hooks', 'installation', homes[provider], null, null, 'not-installed', 'agent-cockpit は未導入のため、この provider の照合は対象外です。');
      continue;
    }
    checkHooks(provider, hookDocument, entries, manifest[provider], add, resolvedBy !== 'root' && candidates.length > 1 ? candidates : [],
      provider === 'claude' && bridgeInstalled);
    checkMcp(provider, mcpDocument, registration, manifest[provider], add, shadowed, provider === 'codex' && toml.invalid);
    checkSkills(provider, skills[provider], add);
  }
  checkServer(homes.cockpit, root, expected, server, add);
  add(null, 'runtime-check', 'roundtrip', 'docs/setup.md', null, null, 'not-run',
    'MCP の書き込みと質問の回答の往復は実施していません。導入手順の「確認」で実際に操作してください。',
    [{ op: 'manual', text: 'docs/setup.md のパターン A または E の「確認」で、MCP の書き込みと質問の回答を試してください。' }]);
  const summary = { ok: 0, mismatch: 0, unverified: 0, notRun: 0, notInstalled: 0 };
  for (const item of items) summary[{ 'not-run': 'notRun', 'not-installed': 'notInstalled' }[item.result] || item.result] += 1;
  return { schemaVersion: 1, generatedAt, checkout: { root, ...expected, resolvedBy }, homes, summary, items };
}

module.exports = { evaluate, hookEntries, normalizedPath, execution, subtreeDigest, tomlTableName };
