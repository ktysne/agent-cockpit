'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS } = require('../src/server/common-question-service');
const { createCommonQuestionSettings } = require('../src/server/common-question-settings');

async function tempDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'common-question-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function settingsPath(directory) {
  return path.join(directory, 'common-question-settings.json');
}

test('missing settings start disabled and can be saved with the default wait omitted', async (t) => {
  const directory = await tempDir(t);
  const settings = await createCommonQuestionSettings({ dataDirectory: directory });
  const initialRevision = settings.getStatus().revision;
  assert.equal(settings.getStatus().status, 'missing');
  assert.equal(typeof initialRevision, 'string');
  assert.deepEqual(settings.getAutoApplySettings(), {
    enabled: false,
    minimumWaitMs: DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS,
  });
  assert.throws(() => { settings.getAutoApplySettings().enabled = true; }, TypeError);

  await settings.updateSettings({ expectedRevision: initialRevision, enabled: true });
  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath(directory), 'utf8')),
    { schemaVersion: 1, autoApply: { enabled: true } });
  assert.equal(settings.getStatus().status, 'ready');
  assert.notEqual(settings.getStatus().revision, initialRevision);
  assert.deepEqual(settings.getAutoApplySettings(), {
    enabled: true,
    minimumWaitMs: DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS,
  });
});

test('settings persist across initialization and explicit wait values are retained', async (t) => {
  const directory = await tempDir(t);
  const first = await createCommonQuestionSettings({ dataDirectory: directory });
  const originalRevision = first.getStatus().revision;
  await first.updateSettings({ expectedRevision: originalRevision, enabled: true, minimumWaitMs: 600_000 });
  const reopened = await createCommonQuestionSettings({ dataDirectory: directory });
  assert.equal(reopened.getStatus().status, 'ready');
  assert.notEqual(reopened.getStatus().revision, originalRevision);
  assert.deepEqual(reopened.getAutoApplySettings(), { enabled: true, minimumWaitMs: 600_000 });
  await assert.rejects(reopened.updateSettings({ expectedRevision: originalRevision, enabled: false }),
    { code: 'stale_settings_revision' });
});

test('corrupt, unknown, and invalid settings fail closed and cannot be overwritten', async (t) => {
  const directory = await tempDir(t);
  const filePath = settingsPath(directory);
  const invalidFiles = [
    '{broken',
    JSON.stringify({ schemaVersion: 2, autoApply: { enabled: true } }),
    JSON.stringify({ schemaVersion: 1, unexpected: true, autoApply: { enabled: true } }),
    JSON.stringify({ schemaVersion: 1, autoApply: { enabled: false, minimumWaitMs: 1 } }),
  ];

  for (const bytes of invalidFiles) {
    await fs.writeFile(filePath, bytes);
    const settings = await createCommonQuestionSettings({ dataDirectory: directory });
    assert.equal(settings.getStatus().status, 'invalid');
    assert.deepEqual(settings.getAutoApplySettings(), {
      enabled: false,
      minimumWaitMs: DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS,
    });
    await assert.rejects(settings.updateSettings({ expectedRevision: settings.getStatus().revision, enabled: true }),
      { code: 'settings_not_writable' });
    assert.equal(await fs.readFile(filePath, 'utf8'), bytes);
  }
});

