const DIAGNOSTIC_LEVEL_ORDER = ['error', 'warn', 'info', 'debug'];
const DIAGNOSTIC_SOURCE_ORDER = ['server', 'hook', 'mcp', 'web', 'gh', 'merge', 'codex'];
let diagnosticResponseRuntime = null;
let diagnosticsResponseRuntimeRequestSequence = 0;
let diagnosticsAppliedResponseRuntimeRequestSequence = 0;
let diagnosticsRefreshSequence = 0;
let diagnosticsSelectionSequence = 0;
let diagnosticsListLoading = false;
let diagnosticsAllExportPending = false;
let diagnosticDeletionGeneration = 0;
let diagnosticRuns = [];
let diagnosticDeleteScope = null;
let diagnosticDeleteRunId = null;
const diagnosticsDialog = document.getElementById('diagnostics-dialog');
const diagnosticsPolicyDialog = document.getElementById('diagnostics-policy-dialog');
const diagnosticsRunSelect = document.getElementById('diagnostics-run');
const diagnosticsSourceSelect = document.getElementById('diagnostics-source');
const diagnosticsList = document.getElementById('diagnostics-list');
const diagnosticsStatus = document.getElementById('diagnostics-status');
const diagnosticsDeleteActions = document.getElementById('diagnostics-delete-actions');
const diagnosticsDeleteConfirmation = document.getElementById('diagnostics-delete-confirmation');

displayPreferences.diagnosticsLevel = ['silent', 'error', 'warn', 'info', 'debug'].includes(displayPreferences.diagnosticsLevel) ? displayPreferences.diagnosticsLevel : 'info';

function formatRuntime(runtime) {
  if (!runtime?.version) return 'バージョン不明';
  const suffix = runtime.sourceState !== 'release' && runtime.commit ? `+${runtime.commit.slice(0, 7)}` : '';
  return `v${runtime.version}${suffix}`;
}

