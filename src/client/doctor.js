const { observe } = require('./doctor-observe');
const { evaluate } = require('./doctor-evaluate');

async function diagnose(options = {}) {
  return evaluate(await observe(options));
}

function formatReport(report) {
  return [['ok', '確認できたこと'], ['mismatch', '不一致'], ['unverified', '未確認'], ['not-installed', '未導入・対象外'], ['not-run', '未実施']]
    .map(([result, title]) => [title, ...report.items.filter(item => item.result === result).flatMap(item => [
      `- ${item.id}: ${item.reason}`, ...(['mismatch', 'not-installed'].includes(result) ? item.actions.map(action => `  対処: ${action.op === 'manual' ? action.text
        : ['copy', 'copy-file'].includes(action.op) ? `${action.from} を ${action.to} へコピーします。`
          : action.op === 'write' ? `${action.to} を照会が返した内容で置き直します。`
          : action.op === 'command' ? `${action.cwd} で ${action.command} を実行します。`
            : `${action.file} の ${action.path?.join('.') || `${action.table}.${action.key}`} を ${action.op} で直します。`}`) : []),
    ])].join('\n')).join('\n\n');
}

async function main(argv = process.argv.slice(2), options = {}) {
  const log = options.log || console.log;
  const logError = options.logError || console.error;
  try {
    let root = options.root;
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index] === '--json') continue;
      if (argv[index] === '--root' && argv[index + 1] && !argv[index + 1].startsWith('--')) root = argv[++index];
      else throw new Error('使い方: node src/client/doctor.js [--json] [--root <checkout>]');
    }
    const report = await diagnose({ ...options, root });
    log(argv.includes('--json') ? JSON.stringify(report) : formatReport(report));
    return report.summary.mismatch ? 1 : 0;
  } catch {
    const reason = '診断を完了できませんでした。引数と対象の checkout の package.json を確認してください。';
    if (argv.includes('--json')) log(JSON.stringify({ schemaVersion: 1, error: reason }));
    else logError(reason);
    return 2;
  }
}

if (require.main === module) main().then(code => { process.exitCode = code; });

module.exports = { diagnose, main };
