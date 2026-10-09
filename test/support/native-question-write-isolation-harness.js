'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createOwnedNativeRunner } = require('../../src/server/owned-native-runner');
const { AwayState } = require('../../src/server/state');
const {
  createFakeNativeProcess,
  defaultProfiles,
  PROVIDERS,
} = require('./native-instruction-integration-harness');
const { loadQuestionWriteIsolationModules } = require('./question-write-isolation-loader');
const {
  DATA_FILES,
  reclamationConfig,
  threeSlotLegacySources,
} = require('./native-migration-allowance-release-harness');

const ANCHOR_FILE = 'question-reclamation-anchor.json';

function questionDependencies() {
  return {
    away: new AwayState(),
    settings: {
      getAutoApplySettings: () => ({ enabled: false, minimumWaitMs: 300_000 }),
      getStatus: () => ({ status: 'ready', revision: 'question-write-isolation-fixture', reason: null }),
      subscribe: () => () => {},
    },
  };
}

function normalByteLimitsBySlot(sources, paddingBytes) {
  return Object.fromEntries(Object.keys(DATA_FILES).map((slot) =>
    [slot, sources[slot].length + paddingBytes]));
}

async function createNativeQuestionWriteIsolationHarness(provider, options = {}) {
  if (!PROVIDERS.includes(provider)) throw new TypeError('unknown provider');
  const directory = options.directory || await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),
    'native-question-write-isolation-'));
  const sources = options.sources || threeSlotLegacySources(provider);
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(Object.entries(DATA_FILES).map(([slot, name]) =>
    fs.writeFile(path.join(directory, name), sources[slot])));

  const profiles = options.profiles || defaultProfiles(directory);
  await Promise.all(Object.values(profiles).flatMap((profile) => [profile.homePath, profile.cwd])
    .map((directoryPath) => fs.mkdir(directoryPath, { recursive: true })));
  const normalLimits = options.normalByteLimitsBySlot || normalByteLimitsBySlot(sources,
    options.paddingBytes ?? 16 * 1024);
  const modules = loadQuestionWriteIsolationModules(options.schedulerTimers === undefined
    ? {} : { schedulerTimers: options.schedulerTimers });
  options.onModules?.(modules);
  const processesByProvider = new Map(PROVIDERS.map((value) => [value, []]));
  let now = options.initialNow ?? 1_000_000;
  let integration = null;
  let closed = false;

  function runnerFactory(runnerOptions) {
    const providerProcesses = processesByProvider.get(runnerOptions.provider);
    const process = createFakeNativeProcess(runnerOptions.provider, runnerOptions.homePath, {
      nativeIdSuffix: providerProcesses.length + 1,
    });
    providerProcesses.push(process);
    return createOwnedNativeRunner({
      ...runnerOptions,
      spawnImpl: process.spawnImpl,
      timeouts: { startupMs: 1000, rpcMs: 1000, loginMs: 1000, stopMs: 250 },
    });
  }

  function onAuthenticationRequired(challenge) {
    const process = processesByProvider.get('codex').at(-1);
    if (!process || !process.completeLogin(challenge.loginId)) {
      throw new Error('fixture_login_process_unavailable');
    }
  }

  async function createIntegration() {
    let created = null;
    try {
      created = await modules.integration.createNativeInstructionServiceIntegration({
        profiles,
        dataDirectory: directory,
        hostId: options.hostId || 'native-question-write-isolation-host',
        runnerFactory,
        getAuthentication: () => ({ oauthToken: 'native-question-write-isolation-token' }),
        onAuthenticationRequired,
        now: () => now,
        commonQuestions: questionDependencies(),
        reclamation: reclamationConfig(normalLimits, Object.hasOwn(options, 'autoReclaim')
          ? { autoReclaim: options.autoReclaim } : {}),
      });
      await Promise.all([created.service.ready(), created.questionService.ready()]);
      return created;
    } catch (error) {
      if (created !== null) await created.close().catch(() => {});
      throw error;
    }
  }

  integration = await createIntegration();

  function currentContext() {
    return modules.observer.contexts().at(-1) || null;
  }

  function currentComposition() {
    return modules.observer.compositions().at(-1) || null;
  }

  async function start(providerInput = provider, suffix = 'launch') {
    if (!PROVIDERS.includes(providerInput)) throw new TypeError('unknown provider');
    const started = await integration.native.startLaunch({
      launchId: `launch-${providerInput}-${suffix}`,
      runId: `run-${providerInput}-${suffix}`,
      attemptId: `attempt-${providerInput}-${suffix}`,
      profileId: providerInput,
      origin: 'standalone',
      purpose: 'agent',
      inputText: `native question write isolation ${providerInput}`,
    });
    const composition = currentComposition();
    const writer = composition?.writerFor(started.result.launchRef) || null;
    if (writer === null) throw new Error('native_question_writer_unavailable');
    return { ...started, writer, process: processesByProvider.get(providerInput).at(-1) };
  }

  function pathFor(slot) {
    if (slot === 'anchor') return path.join(directory, ANCHOR_FILE);
    if (!Object.hasOwn(DATA_FILES, slot)) throw new TypeError('unknown storage slot');
    return path.join(directory, DATA_FILES[slot]);
  }

  async function readSlotBytes() {
    return Object.fromEntries(await Promise.all(Object.entries(DATA_FILES).map(async ([slot, name]) =>
      [slot, await fs.readFile(path.join(directory, name))])));
  }

  async function readAllBytes() {
    return { ...(await readSlotBytes()), anchor: await fs.readFile(pathFor('anchor')) };
  }

  async function readJson(slot) {
    return JSON.parse(await fs.readFile(pathFor(slot), 'utf8'));
  }

  async function close() {
    if (closed) return;
    closed = true;
    await integration.close();
  }

  async function restart() {
    await close();
    closed = false;
    integration = await createIntegration();
    return integration;
  }

  async function removeDirectory() {
    await close();
    await fs.rm(directory, { recursive: true, force: true });
  }

  return Object.freeze({
    directory,
    provider,
    sources,
    normalByteLimitsBySlot: normalLimits,
    modules,
    processesByProvider,
    pathFor,
    readSlotBytes,
    readAllBytes,
    readJson,
    start,
    restart,
    close,
    removeDirectory,
    setNow(value) { now = value; },
    get now() { return now; },
    get integration() { return integration; },
    get context() { return currentContext(); },
    get composition() { return currentComposition(); },
    get nativeFileSystem() { return modules.nativeFileSystem; },
  });
}

module.exports = { createNativeQuestionWriteIsolationHarness };
