// PoC: ダッシュボードの回答をセッションへ届ける 3 つの経路を確かめる。
// 回答は poc/out/ に置いたファイルで代わりに渡し、呼ばれた記録を poc/out/answer-proto.log に残す。
//   ask    PreToolUse(AskUserQuestion): answer.json を待ち、allow と updatedInput で答える
//   batch  PostToolBatch: inject.txt があれば additionalContext で差し込む
//   rewake Stop(asyncRewake): wake.txt を待ち、終了コード 2 で起こす
const fs = require('fs');
const path = require('path');

const mode = process.argv[2];
const outDir = path.join(__dirname, 'out');
const POLL_INTERVAL_MS = 1000;
const ASK_WAIT_MS = 90_000;
const REWAKE_WAIT_MS = 240_000;

function log(entry) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.appendFileSync(path.join(outDir, 'answer-proto.log'), `${JSON.stringify({ at: new Date().toISOString(), mode, ...entry })}\n`);
}

// 読んだファイルは消し、同じ回答を 2 度使わない。
function takeFile(name) {
  const filePath = path.join(outDir, name);
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    fs.unlinkSync(filePath);
    return text;
  } catch {
    return null;
  }
}

async function waitForFile(name, waitMs) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const text = takeFile(name);
    if (text !== null) return text;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
}

async function main(input) {
  log({ event: input.hook_event_name, session_id: input.session_id, tool_name: input.tool_name, fields: Object.keys(input) });

  if (mode === 'ask') {
    const questions = input.tool_input?.questions || [];
    log({ step: 'waiting', questions: questions.map((question) => question.question) });
    const text = await waitForFile('answer.json', ASK_WAIT_MS);
    if (text === null) {
      log({ step: 'timeout' });
      return;
    }
    // answer.json の形: {"answers": {"質問の文": "選んだ選択肢の label"}}
    const { answers } = JSON.parse(text);
    log({ step: 'answered', answers });
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...input.tool_input, answers },
      },
    }));
    return;
  }

  if (mode === 'batch') {
    const text = takeFile('inject.txt');
    log({ step: text === null ? 'nothing' : 'injected', tools: (input.tool_calls || []).map((call) => call.tool_name) });
    if (text !== null) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: text } }));
    }
    return;
  }

  if (mode === 'rewake') {
    log({ step: 'waiting' });
    const text = await waitForFile('wake.txt', REWAKE_WAIT_MS);
    if (text === null) {
      log({ step: 'timeout' });
      return;
    }
    log({ step: 'woke' });
    process.stderr.write(text);
    process.exitCode = 2;
  }
}

let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    log({ step: 'bad-input' });
  }
  main(input).catch((error) => log({ step: 'error', message: String(error && error.message) }));
});
