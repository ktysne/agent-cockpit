const test = require('node:test');
const assert = require('node:assert/strict');
const { temporaryDirectory } = require('./support/temp');

test('一時ディレクトリの環境変数は登録順の後片付けでも元へ戻す', async () => {
  const name = 'AGENT_COCKPIT_TEST_NESTED_ENVIRONMENT';
  const previousValue = process.env[name];
  const cleanups = [];
  const testContext = { after: (cleanup) => cleanups.push(cleanup) };

  temporaryDirectory(testContext, 'agent-cockpit-temp-outer-', { environment: { [name]: 'outer' } });
  temporaryDirectory(testContext, 'agent-cockpit-temp-inner-', { environment: { [name]: 'inner' } });

  try {
    assert.equal(process.env[name], 'inner');
    await cleanups[0]();
    assert.equal(process.env[name], 'inner');
    await cleanups[1]();
    assert.equal(process.env[name], previousValue);

    temporaryDirectory(testContext, 'agent-cockpit-temp-same-outer-', { environment: { [name]: 'same' } });
    temporaryDirectory(testContext, 'agent-cockpit-temp-same-inner-', { environment: { [name]: 'same' } });
    assert.equal(process.env[name], 'same');
    await cleanups[2]();
    assert.equal(process.env[name], 'same');
    await cleanups[3]();
    assert.equal(process.env[name], previousValue);
  } finally {
    for (const cleanup of cleanups) await cleanup();
  }
});
