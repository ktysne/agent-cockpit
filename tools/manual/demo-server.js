'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { installFakeClock } = require('./fake-clock');
const { createFakeGh } = require('./fake-gh');
const { loadScenario, scenarioNames } = require('./demo');

// 火曜日の 14:30 JST。曜日や月をまたがない平日の日中で、撮るたびに画像が変わらないよう固定する。
const BASE_TIME_MS = Date.UTC(2026, 9, 6, 5, 30, 0);
const HOOK_PID_FOR_UNMAPPED_SESSION = 1;
const DEFAULT_INTEGRATIONS = Object.freeze({ codexAgent: true, crossReview: true });

function runGit(args, directory, environment) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: directory, env: environment, windowsHide: true, shell: false }, (error, stdout, stderr) => {
      if (error) reject(new Error(`git ${args.join(' ')} に失敗しました: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}

function agentDefinitionText(values) {
  return `---\n${Object.entries(values).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n`;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

// ブランチは .git/HEAD から決まるので、コミットの無い本物のリポジトリを作って HEAD だけを向ける。
async function createRepository(directory, branch, crossReview, environment) {
  await fs.mkdir(directory, { recursive: true });
  await runGit(['init', '--quiet'], directory, environment);
  await runGit(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], directory, environment);
  if (crossReview?.tool) {
    await fs.mkdir(path.join(directory, 'tools'), { recursive: true });
    await fs.writeFile(path.join(directory, 'tools', 'cross-review.js'), '');
  }
  if (crossReview?.state) await writeJson(path.join(directory, '.cross-review-state.json'), { branches: crossReview.state });
}

function requestJson(port, method, requestPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: requestPath,
      headers: { ...headers, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {}
        resolve({ status: response.statusCode, json, text });
      });
    });
    request.once('error', reject);
    request.end(payload);
  });
}

async function removeDirectory(directory) {
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * 隔離した保存先でデモの常駐サーバーを起動し、シナリオを流し込む。
 * 戻り値の close() は、サーバーを止め、固定した時計を戻し、一時ディレクトリを消す。
 */
async function startDemoServer(options = {}) {
  const scenarioName = options.scenario || 'basic';
  const baseTime = options.baseTime ?? BASE_TIME_MS;
  const integrations = { ...DEFAULT_INTEGRATIONS, ...(options.integrations || {}) };
  const scenario = loadScenario(scenarioName, { baseTime });
  const clock = installFakeClock(baseTime - scenario.startMinutesAgo * 60_000);
  let temporaryRoot = null;
  let runtime = null;

  async function close() {
    try {
      await runtime?.close();
    } finally {
      clock.uninstall();
      if (temporaryRoot) await removeDirectory(temporaryRoot);
    }
  }

  try {
    temporaryRoot = await fs.mkdtemp(path.join(options.temporaryParent || os.tmpdir(), 'agent-cockpit-manual-'));
    const homeDir = path.join(temporaryRoot, 'cockpit');
    const claudeHome = path.join(temporaryRoot, 'claude');
    const userHome = path.join(temporaryRoot, 'user');
    const workRoot = path.join(temporaryRoot, 'work');
    await Promise.all([homeDir, claudeHome, userHome, workRoot].map((directory) => fs.mkdir(directory, { recursive: true })));

    const gitConfig = path.join(temporaryRoot, 'gitconfig');
    await fs.writeFile(gitConfig, '');
    const gitEnvironment = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };

    const directories = new Map();
    for (const product of scenario.products) {
      const productDirectory = path.join(workRoot, product.name);
      await createRepository(productDirectory, product.branch, product.crossReview, gitEnvironment);
      directories.set(`${product.name}/`, productDirectory);
      for (const worktree of product.worktrees || []) {
        const worktreeDirectory = path.join(productDirectory, '.claude', 'worktrees', worktree.name);
        await createRepository(worktreeDirectory, worktree.branch, worktree.crossReview, gitEnvironment);
        directories.set(`${product.name}/${worktree.name}`, worktreeDirectory);
      }
    }

    const sessions = new Map();
    for (const session of scenario.sessions) {
      const cwd = directories.get(`${session.product}/${session.worktree || ''}`);
      if (!cwd) throw new Error(`セッション ${session.key} の作業ディレクトリがシナリオにありません`);
      sessions.set(session.key, { ...session, cwd });
      await writeJson(path.join(claudeHome, 'sessions', `${session.id}.json`), {
        sessionId: session.id, pid: process.pid, cwd, name: session.title,
      });
    }
    for (const agent of scenario.claudeAgents || []) {
      await fs.mkdir(path.join(claudeHome, 'agents'), { recursive: true });
      await fs.writeFile(path.join(claudeHome, 'agents', `${agent.name}.md`), agentDefinitionText({ name: agent.name, model: agent.model, effort: agent.effort }));
    }
    for (const agent of scenario.gptAgents || []) {
      await fs.mkdir(path.join(claudeHome, 'gpt-agents'), { recursive: true });
      await fs.writeFile(path.join(claudeHome, 'gpt-agents', `${agent.name}.md`), agentDefinitionText({
        name: agent.name, codex_model: agent.model, codex_reasoning_effort: agent.effort,
      }));
    }

    const gh = createFakeGh(scenario.github, { now: () => clock.now() });
    const { startServer } = require('../../src/server/server');
    runtime = await startServer({
      homeDir,
      claudeHome,
      userHome,
      port: options.port ?? 0,
      pullRequestOptions: { execFileImpl: gh.execFileImpl },
      codexAgentScriptExists: async () => integrations.codexAgent,
      crossReviewToolExists: async () => integrations.crossReview,
      openExternalUrl: async () => {},
    });
    const { port, secret, uiSecret } = runtime.info;

    const post = (requestPath, body, { ui = false } = {}) => requestJson(port, 'POST', requestPath, {
      headers: ui
        ? { 'x-cockpit-secret': uiSecret, origin: `http://127.0.0.1:${port}` }
        : { 'x-cockpit-secret': secret },
      body,
    });
    const ensureOk = (response, label) => {
      if (response.status < 200 || response.status >= 300) throw new Error(`${label} が ${response.status} で失敗しました: ${response.text}`);
      return response.json;
    };
    const sessionFor = (key) => sessions.get(key) || (() => { throw new Error(`シナリオに無いセッションです: ${key}`); })();
    const { makeHookEvent } = require('../../src/hooks/event');

    const demo = {
      clock,
      baseTime,
      port,
      runtime,
      gh,
      sessions,
      /** 時計を「基準時刻の何分前」に進める。戻すことはできない。 */
      at: (minutesAgo) => clock.set(baseTime - minutesAgo * 60_000),
      /** フックが送る形の入力を、そのセッションの cwd と ID を足して /api/events へ送る。 */
      async hook(key, input) {
        const session = sessionFor(key);
        const event = makeHookEvent({ cwd: session.cwd, ...input, session_id: session.id }, clock.now());
        if (!event) throw new Error(`フックの入力が不正です: ${JSON.stringify(input)}`);
        if (event.hook_event_name === 'SubagentStart' && input.route) event.route = input.route;
        ensureOk(await post('/api/events', event), `${key} の ${input.hook_event_name}`);
      },
      /** MCP サーバーが送る形(tasks、add_decision、update_decision)を /api/sessions/<id>/plan へ送る。 */
      async plan(key, body) {
        const session = sessionFor(key);
        return ensureOk(await post(`/api/sessions/${session.id}/plan`, body), `${key} の ${body.kind}`);
      },
      /**
       * MCP サーバーが送る形(add_pr、skip_review)を /api/sessions/<id>/prs へ送る。
       * 全セッションが撮影のプロセスの pid を共有するので、ppid は生きたセッションに対応しない値にして、claudeCodeSessionId で特定させる。
       */
      async prs(key, body) {
        const session = sessionFor(key);
        return ensureOk(await post(`/api/sessions/${session.id}/prs`, {
          ppid: HOOK_PID_FOR_UNMAPPED_SESSION,
          claudeCodeSessionId: session.id,
          ...(body.kind === 'add_pr' ? { cwd: session.cwd } : {}),
          ...body,
        }), `${key} の ${body.kind}`);
      },
      /** 画面から送る操作(離席、外す、表示の設定など)を、画面と同じ秘密値と Origin で送る。 */
      async ui(requestPath, body) {
        return ensureOk(await post(requestPath, body, { ui: true }), requestPath);
      },
      async getState() {
        return ensureOk(await requestJson(port, 'GET', '/api/state'), '/api/state');
      },
      /** PR の取得が終わるまで待つ。 */
      async refreshPullRequests() {
        await runtime.pullRequestTracker.refreshAll();
        await runtime.state.waitForPersistence();
      },
    };

    await scenario.play(demo);
    clock.set(baseTime);
    await demo.refreshPullRequests();
    await runtime.state.waitForPersistence();

    const unexpectedGh = gh.unexpectedCalls();
    if (unexpectedGh.length) throw new Error(`偽の gh が定義に無い呼び出しを受けました:\n${unexpectedGh.join('\n')}`);
    // 画面で操作を試すときは、既読の後のマージのように時刻の前後で表示が変わるので、流し込みの後は時計を進める。
    if (options.followRealTime) clock.followRealTime();

    return {
      ...demo,
      url: `http://127.0.0.1:${port}/`,
      homeDir,
      temporaryRoot,
      /** 偽の gh が定義に無い呼び出しを受けていたら例外にする。 */
      assertHealthy() {
        const calls = gh.unexpectedCalls();
        if (calls.length) throw new Error(`偽の gh が定義に無い呼び出しを受けました:\n${calls.join('\n')}`);
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

function parseDemoArguments(argv) {
  const options = { scenario: 'basic', port: 0, live: true };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--port') options.port = Number(argv[++index]);
    else if (argument === '--fixed') options.live = false;
    else if (argument.startsWith('-')) throw new Error(`不明な引数です: ${argument}`);
    else options.scenario = argument;
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('--port は 0〜65535 の整数で指定してください');
  if (!scenarioNames().includes(options.scenario)) throw new Error(`シナリオがありません: ${options.scenario}(${scenarioNames().join('、')})`);
  return options;
}

// 画面を見ながら原稿を書くための単体起動。画面側の時計は実時刻なので、基準時刻を起動時刻に合わせて待ち時間が読めるようにする。
async function main() {
  const options = parseDemoArguments(process.argv.slice(2));
  const baseTime = options.live ? Math.floor(Date.now() / 60_000) * 60_000 : BASE_TIME_MS;
  const demo = await startDemoServer({ scenario: options.scenario, port: options.port, baseTime, followRealTime: options.live });
  console.log(`デモのダッシュボード(${options.scenario}): ${demo.url}`);
  console.log('止めるには Ctrl+C を押します。');
  const stop = () => demo.close().then(() => process.exit(0), (error) => {
    console.error(error.message);
    process.exit(1);
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { BASE_TIME_MS, startDemoServer, parseDemoArguments };
