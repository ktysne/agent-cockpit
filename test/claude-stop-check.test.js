const test = require('node:test');
const assert = require('node:assert/strict');
const { runAnswerHook } = require('../src/hooks/answer');
const { startTestServer } = require('./support/server');

test('非対話 Claude の Stop は通知がなければ回答を待たずに終了する', { timeout: 5_000 }, async (t) => {
  const c = await startTestServer(t);
  const result = await runAnswerHook({ session_id: 'print-session', hook_event_name: 'Stop' }, {
    homeDir: c.homeDir, noninteractive: true,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stderrText, null);
});

test('非対話 Claude の Stop は到着済み通知を返し次の Stop では終了する', { timeout: 5_000 }, async (t) => {
  const c = await startTestServer(t);
  c.runtime.answerDelivery.notifySessions(['print-session'], 'PR の確認が完了しました。');
  const input = { session_id: 'print-session', hook_event_name: 'Stop' };
  const options = { homeDir: c.homeDir, noninteractive: true };

  const delivered = await runAnswerHook(input, options);
  assert.equal(delivered.exitCode, 2);
  assert.match(delivered.stderrText, /PR の確認が完了しました。/);
  const finished = await runAnswerHook(input, options);
  assert.equal(finished.exitCode, 0);
  assert.equal(finished.stderrText, null);
});
