const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { childEnvironment } = require('../../client/server-connection');
const { jsonResponse } = require('../http-helpers');

function createServerRestart(ctx, options) {
  let startedAt = null;
  const now = options?.now || Date.now;
  const inProgress = () => startedAt !== null && now() - startedAt < 60_000;
  const enabled = Boolean(options) && !ctx.dev;
  const restartAvailable = () => enabled && !inProgress();

  async function handleServerRestart({ request, response, info, body }) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      jsonResponse(response, 400, { error: 'Invalid restart' });
      return;
    }
    const error = !enabled ? 'Restart unavailable' : inProgress() ? 'Restart in progress'
      : !ctx.restartRequired() ? 'Restart not required' : null;
    if (error) {
      jsonResponse(response, 409, { error });
      return;
    }
    startedAt = now();
    let log;
    try {
      await Promise.all([ctx.state.flushPersistence(), ctx.away.flushPersistence(), ctx.routing.flush()]);
      await ctx.diagnostics.flush();
      log = await fs.open(path.join(ctx.homeDir, 'server.log'), 'a');
      const child = (options.spawnImpl || spawn)(process.execPath, [
        path.resolve(__dirname, '../../client/restart-server.js'), '--json',
        '--expect-pid', String(info.pid), '--expect-started-at', info.startedAt,
      ], {
        detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd], cwd: ctx.homeDir,
        env: { ...childEnvironment(process.env), AGENT_COCKPIT_HOME: ctx.homeDir, AGENT_COCKPIT_PORT: String(info.port) },
      });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      jsonResponse(response, 202, { restarting: true });
    } catch (error) {
      startedAt = null;
      request.setDiagnosticError?.(error);
      jsonResponse(response, 500, { error: 'Cannot restart server' });
    } finally {
      await log?.close();
    }
  }

  return { restartAvailable, handleServerRestart };
}

module.exports = { createServerRestart };
