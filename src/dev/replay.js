const { spawn } = require('node:child_process');
const path = require('node:path');

const hookPath = path.join(__dirname, '..', 'hooks', 'event.js');
const sessionId = `replay-${Date.now()}`;
const cwd = process.cwd();

const events = [
  {
    session_id: sessionId,
    hook_event_name: 'SessionStart',
    cwd,
  },
  {
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    cwd,
    tool_name: 'Bash',
    tool_use_id: 'replay-permission-tool',
    tool_input: { command: 'git push origin feature/stage1' },
  },
  {
    session_id: sessionId,
    hook_event_name: 'Notification',
    cwd,
    notification_type: 'permission_prompt',
    message: 'このコマンドの実行許可を待っています。',
  },
  {
    session_id: sessionId,
    hook_event_name: 'PostToolUse',
    cwd,
    tool_name: 'Bash',
    tool_use_id: 'replay-permission-tool',
  },
  {
    session_id: sessionId,
    hook_event_name: 'SubagentStart',
    cwd,
    agent_id: 'replay-finished-agent',
    agent_type: 'Explore',
  },
  {
    session_id: sessionId,
    hook_event_name: 'SubagentStop',
    cwd,
    agent_id: 'replay-finished-agent',
    agent_type: 'Explore',
  },
  {
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    cwd,
    tool_name: 'Bash',
    tool_use_id: 'replay-codex-tool',
    tool_input: { command: 'codex-agent.sh impl-standard' },
  },
  {
    session_id: sessionId,
    hook_event_name: 'PostToolUse',
    cwd,
    tool_name: 'Bash',
    tool_use_id: 'replay-codex-tool',
    tool_response: 'codex-agent: agent=replay-codex model=gpt-5.5-codex effort=high',
  },
  {
    session_id: sessionId,
    hook_event_name: 'SubagentStart',
    cwd,
    agent_id: 'replay-running-agent',
    agent_type: 'Explore',
  },
  {
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    cwd,
    agent_id: 'replay-running-agent',
    agent_type: 'Explore',
    tool_name: 'Read',
    tool_use_id: 'replay-read-tool',
    tool_input: { file_path: path.join(cwd, 'README.md') },
  },
  {
    session_id: sessionId,
    hook_event_name: 'Stop',
    cwd,
  },
  {
    session_id: `${sessionId}-ended`,
    hook_event_name: 'SessionStart',
    cwd,
  },
  {
    session_id: `${sessionId}-ended`,
    hook_event_name: 'SessionEnd',
    cwd,
  },
];

function sendToHook(event) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hookPath], {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let output = '';
    let errorOutput = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { errorOutput += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`hook exited with ${code}: ${errorOutput}`));
      else resolve(output.trim());
    });
    child.stdin.end(JSON.stringify(event));
  });
}

async function main() {
  for (const event of events) {
    const output = await sendToHook(event);
    if (output) process.stdout.write(`${output}\n`);
  }
  process.stdout.write(`Replayed ${events.length} events for ${sessionId}.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
