'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

// コミットの日時を固定し、撮るたびに SHA が変わらないようにする。各コミットは 1 分ずつ後の時刻にする。
const START_UNIX_SECONDS = Date.UTC(2026, 9, 6, 5, 0, 0) / 1000;
const IDENTITY = ['-c', 'user.name=Agent Cockpit Manual', '-c', 'user.email=manual@example.invalid'];

function lines(...rows) {
  return `${rows.join('\n')}\n`;
}

function dateAt(minute) {
  return `${START_UNIX_SECONDS + minute * 60} +0000`;
}

function gitRunner(root, configPath) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: configPath, GIT_CONFIG_NOSYSTEM: '1' };
  return (args, { at = null, allowConflict = false } = {}) => new Promise((resolve, reject) => {
    const environment = at === null ? env : { ...env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
    execFile('git', ['-C', root, ...IDENTITY, ...args], { env: environment, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      // 競合でマージが止まったときは終了コード 1 になるため、呼び出し側が許したときだけ通す。
      if (error && !(allowConflict && error.code === 1)) reject(new Error(`git ${args.join(' ')} に失敗しました: ${stderr || error.message}`));
      else resolve(stdout.trim());
    });
  });
}

async function writeFiles(root, files) {
  for (const [file, contents] of Object.entries(files)) {
    const filePath = path.join(root, file);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, contents);
  }
}

async function commit(git, root, files, message, minute) {
  await writeFiles(root, files);
  await git(['add', '--all']);
  await git(['commit', '--quiet', '--no-verify', '-m', message], { at: dateAt(minute) });
  return git(['rev-parse', 'HEAD']);
}

async function mergeClean(git, sha, message, minute) {
  await git(['merge', '--no-ff', '--no-edit', '-m', message, sha], { at: dateAt(minute) });
  return git(['rev-parse', 'HEAD']);
}

// 競合を手で解消したマージを作る。解消の内容がそのまま remerge-diff の数になるため、撮影の数字もここで決まる。
async function mergeResolved(git, root, sha, resolution, message, minute) {
  await git(['merge', '--no-ff', '--no-commit', sha], { allowConflict: true });
  const unmerged = (await git(['diff', '--name-only', '--diff-filter=U'])).split(/\r?\n/).filter(Boolean).sort();
  const expected = Object.keys(resolution).sort();
  if (unmerged.join('\n') !== expected.join('\n')) throw new Error(`競合の対象が想定と違います: ${unmerged.join(', ')}`);
  await writeFiles(root, resolution);
  await git(['add', '--all']);
  await git(['commit', '--quiet', '--no-verify', '-m', message], { at: dateAt(minute) });
  return git(['rev-parse', 'HEAD']);
}

const RENDER_STAFF = [
  'export function renderStaff(lines: string[]): string {',
  "  return lines.join('\\n');",
  '}',
];
const STAFF_HEADER = [
  'export function staffHeader(beats: number, unit: number): string {',
  '  return `${beats}/${unit}`;',
  '}',
];
const BAR_LINES = [
  'export function barLines(bars: number): string {',
  "  return '|'.repeat(bars + 1);",
  '}',
];
const METER_TYPE = ['export type Meter = { beats: number; unit: number };'];
const DEFAULT_METER_TYPED = ['export const defaultMeter: Meter = { beats: 4, unit: 4 };'];
const WITH_BEATS = [
  'export function withBeats(meter: Meter, beats: number): Meter {',
  '  return { ...meter, beats };',
  '}',
];
const BEATS_LABEL = [
  'export function beatsLabel(meter: Meter): string {',
  '  return `${meter.beats}拍`;',
  '}',
];
const MEASURE_WIDTH = [
  'export function measureWidth(beats: number): number {',
  '  return beats * 12;',
  '}',
];
const FORMAT_PLAIN = [
  'export function formatMeter(beats: number, unit: number): string {',
  '  return `${beats}/${unit}`;',
  '}',
];
const FORMAT_SPACED = [
  'export function formatMeter(beats: number, unit: number): string {',
  '  return `${beats} / ${unit}`;',
  '}',
];
const FORMAT_UNIT_FIRST = [
  'export function formatMeter(beats: number, unit: number): string {',
  '  return `${unit}分の${beats}`;',
  '}',
];
const PARSE_INPUT = [
  'export function parseMeterInput(text: string): { beats: number; unit: number } | null {',
  '  const match = /^(\\d+)\\/(\\d+)$/.exec(text.trim());',
  '  return match ? { beats: Number(match[1]), unit: Number(match[2]) } : null;',
  '}',
];

