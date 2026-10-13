const fs = require('node:fs');
const path = require('node:path');
const { sanitizeClientEntry, recordClientEntries } = require('./diagnostic-events');
const MAX_HOOK_PENDING_BYTES = 256 * 1024;
const PENDING_LOCK_TIMEOUT_MS = 50;
const EMPTY_LOCK_STALE_MS = 10_000;

async function withPendingLock(homeDir, operation, recoverStale = false) {
  const directory = path.join(homeDir, 'diagnostics');
  const lock = path.join(directory, 'hooks-pending.lock');
  const deadline = Date.now() + PENDING_LOCK_TIMEOUT_MS;
  try { fs.mkdirSync(directory, { recursive: true }); } catch { return; }
  while (true) {
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) return;
      if (recoverStale) try {
        const pid = Number(fs.readFileSync(lock, 'utf8'));
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (error) { if (error.code === 'ESRCH') { fs.unlinkSync(lock); continue; } }
        } else if (Date.now() - fs.statSync(lock).mtimeMs > EMPTY_LOCK_STALE_MS) { fs.unlinkSync(lock); continue; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 1));
      continue;
    }
    try { fs.writeFileSync(fd, String(process.pid)); return operation(path.join(directory, 'hooks-pending.jsonl')); }
    catch {} finally { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(lock); } catch {} }
    return;
  }
}

async function appendPendingHook(homeDir, entry) {
  const clean = sanitizeClientEntry(entry, 'hook');
  if (!clean) return;
  await withPendingLock(homeDir, file => {
    let size = 0;
    try { size = fs.statSync(file).size; } catch (error) { if (error.code !== 'ENOENT') return; }
    const line = `${JSON.stringify(clean)}\n`;
    if (size + Buffer.byteLength(line) > MAX_HOOK_PENDING_BYTES) return;
    fs.appendFileSync(file, line, { mode: 0o600 });
  });
}

async function importPendingHooks(homeDir, diagnostics) {
  await withPendingLock(homeDir, file => {
    const claimed = `${file}.importing`;
    // 追記側も同じロックを持つため、移動したファイルへの遅れた追記は起きない。
    if (!fs.existsSync(claimed)) {
      if (!fs.existsSync(file)) return;
      fs.renameSync(file, claimed);
    }
    const text = fs.readFileSync(claimed, 'utf8');
    for (const line of text.split('\n')) {
      try { recordClientEntries(diagnostics, [JSON.parse(line)], 'hook'); } catch {}
    }
    fs.unlinkSync(claimed);
  }, true);
}

module.exports = { appendPendingHook, importPendingHooks, MAX_HOOK_PENDING_BYTES };