test('concurrent updates serialize and reject a stale revision', async (t) => {
  const directory = await tempDir(t);
  const settings = await createCommonQuestionSettings({ dataDirectory: directory });
  const revision = settings.getStatus().revision;
  const results = await Promise.allSettled([
    settings.updateSettings({ expectedRevision: revision, enabled: true }),
    settings.updateSettings({ expectedRevision: revision, enabled: false, minimumWaitMs: 600_000 }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'stale_settings_revision');
  assert.notEqual(settings.getStatus().revision, revision);
  const reopened = await createCommonQuestionSettings({ dataDirectory: directory });
  assert.deepEqual(reopened.getAutoApplySettings(), settings.getAutoApplySettings());
});

test('external edits are detected before saving and require restart to reload', async (t) => {
  const directory = await tempDir(t);
  const settings = await createCommonQuestionSettings({ dataDirectory: directory });
  const notifications = [];
  settings.subscribe((event) => notifications.push(event));
  const initialRevision = settings.getStatus().revision;
  await settings.updateSettings({ expectedRevision: initialRevision, enabled: true, minimumWaitMs: 600_000 });
  const savedRevision = settings.getStatus().revision;
  const edited = JSON.stringify({ schemaVersion: 1, autoApply: { enabled: false } });
  await fs.writeFile(settingsPath(directory), edited);

  await assert.rejects(settings.updateSettings({ expectedRevision: savedRevision, enabled: false }),
    { code: 'settings_changed' });
  assert.equal(settings.getStatus().status, 'changed');
  assert.equal(settings.getAutoApplySettings().enabled, false);
  assert.equal(settings.getAutoApplySettings().minimumWaitMs, 600_000);
  assert.equal(await fs.readFile(settingsPath(directory), 'utf8'), edited);
  assert.equal(notifications.at(-1).status.status, 'changed');
  assert.equal(notifications.at(-1).autoApply.enabled, false);
  await assert.rejects(settings.updateSettings({ expectedRevision: savedRevision, enabled: false }),
    { code: 'settings_changed' });
});

test('read failures report only a safe status and block updates', async (t) => {
  const directory = await tempDir(t);
  await fs.writeFile(settingsPath(directory), JSON.stringify({ schemaVersion: 1, autoApply: { enabled: true } }));
  const fileSystem = {
    lstat: (...args) => fs.lstat(...args),
    readFile: async () => { throw Object.assign(new Error('private path detail'), { code: 'EACCES' }); },
    writeFile: (...args) => fs.writeFile(...args),
    rename: (...args) => fs.rename(...args),
    rm: (...args) => fs.rm(...args),
  };
  const settings = await createCommonQuestionSettings({ dataDirectory: directory, fileSystem });
  assert.deepEqual(settings.getStatus(), {
    status: 'unavailable', revision: settings.getStatus().revision, reason: 'settings_read_failed',
  });
  assert.equal(JSON.stringify(settings.getStatus()).includes('private path detail'), false);
  await assert.rejects(settings.updateSettings({ expectedRevision: settings.getStatus().revision, enabled: true }),
    { code: 'settings_not_writable' });
});

test('failed atomic writes keep the previous snapshot and remove the temporary file', async (t) => {
  const directory = await tempDir(t);
  const fileSystem = {
    lstat: (...args) => fs.lstat(...args),
    readFile: (...args) => fs.readFile(...args),
    writeFile: (...args) => fs.writeFile(...args),
    rename: async () => { throw Object.assign(new Error('rename failed'), { code: 'EIO' }); },
    rm: (...args) => fs.rm(...args),
  };
  const settings = await createCommonQuestionSettings({ dataDirectory: directory, fileSystem });
  const revision = settings.getStatus().revision;
  await assert.rejects(settings.updateSettings({ expectedRevision: revision, enabled: true }),
    { code: 'settings_write_failed' });
  assert.equal(settings.getStatus().status, 'missing');
  assert.equal(settings.getStatus().revision, revision);
  assert.deepEqual(settings.getAutoApplySettings(), {
    enabled: false,
    minimumWaitMs: DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS,
  });
  assert.deepEqual(await fs.readdir(directory), []);
});

test('failed atomic writes disable auto-apply when the file outcome changed', async (t) => {
  const directory = await tempDir(t);
  const fileSystem = {
    lstat: (...args) => fs.lstat(...args),
    readFile: (...args) => fs.readFile(...args),
    writeFile: (...args) => fs.writeFile(...args),
    rename: async (_temporary, target) => {
      await fs.writeFile(target, JSON.stringify({ schemaVersion: 1, autoApply: { enabled: true } }));
      throw Object.assign(new Error('rename outcome is ambiguous'), { code: 'EIO' });
    },
    rm: (...args) => fs.rm(...args),
  };
  const settings = await createCommonQuestionSettings({ dataDirectory: directory, fileSystem });
  const notifications = [];
  settings.subscribe((event) => notifications.push(event));
  const revision = settings.getStatus().revision;

  await assert.rejects(settings.updateSettings({ expectedRevision: revision, enabled: true }),
    { code: 'settings_write_failed' });
  assert.equal(settings.getStatus().status, 'changed');
  assert.equal(settings.getAutoApplySettings().enabled, false);
  assert.equal(notifications.at(-1).status.status, 'changed');
  assert.equal(notifications.at(-1).autoApply.enabled, false);
});

test('failed writes disable auto-apply when the saved bytes cannot be rechecked', async (t) => {
  const directory = await tempDir(t);
  await fs.writeFile(settingsPath(directory), JSON.stringify({ schemaVersion: 1, autoApply: { enabled: true } }));
  let reads = 0;
  const fileSystem = {
    lstat: (...args) => fs.lstat(...args),
    readFile: async (...args) => {
      reads += 1;
      if (reads === 3) throw Object.assign(new Error('verification unavailable'), { code: 'EACCES' });
      return fs.readFile(...args);
    },
    writeFile: (...args) => fs.writeFile(...args),
    rename: async () => { throw Object.assign(new Error('rename failed'), { code: 'EIO' }); },
    rm: (...args) => fs.rm(...args),
  };
  const settings = await createCommonQuestionSettings({ dataDirectory: directory, fileSystem });
  const notifications = [];
  settings.subscribe((event) => notifications.push(event));

  await assert.rejects(settings.updateSettings({ expectedRevision: settings.getStatus().revision, enabled: false }),
    { code: 'settings_write_failed' });
  assert.equal(settings.getStatus().status, 'unavailable');
  assert.equal(settings.getStatus().reason, 'settings_read_failed');
  assert.equal(settings.getAutoApplySettings().enabled, false);
  assert.equal(notifications.at(-1).status.status, 'unavailable');
});

test('subscriber failures do not fail a successful update', async (t) => {
  const directory = await tempDir(t);
  const settings = await createCommonQuestionSettings({ dataDirectory: directory });
  let notified;
  settings.subscribe((event) => { notified = event; });
  settings.subscribe(() => { throw new Error('listener failure'); });
  settings.subscribe(() => Promise.reject(new Error('async listener failure')));

  const revision = settings.getStatus().revision;
  await assert.doesNotReject(settings.updateSettings({ expectedRevision: revision, enabled: true }));
  assert.equal(notified.autoApply.enabled, true);
  assert.notEqual(notified.status.revision, revision);
  assert.equal(notified.status.status, 'ready');
  assert.equal(Object.isFrozen(notified), true);
  assert.equal(Object.isFrozen(notified.autoApply), true);
  assert.equal(Object.isFrozen(notified.status), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settings.getStatus().revision, notified.status.revision);
});

test('invalid updates are rejected without changing the snapshot', async (t) => {
  const directory = await tempDir(t);
  const settings = await createCommonQuestionSettings({ dataDirectory: directory });
  const revision = settings.getStatus().revision;
  await assert.rejects(settings.updateSettings({ expectedRevision: revision, enabled: false, minimumWaitMs: 1 }),
    { code: 'invalid_settings_update' });
  await assert.rejects(settings.updateSettings({ expectedRevision: revision, enabled: false, extra: true }),
    { code: 'invalid_settings_update' });
  assert.equal(settings.getStatus().status, 'missing');
  assert.equal(settings.getStatus().revision, revision);
  assert.deepEqual(await fs.readdir(directory), []);
});