// 競合の解消の内容は、remerge-diff が「3 ファイル、+42 −17」になるように定めてある。変えると確認欄の数字も変わる。
const CONFLICT_RESOLUTION = {
  'src/score/meter.ts': lines(
    ...METER_TYPE, '', ...DEFAULT_METER_TYPED, '',
    'export function assertMeter(meter: Meter): void {',
    '  if (!Number.isInteger(meter.beats) || meter.beats < 1) throw new RangeError(`拍数が不正です: ${meter.beats}`);',
    '  if (![1, 2, 4, 8, 16].includes(meter.unit)) throw new RangeError(`拍の単位が不正です: ${meter.unit}`);',
    '}',
    '',
    'export function withBeatCount(meter: Meter, beats: number): Meter {',
    '  const next = { ...meter, beats };',
    '  assertMeter(next);',
    '  return next;',
    '}',
    '',
    'export function beatsText(meter: Meter): string {',
    '  return `${meter.beats} 拍`;',
    '}',
    '',
    'export function sameMeter(left: Meter, right: Meter): boolean {',
    '  return left.beats === right.beats && left.unit === right.unit;',
    '}',
  ),
  'src/score/render.ts': lines(
    ...STAFF_HEADER, '', ...RENDER_STAFF, '', ...BAR_LINES, '',
    'export function measureWidth(beats: number): number {',
    '  return Math.round(beats * 12);',
    '}',
    '',
    'export function staffWidth(bars: number, beats: number): number {',
    '  return bars * measureWidth(beats);',
    '}',
    '',
    'export function renderMeasures(bars: string[], beats: number): string {',
    '  const width = measureWidth(beats);',
    "  return bars.map((bar) => bar.padEnd(width, ' ')).join('\\n');",
    '}',
  ),
  'src/score/format.ts': lines(
    'const UNIT_WORDS: Record<number, string> = {',
    "  2: '2 分の',",
    "  4: '4 分の',",
    "  8: '8 分の',",
    '};',
    '',
    'export function formatMeter(beats: number, unit: number): string {',
    '  if (!(unit in UNIT_WORDS)) return `${beats}/${unit}`;',
    '  return `${UNIT_WORDS[unit]}${beats}拍`;',
    '}',
    '',
    'export function formatMeterList(meters: Array<{ beats: number; unit: number }>): string {',
    "  return meters.map(({ beats, unit }) => formatMeter(beats, unit)).join(', ');",
    '}',
  ),
};

/**
 * 三段の鎖(main、refactor/meter-model、feat/meter-render、feat/meter-input の順に積む)の履歴を、
 * root に本物のコミットとして作る。戻り値は各段の head と、収束の時点のコミット。
 * 前提: root は git init 済みで HEAD が main を指す空のリポジトリ。
 */
async function buildStackHistory(root, { remoteUrl, resolution = CONFLICT_RESOLUTION, configPath }) {
  const git = gitRunner(root, configPath);

  const main = await commit(git, root, {
    'README.md': lines('# rec-studio', '', '拍子記号つきの譜面を編集する。'),
    'src/score/meter.ts': lines('export const defaultMeter = { beats: 4, unit: 4 };'),
    'src/score/render.ts': lines(...RENDER_STAFF),
    'src/score/format.ts': lines(...FORMAT_PLAIN),
  }, 'rec-studio の初期状態', 0);
  await git(['remote', 'add', 'origin', remoteUrl]);
  await git(['update-ref', 'refs/remotes/origin/main', main]);

  // 最下段は R1 で収束する。中段は R0 から分岐して収束し、その後に base の R1 を取り込む。上段は収束の後に中段の head を取り込み、競合を解消する。
  await git(['checkout', '-q', '-b', 'refactor/meter-model']);
  const refactorBase = await commit(git, root, {
    'src/score/meter.ts': lines(...METER_TYPE, '', ...DEFAULT_METER_TYPED),
  }, '拍子の型を定義する', 1);
  const refactorHead = await commit(git, root, {
    'src/score/meter.ts': lines(...METER_TYPE, '', ...DEFAULT_METER_TYPED, '', ...WITH_BEATS),
    'src/score/render.ts': lines(...RENDER_STAFF, '', ...BAR_LINES),
    'src/score/format.ts': lines(...FORMAT_SPACED),
  }, '拍子変更のデータ構造を分離する', 2);
  await git(['update-ref', 'refs/remotes/origin/refactor/meter-model', refactorHead]);

  await git(['checkout', '-q', '-b', 'feat/meter-render', refactorBase]);
  const renderConverged = await commit(git, root, {
    'src/score/render.ts': lines(...STAFF_HEADER, '', ...RENDER_STAFF),
  }, '拍子を譜面の描画へ反映する', 3);
  const renderHead = await mergeClean(git, refactorHead, 'Merge branch refactor/meter-model into feat/meter-render', 4);
  await git(['update-ref', 'refs/remotes/origin/feat/meter-render', renderHead]);

  await git(['checkout', '-q', '-b', 'feat/meter-input', renderConverged]);
  const inputConverged = await commit(git, root, {
    'src/score/meter.ts': lines(...METER_TYPE, '', ...DEFAULT_METER_TYPED, '', ...BEATS_LABEL),
    'src/score/render.ts': lines(...STAFF_HEADER, '', ...RENDER_STAFF, '', ...MEASURE_WIDTH),
    'src/score/format.ts': lines(...FORMAT_UNIT_FIRST),
    'src/ui/meter-input.ts': lines(...PARSE_INPUT),
  }, '拍子記号の入力欄を追加する', 5);
  const inputHead = await mergeResolved(git, root, renderHead, resolution, 'Merge branch feat/meter-render into feat/meter-input', 6);
  await git(['update-ref', 'refs/remotes/origin/feat/meter-input', inputHead]);

  await git(['checkout', '-q', 'main']);
  return { refactorHead, renderConverged, renderHead, inputConverged, inputHead };
}

module.exports = { buildStackHistory };
