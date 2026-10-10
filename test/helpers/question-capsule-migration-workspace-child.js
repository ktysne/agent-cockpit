'use strict';

const {
  createFixtureWorkspace,
  recoverFixtureWorkspace,
} = require('./question-capsule-migration-workspace');

const COMMAND_FIELDS = Object.freeze({
  seed: ['command', 'provider', 'scenario', 'maxAdditionalBytes'],
  'seed-and-start': ['command', 'provider', 'scenario', 'maxAdditionalBytes', 'failurePoint', 'pauseAfterBoundary'],
  recover: ['command', 'root', 'maxAdditionalBytes', 'failurePoint', 'pauseAfterBoundary'],
});

function captureInput(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('invalid_question_capsule_migration_workspace_child');
  }
  const command = Object.getOwnPropertyDescriptor(value, 'command')?.value;
  const fields = COMMAND_FIELDS[command];
  if (!fields) throw new TypeError('invalid_question_capsule_migration_workspace_child');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) {
    throw new TypeError('invalid_question_capsule_migration_workspace_child');
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw new TypeError('invalid_question_capsule_migration_workspace_child');
    }
    result[key] = descriptor.value;
  }
  return result;
}

function send(message) {
  if (typeof process.send !== 'function') throw new TypeError('missing_fixture_child_channel');
  process.send(message);
}

async function main() {
  let input;
  try {
    input = captureInput(JSON.parse(process.argv[2]));
    let workspace;
    if (input.command === 'recover') {
      workspace = await recoverFixtureWorkspace({
        root: input.root,
        maxAdditionalBytes: input.maxAdditionalBytes,
        failurePoint: input.failurePoint,
        pauseAfterBoundary: input.pauseAfterBoundary,
      });
    } else {
      workspace = await createFixtureWorkspace({
        provider: input.provider,
        scenario: input.scenario,
        maxAdditionalBytes: input.maxAdditionalBytes,
        failurePoint: input.failurePoint,
        pauseAfterBoundary: input.pauseAfterBoundary,
      });
      send({ type: 'created', root: workspace.root, workspaceId: workspace.workspaceId });
    }

    if (input.command === 'seed-and-start') {
      const result = await workspace.start();
      send({ type: 'result', result });
    } else if (input.command === 'recover') {
      const result = await workspace.recover();
      send({ type: 'result', result });
    } else {
      send({ type: 'result', result: workspace.status() });
    }
    await workspace.close();
    process.disconnect();
  } catch (error) {
    try {
      send({ type: 'error', code: error?.code || error?.message || 'fixture_child_failed' });
    } catch {
      process.exitCode = 1;
    }
    if (process.connected) process.disconnect();
    process.exitCode = 1;
  }
}

main();