function diagnosticLocalTime(value, seconds = false) {
  const date = new Date(value);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}${seconds ? `:${pad(date.getSeconds())}` : ''}`;
}

function selectedDiagnosticRun() {
  return diagnosticRuns.find(run => run.id === diagnosticsRunSelect.value) || diagnosticRuns.find(run => run.current) || null;
}

function nextDiagnosticsResponseRuntimeRequestSequence() {
  diagnosticsResponseRuntimeRequestSequence += 1;
  return diagnosticsResponseRuntimeRequestSequence;
}

function applyDiagnosticResponseRuntime(responseRuntime, requestSequence) {
  if (responseRuntime === undefined || requestSequence < diagnosticsAppliedResponseRuntimeRequestSequence) return;
  diagnosticsAppliedResponseRuntimeRequestSequence = requestSequence;
  diagnosticResponseRuntime = responseRuntime;
}

function replaceSelectOptions(select, values, selectedValue) {
  select.replaceChildren(...values.map(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    return option;
  }));
  select.value = values.some(option => option.value === selectedValue) ? selectedValue : (values[0]?.value || '');
}

function refreshDiagnosticOptions() {
  const previousRun = diagnosticsRunSelect.value;
  const runs = [...diagnosticRuns].sort((a, b) => Number(b.current) - Number(a.current) || Date.parse(b.startedAt) - Date.parse(a.startedAt));
  replaceSelectOptions(diagnosticsRunSelect, runs.map(run => ({
    value: run.id,
    label: `${run.current ? `現在の起動 (${diagnosticLocalTime(run.startedAt)})` : diagnosticLocalTime(run.startedAt)} ${formatRuntime(run.runtime)}`,
  })), previousRun || runs.find(run => run.current)?.id);
  const previousSource = diagnosticsSourceSelect.value;
  const knownSources = new Set(diagnosticRuns.flatMap(run => run.sources || []));
  const sources = DIAGNOSTIC_SOURCE_ORDER.filter(source => knownSources.has(source));
  replaceSelectOptions(diagnosticsSourceSelect, [
    { value: '', label: 'すべて' },
    ...sources.map(source => ({ value: source, label: source })),
  ], previousSource);
}

function filteredDiagnosticEntries(run = selectedDiagnosticRun()) {
  if (!run || !Array.isArray(run.entries) || diagnosticsLevelSelect.value === 'silent') return [];
  const levelLimit = DIAGNOSTIC_LEVEL_ORDER.indexOf(diagnosticsLevelSelect.value);
  return run.entries.filter(entry => {
    const levelVisible = entry.level === 'mark' || entry.level === 'error'
      || DIAGNOSTIC_LEVEL_ORDER.indexOf(entry.level) <= levelLimit;
    return levelVisible && (!diagnosticsSourceSelect.value || entry.tag === diagnosticsSourceSelect.value);
  }).sort((a, b) => a.ts - b.ts);
}

function formatDiagnosticEntry(entry) {
  const data = entry.data && Object.keys(entry.data).length ? ` ${JSON.stringify(entry.data)}` : '';
  return `${diagnosticLocalTime(entry.ts, true)} [${entry.level}] [${entry.tag}] ${entry.msg}${data}`;
}

function renderDiagnosticEntries() {
  const run = selectedDiagnosticRun();
  if (!run || !Array.isArray(run.entries)) {
    diagnosticsList.textContent = '';
    return;
  }
  diagnosticsList.textContent = filteredDiagnosticEntries(run).map(formatDiagnosticEntry).join('\n') || '(記録はまだありません)';
}

async function refreshDiagnostics() {
  const sequence = ++diagnosticsRefreshSequence;
  const responseRuntimeRequestSequence = nextDiagnosticsResponseRuntimeRequestSequence();
  diagnosticsSelectionSequence += 1;
  diagnosticsListLoading = true;
  diagnosticsStatus.textContent = '記録を読み込んでいます。';
  diagnosticsList.setAttribute('aria-busy', 'true');
  try {
    const response = await fetchUi('/api/diagnostics', { cache: 'no-store' });
    if (!response.ok) throw new Error('Cannot read diagnostics');
    const data = await response.json();
    if (sequence !== diagnosticsRefreshSequence) return;
    diagnosticRuns = data.runs.map(run => ({ ...run, entries: undefined, loadError: false }));
    applyDiagnosticResponseRuntime(data.responseRuntime, responseRuntimeRequestSequence);
    refreshDiagnosticOptions();
    diagnosticsLevelSelect.value = displayPreferences.diagnosticsLevel;
    diagnosticsListLoading = false;
    const selectionSequence = ++diagnosticsSelectionSequence;
    await loadSelectedDiagnosticRun(selectedDiagnosticRun(), selectionSequence);
    return true;
  } catch {
    if (sequence !== diagnosticsRefreshSequence) return;
    diagnosticsListLoading = false;
    diagnosticsStatus.textContent = '診断ログを読み込めませんでした。「更新」でやり直してください。';
    diagnosticsList.setAttribute('aria-busy', 'false');
    renderDiagnosticEntries();
    return false;
  }
}

async function loadSelectedDiagnosticRun(run, sequence) {
  if (!run) {
    if (sequence === diagnosticsSelectionSequence && !diagnosticsListLoading) {
      diagnosticsStatus.textContent = '';
      diagnosticsList.textContent = '(記録はまだありません)';
      diagnosticsList.setAttribute('aria-busy', 'false');
    }
    return true;
  }
  if (Array.isArray(run.entries)) {
    if (sequence === diagnosticsSelectionSequence && !diagnosticsListLoading) {
      diagnosticsStatus.textContent = '';
      renderDiagnosticEntries();
      diagnosticsList.setAttribute('aria-busy', 'false');
    }
    return true;
  }
  if (sequence !== diagnosticsSelectionSequence || diagnosticsListLoading || selectedDiagnosticRun()?.id !== run.id) return false;
  if (!diagnosticsAllExportPending) diagnosticsStatus.textContent = '記録を読み込んでいます。';
  diagnosticsList.setAttribute('aria-busy', 'true');
  renderDiagnosticEntries();
  try {
    const responseRuntimeRequestSequence = nextDiagnosticsResponseRuntimeRequestSequence();
    const data = await loadDiagnosticRun(run.id);
    if (sequence !== diagnosticsSelectionSequence || diagnosticsListLoading || selectedDiagnosticRun()?.id !== run.id) return false;
    applyDiagnosticResponseRuntime(data.responseRuntime, responseRuntimeRequestSequence);
    run.runtime = withLoadedRuntime(run, data).runtime;
    run.entries = data.entries;
    run.loadError = false;
    if (!diagnosticsAllExportPending) diagnosticsStatus.textContent = '';
    renderDiagnosticEntries();
    diagnosticsList.setAttribute('aria-busy', 'false');
    return true;
  } catch {
    if (sequence !== diagnosticsSelectionSequence || diagnosticsListLoading || selectedDiagnosticRun()?.id !== run.id) return false;
    run.loadError = true;
    if (!diagnosticsAllExportPending) diagnosticsStatus.textContent = '選んだ起動の記録を読み込めませんでした。「更新」でやり直してください。';
    renderDiagnosticEntries();
    diagnosticsList.setAttribute('aria-busy', 'false');
    return false;
  }
}

function openDiagnostics() {
  diagnosticsLevelSelect.value = displayPreferences.diagnosticsLevel;
  diagnosticsStatus.textContent = '';
  diagnosticDeleteScope = null;
  diagnosticDeleteRunId = null;
  diagnosticsRunSelect.disabled = false;
  diagnosticsDeleteActions.hidden = false;
  diagnosticsDeleteConfirmation.hidden = true;
  refreshDiagnostics();
  if (!diagnosticsDialog.open) diagnosticsDialog.showModal();
}

document.getElementById('diagnostics-open').addEventListener('click', event => {
  event.preventDefault();
  openDiagnostics();
});
document.getElementById('diagnostics-close').addEventListener('click', () => diagnosticsDialog.close());
document.getElementById('diagnostics-policy-open').addEventListener('click', () => {
  if (!diagnosticsPolicyDialog.open) diagnosticsPolicyDialog.showModal();
});
document.getElementById('diagnostics-policy-close').addEventListener('click', () => diagnosticsPolicyDialog.close());
diagnosticsLevelSelect.addEventListener('change', async () => {
  const saved = await saveDisplayPreferences({ diagnosticsLevel: diagnosticsLevelSelect.value }, { key: 'diagnosticsLevel', input: diagnosticsLevelSelect });
  diagnosticsStatus.textContent = saved ? 'レベルを保存しました。' : 'レベルを保存できませんでした。';
  renderDiagnosticEntries();
});
diagnosticsRunSelect.addEventListener('change', () => {
  const sequence = ++diagnosticsSelectionSequence;
  if (diagnosticsListLoading) return;
  return loadSelectedDiagnosticRun(selectedDiagnosticRun(), sequence);
});
diagnosticsSourceSelect.addEventListener('change', renderDiagnosticEntries);
document.getElementById('diagnostics-refresh').addEventListener('click', refreshDiagnostics);

for (const dialog of [diagnosticsDialog, diagnosticsPolicyDialog]) {
  dialog.addEventListener('click', event => {
    const box = dialog.getBoundingClientRect();
    const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    if (event.target === dialog && outside) dialog.close();
  });
}

async function copyDiagnosticText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  const fallback = document.createElement('textarea');
  fallback.value = text;
  fallback.setAttribute('aria-hidden', 'true');
  fallback.style.position = 'fixed';
  fallback.style.opacity = '0';
  // モーダルの表示中はダイアログの外が inert になり、外の要素を選択できないため。
  diagnosticsDialog.append(fallback);
  fallback.select();
  const copied = document.execCommand?.('copy') || false;
  fallback.remove();
  return copied;
}

function diagnosticExportText(runs, responseRuntime) {
  const runLabel = runs.length === 1 ? runs[0].id : 'all';
  const lines = [
    '# agent-cockpit 診断ログ',
    `# viewer=${formatRuntime(responseRuntime)} level=${displayPreferences.diagnosticsLevel} run=${runLabel} exported=${diagnosticLocalTime(Date.now(), true)}`,
    '',
  ];
  for (const run of runs) {
    lines.push(`## 起動 ${run.id} (${diagnosticLocalTime(run.startedAt)}) ${formatRuntime(run.runtime)}${run.runtime ? ` commit=${run.runtime.commit || 'unknown'} state=${run.runtime.sourceState}` : ''}`);
    const entries = [...run.entries].sort((a, b) => a.ts - b.ts);
    lines.push(entries.map(formatDiagnosticEntry).join('\n') || '(記録はまだありません)', '');
  }
  return lines.join('\n');
}

