// Codex のフック入力の形を記録する検証用のフック。引数は記録先のディレクトリ。
// 会話の本文とツールの入出力は値を残さず、型と長さだけにする。識別子と状態を表す項目だけは値を残す。
const fs = require('node:fs');
const path = require('node:path');

const KEEP_VALUES = new Set([
  'hook_event_name', 'session_id', 'agent_id', 'agent_type', 'turn_id', 'tool_use_id', 'tool_name',
  'source', 'reason', 'trigger', 'permission_mode', 'model', 'stop_hook_active', 'cwd', 'transcript_path',
]);
const MAX_DEPTH = 2;

function shape(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return depth > MAX_DEPTH ? `array(${value.length})` : { array: value.length, first: value.length ? shape(value[0], depth + 1) : null };
  if (typeof value === 'object') {
    if (depth > MAX_DEPTH) return `object(${Object.keys(value).length})`;
    return Object.fromEntries(Object.keys(value).map((key) => [key, shape(value[key], depth + 1)]));
  }
  if (typeof value === 'string') return `string(${value.length})`;
  return typeof value;
}

function record(input, outDir) {
  const entry = { at: new Date().toISOString(), ppid: process.ppid };
  if (input && typeof input === 'object') {
    entry.values = Object.fromEntries(Object.keys(input).filter((key) => KEEP_VALUES.has(key)).map((key) => [key, input[key]]));
    entry.shape = shape(input);
  }
  entry.env = Object.keys(process.env).filter((key) => /^(CODEX|CLAUDE)/i.test(key)).sort();
  fs.mkdirSync(outDir, { recursive: true });
  fs.appendFileSync(path.join(outDir, 'hooks.jsonl'), `${JSON.stringify(entry)}\n`);
}

let text = '';
process.stdin.on('data', (chunk) => { text += chunk; });
process.stdin.on('end', () => {
  let input = null;
  try { input = JSON.parse(text); } catch {}
  record(input, process.argv[2] || path.join(__dirname, 'out'));
  // Stop と SubagentStop は、終了コード 0 のとき JSON の出力を求める。
  if (input?.hook_event_name === 'Stop' || input?.hook_event_name === 'SubagentStop') process.stdout.write('{}\n');
});
