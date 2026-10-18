const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DashboardState } = require('../src/server/state');
const { jsonBody, request, startTestServer, uiHeaders } = require('./support/server');

test('Codex の状態推定要求は Claude の記録を読まず結果も保存しない', async (t) => {
  const state = new DashboardState();
  const { claudeHome, homeDir, info } = await startTestServer(t, { state });
  const sessionId = 'estimate_codex';
  const cwd = path.join(homeDir, 'workspace', 'project');
  state.syncSessionFiles([{ session_id: sessionId, provider: 'codex', cwd }]);
  const projectDirectory = path.join(claudeHome, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(path.join(projectDirectory, `${sessionId}.jsonl`), `${JSON.stringify({
    type: 'assistant', timestamp: '2026-10-02T01:02:03.000Z', isSidechain: false,
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'transcript fixture' }] },
  })}\n`);

  const versionBeforeEstimate = state.version;
  const response = await request(info.port, {
    method: 'POST', path: `/api/sessions/${sessionId}/estimate`,
    headers: uiHeaders(info, `http://127.0.0.1:${info.port}`),
  });

  assert.equal(response.status, 422);
  assert.deepEqual(jsonBody(response), { error: 'State estimation is not supported for this provider' });
  assert.equal(state.version, versionBeforeEstimate);
  assert.equal(state.snapshot().sessions.find((session) => session.session_id === sessionId).estimate, undefined);
});
