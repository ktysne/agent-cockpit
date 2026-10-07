'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const kernel = require('../src/server/common-question-kernel');
const { atomicWriteJson } = require('../src/server/json-storage');
const { createCommonQuestionJournal, assertCapacityReserved } = require('../src/server/common-question-journal');

async function tempDir(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'common-question-journal-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function questionRecord(id = 'q-1') {
  return kernel.createQuestionRecord({
    internalQuestionId: 'cq-test-' + id, questionId: id,
    identity: { provider: 'claude', nativeIdKind: 'session', hostId: 'host',
      homeScopeId: 'home', nativeId: 'session' },
    periodId: 'period-1', executionId: 'period-1', conversationId: 'conversation-1',
    launchRef: 'launch-1',
    executionBinding: { periodId: 'period-1', actor: { kind: 'agent', id: 'agent-1' } },
    category: 'ordinary',
    questions: [{ id: 'note', text: 'Add context', mode: 'single', options: [],
      allowFreeText: true, recommendedOptionId: null }],
    timeoutMinutes: 1, createdAt: 1_000,
  });
}

test('journal writes strict records to a real file and releases path ownership on close', async (t) => {
  const directory = await tempDir(t);
  const filePath = path.join(directory, 'questions.json');
  const journal = createCommonQuestionJournal({ filePath });
  t.after(() => journal.close());
  assert.deepEqual(await journal.load(), kernel.createEmptyJournal());
  assert.throws(() => createCommonQuestionJournal({ filePath }), { code: 'journal_path_in_use' });
  const candidate = kernel.addQuestion(kernel.createEmptyJournal(), questionRecord());
  await journal.save(candidate);
  const text = await fs.readFile(filePath, 'utf8');
  assert.equal(text.includes('writer-token-secret'), false);
  assert.deepEqual(await journal.load(), candidate);
  await journal.close();
  const reopened = createCommonQuestionJournal({ filePath });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.load(), candidate);
});

test('journal reserves room for a complete answer, cancellation, and late-answer history', async (t) => {
  const directory = await tempDir(t);
  const candidate = kernel.addQuestion(kernel.createEmptyJournal(), questionRecord());
  const reserve = assertCapacityReserved(candidate, 16 * 1024 * 1024, kernel.MAX_JOURNAL_RECORDS);
  const journal = createCommonQuestionJournal({ filePath: path.join(directory, 'questions.json'),
    maxBytes: reserve - 1 });
  t.after(() => journal.close());
  await assert.rejects(journal.save(candidate), { code: 'journal_capacity_reserved' });
  assert.equal(await fs.stat(path.join(directory, 'questions.json')).then(() => true, () => false), false);
});

test('journal read fails closed on corrupt bytes', async (t) => {
  const directory = await tempDir(t);
  const filePath = path.join(directory, 'questions.json');
  await fs.writeFile(filePath, '{broken');
  const journal = createCommonQuestionJournal({ filePath });
  t.after(() => journal.close());
  await assert.rejects(journal.load(), { code: 'invalid_journal_json' });
});

test('journal refuses a serialized value beyond the configured byte cap', async (t) => {
  const directory = await tempDir(t);
  const filePath = path.join(directory, 'questions.json');
  const candidate = kernel.addQuestion(kernel.createEmptyJournal(), questionRecord());
  const actualSize = Buffer.byteLength(JSON.stringify(candidate, null, 2) + '\n', 'utf8');
  const journal = createCommonQuestionJournal({ filePath, maxBytes: actualSize - 1 });
  t.after(() => journal.close());
  await assert.rejects(journal.save(candidate), { code: 'journal_capacity_reserved' });
});
test('journal stops after ambiguous writes and retains the last committed bytes', async (t) => {
  const directory = await tempDir(t);
  const filePath = path.join(directory, 'questions.json');
  let writes = 0;
  const journal = createCommonQuestionJournal({ filePath, atomicWrite: async (target, value) => {
    writes += 1;
    if (writes === 2) throw new Error('write outcome is unknown');
    return atomicWriteJson(path.dirname(target), path.basename(target), value);
  } });
  t.after(() => journal.close());
  const first = kernel.addQuestion(kernel.createEmptyJournal(), questionRecord());
  await journal.save(first);
  const committedBytes = await fs.readFile(filePath, 'utf8');
  const second = kernel.addQuestion(first, questionRecord('q-2'));
  await assert.rejects(journal.save(second), { code: 'journal_write_failed' });
  assert.equal(await fs.readFile(filePath, 'utf8'), committedBytes);
  await assert.rejects(journal.save(second), { code: 'journal_writer_blocked' });
  assert.equal(await fs.readFile(filePath, 'utf8'), committedBytes);
});

test('journal rejects invalid UTF-8 before parsing', async (t) => {
  const directory = await tempDir(t);
  const filePath = path.join(directory, 'questions.json');
  await fs.writeFile(filePath, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]));
  const journal = createCommonQuestionJournal({ filePath });
  t.after(() => journal.close());
  await assert.rejects(journal.load(), { code: 'invalid_journal_json' });
});