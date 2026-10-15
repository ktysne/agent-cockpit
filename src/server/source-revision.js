const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

/** Git の参照ファイルからチェックアウトの完全なコミット ID を読み、取得できなければ null を返す。 */
async function readSourceCommit(root = path.join(__dirname, '../..')) {
  try {
    let gitDir = path.join(root, '.git');
    if ((await fs.stat(gitDir)).isFile()) gitDir = path.resolve(root, (await fs.readFile(gitDir, 'utf8')).trim().replace(/^gitdir: /, ''));
    const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
    if (/^[a-f0-9]{40,64}$/.test(head)) return head;
    const ref = head.replace(/^ref: /, '');
    let commonDir = gitDir;
    try { commonDir = path.resolve(gitDir, (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim()); } catch {}
    try {
      const commit = (await fs.readFile(path.join(commonDir, ref), 'utf8')).trim();
      if (/^[a-f0-9]{40,64}$/.test(commit)) return commit;
    } catch {}
    const packed = await fs.readFile(path.join(commonDir, 'packed-refs'), 'utf8');
    const commit = packed.split('\n').find(line => line.endsWith(` ${ref}`))?.split(' ')[0];
    return /^[a-f0-9]{40,64}$/.test(commit) ? commit : null;
  } catch { return null; }
}

/** チェックアウトの追跡ファイルとリリースタグからソースの状態を一度だけ判定する。 */
async function readSourceState({ root, version, commit, execFileImpl = execFile }) {
  try {
    if (!commit) return 'unknown';
    const run = args => new Promise(resolve => {
      try {
        execFileImpl('git', args, {
          cwd: root, windowsHide: true, timeout: 5000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        }, (error, stdout) => resolve(error ? null : String(stdout).trim()));
      } catch { resolve(null); }
    });
    const [tag, status] = await Promise.all([
      run(['rev-parse', '--verify', '--quiet', `refs/tags/v${version}^{commit}`]),
      // 利用者の git 操作と index.lock で競合しないよう、索引の書き戻しをしない。
      run(['--no-optional-locks', 'status', '--porcelain', '--untracked-files=no']),
    ]);
    if (status) return 'dirty';
    if (status === null || !tag) return 'unknown';
    return tag === commit ? 'release' : 'diverged';
  } catch { return 'unknown'; }
}

module.exports = { readSourceCommit, readSourceState };