function downloadDiagnosticText(runs, suffix, responseRuntime) {
  const blob = new Blob([diagnosticExportText(runs, responseRuntime)], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `agent-cockpit-diagnostics-${suffix}.txt`;
  diagnosticsDialog.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

document.getElementById('diagnostics-copy').addEventListener('click', async () => {
  const run = selectedDiagnosticRun();
  if (!Array.isArray(run?.entries)) {
    diagnosticsStatus.textContent = run?.loadError
      ? '選んだ起動の記録を読み込めませんでした。「更新」でやり直してください。'
      : '選んだ起動の記録を読み込んでいます。完了後にもう一度お試しください。';
    return;
  }
  const runId = run.id;
  const copied = await copyDiagnosticText(filteredDiagnosticEntries().map(formatDiagnosticEntry).join('\n'));
  if (selectedDiagnosticRun()?.id !== runId) return;
  document.getElementById('diagnostics-copy').focus();
  diagnosticsStatus.textContent = copied ? '表示中の記録をコピーしました。' : 'コピーできませんでした。';
});
document.getElementById('diagnostics-export-run').addEventListener('click', () => {
  const run = selectedDiagnosticRun();
  if (!Array.isArray(run?.entries)) {
    diagnosticsStatus.textContent = run?.loadError
      ? '選んだ起動の記録を読み込めませんでした。「更新」でやり直してください。'
      : '選んだ起動の記録を読み込んでいます。完了後にもう一度お試しください。';
    return;
  }
  downloadDiagnosticText([run], run.id, diagnosticResponseRuntime);
  diagnosticsStatus.textContent = '選んだ起動を書き出しました。';
});
document.getElementById('diagnostics-export-all').addEventListener('click', async event => {
  const button = event.currentTarget;
  if (button.disabled) return;
  button.disabled = true;
  diagnosticsAllExportPending = true;
  diagnosticsStatus.textContent = 'すべての起動の記録を読み込んでいます。';
  const runs = [...diagnosticRuns].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const deletionGeneration = diagnosticDeletionGeneration;
  let exportResponseRuntime = diagnosticResponseRuntime;
  try {
    const loadedRuns = [];
    for (const run of runs) {
      const data = await loadDiagnosticRun(run.id);
      if (data.responseRuntime !== undefined) exportResponseRuntime = data.responseRuntime;
      loadedRuns.push({ ...withLoadedRuntime(run, data), entries: data.entries });
    }
    // 取得の途中で削除が終わると、取得済みの分に削除した記録が残るため、書き出さない。
    if (deletionGeneration !== diagnosticDeletionGeneration) {
      diagnosticsStatus.textContent = '書き出しの途中で記録を削除したため、書き出しを取りやめました。もう一度「すべての起動を書き出す」を押してください。';
      return;
    }
    downloadDiagnosticText(loadedRuns, 'all', exportResponseRuntime);
    diagnosticsStatus.textContent = 'すべての起動を書き出しました。';
  } catch {
    diagnosticsStatus.textContent = 'すべての起動を書き出せませんでした。記録を読み込めない起動があります。「更新」でやり直してください。';
  } finally {
    diagnosticsAllExportPending = false;
    button.disabled = false;
  }
});

function beginDiagnosticDeletion(scope) {
  diagnosticDeleteScope = scope;
  const selected = selectedDiagnosticRun();
  diagnosticDeleteRunId = scope === 'run' ? selected?.id : null;
  const targetCount = scope === 'all'
    ? diagnosticRuns.reduce((total, run) => total + run.count, 0)
    : (selected?.entries?.length ?? selected?.count ?? 0);
  const targetName = scope === 'all' ? 'すべての起動の' : '選んだ起動の';
  document.getElementById('diagnostics-delete-message').textContent = `${targetName} ${targetCount} 件の記録を削除します。元に戻せません`;
  diagnosticsRunSelect.disabled = true;
  diagnosticsDeleteActions.hidden = true;
  diagnosticsDeleteConfirmation.hidden = false;
  document.getElementById('diagnostics-delete-confirm').focus();
}

document.getElementById('diagnostics-delete-run').addEventListener('click', () => beginDiagnosticDeletion('run'));
document.getElementById('diagnostics-delete-all').addEventListener('click', () => beginDiagnosticDeletion('all'));
document.getElementById('diagnostics-delete-cancel').addEventListener('click', () => {
  diagnosticDeleteScope = null;
  diagnosticDeleteRunId = null;
  diagnosticsRunSelect.disabled = false;
  diagnosticsDeleteConfirmation.hidden = true;
  diagnosticsDeleteActions.hidden = false;
  document.getElementById('diagnostics-delete-run').focus();
});
document.getElementById('diagnostics-delete-confirm').addEventListener('click', async () => {
  const confirmButton = document.getElementById('diagnostics-delete-confirm');
  // 応答を待つ間に「やめる」で対象が消えても、送った範囲を手元から外すため、先に取っておく。
  const scope = diagnosticDeleteScope;
  const runId = diagnosticDeleteRunId;
  confirmButton.disabled = true;
  try {
    const response = await postUiAction('/api/diagnostics/delete', scope === 'all' ? { all: true } : { run: runId });
    if (!response.ok) throw new Error('Cannot delete diagnostics');
  } catch {
    diagnosticsStatus.textContent = '記録を削除できませんでした。もう一度「削除する」を押してください。';
    return;
  } finally { confirmButton.disabled = false; }
  // 再取得に失敗しても、削除した記録をコピーや書き出しの対象に残さないため、先に手元から外す。
  diagnosticDeletionGeneration += 1;
  diagnosticRuns =scope === 'all' ? [] : diagnosticRuns.filter(run => run.id !== runId);
  refreshDiagnosticOptions();
  diagnosticDeleteScope = null;
  diagnosticDeleteRunId = null;
  diagnosticsRunSelect.disabled = false;
  diagnosticsDeleteConfirmation.hidden = true;
  diagnosticsDeleteActions.hidden = false;
  const refreshed = await refreshDiagnostics();
  if (!refreshed) diagnosticsStatus.textContent = '記録を削除しましたが、一覧を読み込めませんでした。「更新」でやり直してください。';
  else if (!selectedDiagnosticRun()?.loadError) diagnosticsStatus.textContent = '記録を削除しました。';
  document.getElementById('diagnostics-delete-run').focus();
});


async function loadDiagnosticRun(run) {
  const response = await fetchUi('/api/diagnostics?run=' + encodeURIComponent(run), { cache: 'no-store' });
  if (!response.ok) throw new Error('Cannot read diagnostics');
  return response.json();
}

// 一覧の取得後にソースの状態が確定することがあるため、起動ごとの取得で版を差し替える。
function withLoadedRuntime(run, data) {
  return data.runtime !== undefined ? { ...run, runtime: data.runtime } : run;
}

