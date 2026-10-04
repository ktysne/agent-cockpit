#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { expandGuideMaps } = require('./guide-map.js');
const { escapeHtml } = require('./html-utils');
const { isRecord: isPlainObject } = require('./value-utils');

const ROOT = path.resolve(__dirname, '../..');
const MANUAL_ROOT = path.join(ROOT, 'manual');
const DEFAULT_OUT_DIR = 'manual/dist';
const SEARCH_INDEX_OUTPUT = 'assets/search-index.js';
const MAX_SEARCH_INDEX_BYTES = 1024 * 1024;
const NAV_GROUP_ORDER = Object.freeze([
  'はじめに',
  '目的別のガイド',
  '状況を見る',
  '判断と回答',
  'PR',
  '設定と運用',
]);
const TEXT_ASSET_EXTENSIONS = new Set(['.css', '.js']);

// 原稿は checkout の設定で CRLF になりうる。組み立ての結果を環境によらず同じにするため LF にそろえる。
function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}
const HELP_ANCHOR_NAME_PATTERN = /^help-[a-z0-9]+(?:-[a-z0-9]+)*$/;

function assertRelativePath(value, description) {
  if (typeof value !== 'string' || value.length === 0 || path.posix.isAbsolute(value)
      || value.includes('\\') || value.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`${description} は安全な相対パスで指定してください: ${value}`);
  }
}

function outputFor(page) {
  return page.output ?? `${page.id}.html`;
}

function relativeUrl(fromOutput, targetOutput) {
  const fromDirectory = path.posix.dirname(fromOutput);
  const relative = path.posix.relative(fromDirectory === '.' ? '' : fromDirectory, targetOutput);
  return relative || path.posix.basename(targetOutput);
}

function decodeHtmlEntities(value) {
  const entities = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
    if (name[0] !== '#') return entities[name.toLowerCase()] ?? entity;
    const codePoint = name[1].toLowerCase() === 'x'
      ? Number.parseInt(name.slice(2), 16)
      : Number.parseInt(name.slice(1), 10);
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return entity;
    }
  });
}

function extractHtmlText(source) {
  return decodeHtmlEntities(source
    .replace(/<!--[^]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[^]*?<\/\1\s*>/gi, '')
    .replace(/<br\b[^>]*>/gi, ' ')
    .replace(/<\/(?:address|article|aside|blockquote|body|caption|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|li|main|menu|nav|noscript|ol|p|pre|search|section|summary|table|tbody|td|tfoot|th|thead|tr|ul)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractIds(source) {
  const ids = new Set();
  const visibleSource = source.replace(/<!--[^]*?-->/g, '');
  for (const match of visibleSource.matchAll(/\bid\s*=\s*(["'])(.*?)\1/gi)) ids.add(match[2]);
  return ids;
}

function preparePageContent(source, pageId) {
  const usedIds = extractIds(source);
  let headingNumber = 0;
  const content = source.replace(/<(h[23])\b([^>]*)>([^]*?)<\/\1\s*>/gi, (heading, tag, attributes, innerHtml) => {
    headingNumber += 1;
    if (/\bid\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i.test(attributes)) return heading;
    const titleSlug = extractHtmlText(innerHtml).normalize('NFKC').toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '');
    const baseId = `${pageId}-${titleSlug || `section-${headingNumber}`}`;
    let id = baseId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
    usedIds.add(id);
    return `<${tag}${attributes} id="${escapeHtml(id)}">${innerHtml}</${tag}>`;
  });
  const headings = [...content.matchAll(/<(h[23])\b([^>]*)>([^]*?)<\/\1\s*>/gi)].map(match => ({
    level: Number(match[1][1]),
    id: /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[2])?.slice(1).find(Boolean) ?? '',
    title: extractHtmlText(match[3]),
    start: match.index,
    end: match.index + match[0].length,
  }));
  const prefix = headings.length > 0 ? content.slice(0, headings[0].start) : '';
  const sections = headings.map((heading, index) => {
    const nextStart = headings[index + 1]?.start ?? content.length;
    const precedingText = index === 0 ? prefix : '';
    return {
      level: heading.level,
      id: heading.id,
      title: heading.title,
      text: extractHtmlText(`${precedingText} ${content.slice(heading.end, nextStart)}`),
    };
  });
  if (sections.length === 0) sections.push({ level: 2, id: '', title: '', text: extractHtmlText(content) });
  return { content, sections };
}

function serializeSearchIndex(index) {
  return `window.manualSearchIndex = ${JSON.stringify(index).replace(/</g, '\\u003c')};\n`;
}

function createSearchIndex(pages) {
  const index = [];
  for (const page of pages) {
    for (const section of page.sections ?? preparePageContent(page.content ?? '', page.id).sections) {
      index.push({
        pageTitle: page.title,
        sectionTitle: section.title || page.title,
        href: `${outputFor(page)}${section.id ? `#${section.id}` : ''}`,
        text: section.text,
      });
    }
  }
  const indexBytes = Buffer.byteLength(serializeSearchIndex(index), 'utf8');
  if (indexBytes > MAX_SEARCH_INDEX_BYTES) throw new Error(`検索索引が 1 MiB を超えています: ${indexBytes} bytes`);
  return index;
}

function createPageList(site, page) {
  return site.pages.map(item => {
    const href = relativeUrl(outputFor(page), outputFor(item));
    return `    <li><a href="${escapeHtml(href)}">${escapeHtml(item.title)}</a></li>`;
  }).join('\n');
}

function prepareManualPages(site, manualRoot = MANUAL_ROOT) {
  const pages = site.pages.map(page => {
    const sourcePath = path.join(manualRoot, ...page.source.split('/'));
    let source = readText(sourcePath);
    const pageListMarkers = source.match(/\{\{PAGE_LIST\}\}/g) ?? [];
    if (page.id === 'index' && pageListMarkers.length !== 1) {
      throw new Error(`manual/${page.source}: {{PAGE_LIST}} は 1 か所必要です`);
    }
    if (page.id !== 'index' && pageListMarkers.length > 0) {
      throw new Error(`manual/${page.source}: {{PAGE_LIST}} は入口ページだけで使えます`);
    }
    source = source.replace('{{PAGE_LIST}}', () => createPageList(site, page));
    let expanded;
    try {
      expanded = expandGuideMaps(source, {
        manualRoot,
        imageUrl: shot => `img/${shot}.png`,
        idPrefix: `${page.id}-map`,
      });
    } catch (error) {
      throw new Error(`manual/${page.source}: ${error.message}`);
    }
    const prepared = preparePageContent(expanded, page.id);
    return { ...page, output: outputFor(page), content: prepared.content, sections: prepared.sections };
  });
  return { pages, byId: new Map(pages.map(page => [page.id, page])), searchIndex: createSearchIndex(pages) };
}

function createNavLinks(site, page) {
  const link = item => {
    const href = relativeUrl(outputFor(page), outputFor(item));
    const current = item.id === page.id ? ' aria-current="page"' : '';
    return `<a href="${escapeHtml(href)}"${current}>${escapeHtml(item.title)}</a>`;
  };
  const topItems = site.pages.filter(item => item.navGroup === undefined)
    .map(item => `      <li class="nav-top">${link(item)}</li>`);
  const groupItems = NAV_GROUP_ORDER.flatMap(group => {
    const pages = site.pages.filter(item => item.navGroup === group);
    if (pages.length === 0) return [];
    const links = pages.map(item => `        <li>${link(item)}</li>`).join('\n');
    return [`      <li class="nav-group"><h3 class="nav-group-title">${escapeHtml(group)}</h3>\n        <ol class="nav-pages">\n${links}\n        </ol>\n      </li>`];
  });
  return [...topItems, ...groupItems].join('\n');
}

function createSectionLinks(page) {
  return page.sections.filter(section => section.id && section.title).map(section => {
    const levelClass = section.level === 3 ? ' class="level-3"' : '';
    return `        <li${levelClass}><a href="#${escapeHtml(section.id)}">${escapeHtml(section.title)}</a></li>`;
  }).join('\n');
}

function createPageNavigation(site, page) {
  const pageIndex = site.pages.findIndex(item => item.id === page.id);
  const previous = pageIndex > 0 ? site.pages[pageIndex - 1] : null;
  const next = pageIndex >= 0 && pageIndex + 1 < site.pages.length ? site.pages[pageIndex + 1] : null;
  const link = (target, direction) => target
    ? `<a class="${direction}" href="${escapeHtml(relativeUrl(outputFor(page), outputFor(target)))}"><span class="page-navigation-label">${direction === 'previous' ? '前のページ' : '次のページ'}</span><span class="page-navigation-title">${escapeHtml(target.title)}</span></a>`
    : '<span class="page-navigation-empty" aria-hidden="true"></span>';
  return `      <nav class="page-navigation" aria-label="前後のページ">${link(previous, 'previous')}${link(next, 'next')}</nav>`;
}

function validateSite(site, manualRoot = MANUAL_ROOT, repoRoot = path.resolve(manualRoot, '..')) {
  const errors = [];
  if (!Array.isArray(site?.pages) || site.pages.length === 0) errors.push('manual/site.json: pages は 1 件以上の配列で指定してください');
  if (!isPlainObject(site?.helpAnchors)) errors.push('manual/site.json: helpAnchors はオブジェクトで指定してください');
  if (Object.prototype.hasOwnProperty.call(site ?? {}, 'oldAnchors')) errors.push('manual/site.json: oldAnchors は使用できません');

  const pages = Array.isArray(site?.pages) ? site.pages : [];
  const ids = new Set();
  const sources = new Set();
  const pageByOutput = new Map();
  const sourceByOutput = new Map();
  let previousGroupIndex = -1;
  for (const [index, page] of pages.entries()) {
    if (!isPlainObject(page)) {
      errors.push('manual/site.json: pages に不正な項目があります');
      continue;
    }
    if (typeof page.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(page.id)) {
      errors.push(`manual/site.json: ページ id が不正です: ${page.id}`);
      continue;
    }
    if (ids.has(page.id)) errors.push(`manual/site.json: ページ id が重複しています: ${page.id}`);
    ids.add(page.id);
    if (typeof page.title !== 'string' || page.title.trim().length === 0) errors.push(`manual/site.json: ページ ${page.id} の title がありません`);
    if (index === 0 && page.id !== 'index') errors.push(`manual/site.json: 先頭のページは index にしてください (${page.id})`);
    if (index === 0 && page.navGroup !== undefined) errors.push(`manual/site.json: index に navGroup は指定できません`);
    if (index > 0) {
      const groupIndex = NAV_GROUP_ORDER.indexOf(page.navGroup);
      if (groupIndex < 0) errors.push(`manual/site.json: ページ ${page.id} の navGroup が設計資料の区分にありません: ${page.navGroup}`);
      else if (groupIndex < previousGroupIndex) errors.push(`manual/site.json: ページ ${page.id} の navGroup は設計資料の順序にしてください: ${page.navGroup}`);
      if (groupIndex >= 0) previousGroupIndex = groupIndex;
    }

    let sourceIsSafe = true;
    try {
      assertRelativePath(page.source, `manual/site.json のページ ${page.id} source`);
    } catch (error) {
      sourceIsSafe = false;
      errors.push(error.message);
    }
    if (sourceIsSafe && (!page.source.startsWith('pages/') || !page.source.endsWith('.html'))) {
      sourceIsSafe = false;
      errors.push(`manual/site.json: ページ ${page.id} の source は pages/ 下の HTML にしてください: ${page.source}`);
    }
    if (sourceIsSafe && sources.has(page.source)) errors.push(`manual/site.json: ページ source が重複しています: ${page.source}`);
    if (sourceIsSafe) sources.add(page.source);
    const output = `${page.id}.html`;
    if (pageByOutput.has(output)) errors.push(`manual/site.json: ページ output が重複しています: ${output}`);
    pageByOutput.set(output, page);

    if (sourceIsSafe) {
      const sourcePath = path.join(manualRoot, ...page.source.split('/'));
      try {
        if (!fs.statSync(sourcePath).isFile()) throw new Error('not a file');
        sourceByOutput.set(output, readText(sourcePath));
      } catch {
        errors.push(`manual/${page.source}: ページ原稿がありません`);
      }
    }
  }
  if (!ids.has('index')) errors.push('manual/site.json: index ページがありません');

  const helpAnchors = isPlainObject(site?.helpAnchors) ? site.helpAnchors : {};
  for (const [key, target] of Object.entries(helpAnchors)) {
    if (!HELP_ANCHOR_NAME_PATTERN.test(key)) errors.push(`manual/site.json: 導線の鍵名が不正です: ${key}`);
    if (!isPlainObject(target) || typeof target.output !== 'string' || typeof target.fragment !== 'string' || target.fragment.length === 0) {
      errors.push(`manual/site.json: 導線の鍵 ${key} のページと節が不正です`);
      continue;
    }
    if (!/^[a-z][a-z0-9-]*\.html$/.test(target.output)) {
      errors.push(`manual/site.json: 導線の鍵 ${key} の output が不正です: ${target.output}`);
      continue;
    }
    const pageSource = sourceByOutput.get(target.output);
    if (!pageByOutput.has(target.output)) errors.push(`manual/site.json: 導線の鍵 ${key} のページがありません: ${target.output}`);
    else if (!extractIds(pageSource ?? '').has(target.fragment)) errors.push(`manual/site.json: 導線の鍵 ${key} の節がありません: ${target.output}#${target.fragment}`);
  }

  for (const relative of ['layout.html', 'assets/manual.css', 'assets/manual.js']) {
    const filePath = path.join(manualRoot, ...relative.split('/'));
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) errors.push(`manual/${relative}: 必要なファイルがありません`);
  }
  return errors;
}

function readSite(manualRoot = MANUAL_ROOT, repoRoot = path.resolve(manualRoot, '..')) {
  const sitePath = path.join(manualRoot, 'site.json');
  if (!fs.existsSync(sitePath)) throw new Error('manual/site.json: ファイルがありません');
  let site;
  try {
    site = JSON.parse(fs.readFileSync(sitePath, 'utf8'));
  } catch (error) {
    throw new Error(`manual/site.json: JSON として読めません: ${error.message}`);
  }
  const errors = validateSite(site, manualRoot, repoRoot);
  if (errors.length > 0) throw new Error(errors.join('\n'));
  return { ...site, pages: site.pages.map(page => ({ ...page, output: `${page.id}.html` })) };
}

function sortedEntries(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
}

function listFiles(directory, prefix = '') {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of sortedEntries(directory)) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(filePath, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

function copyAssets(sourceDir, targetDir) {
  for (const relative of listFiles(sourceDir)) {
    if (relative === path.posix.basename(SEARCH_INDEX_OUTPUT)) continue;
    const sourcePath = path.join(sourceDir, ...relative.split('/'));
    const targetPath = path.join(targetDir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (TEXT_ASSET_EXTENSIONS.has(path.extname(relative).toLowerCase())) fs.writeFileSync(targetPath, readText(sourcePath), 'utf8');
    else fs.copyFileSync(sourcePath, targetPath);
  }
}

function renderPage(layout, site, page, preparedManual) {
  const preparedPage = preparedManual.byId.get(page.id);
  if (!preparedPage) throw new Error(`manual/${page.source}: 準備済みページがありません`);
  const title = page.id === 'index' ? 'Agent Cockpit でできること | 利用者向けマニュアル' : `${page.title} | Agent Cockpit マニュアル`;
  const helpAnchors = page.id === 'index' ? site.helpAnchors : {};
  const replacements = {
    '{{DOCUMENT_TITLE}}': escapeHtml(title),
    '{{HELP_ANCHORS}}': `<script>window.manualHelpAnchors = ${JSON.stringify(helpAnchors).replace(/</g, '\\u003c')};</script>`,
    '{{NAV_LINKS}}': createNavLinks(site, page),
    '{{PAGE_NAV}}': createPageNavigation(site, page),
    '{{SECTION_LINKS}}': createSectionLinks(preparedPage),
  };
  let rendered = layout;
  for (const [token, value] of Object.entries(replacements)) rendered = rendered.replaceAll(token, () => value);
  const contentTokens = rendered.match(/\{\{CONTENT\}\}/g) ?? [];
  if (contentTokens.length !== 1) throw new Error('manual/layout.html: {{CONTENT}} は 1 か所必要です');
  rendered = rendered.replace('{{CONTENT}}', () => preparedPage.content);
  const leftovers = rendered.match(/\{\{[^{}]+\}\}/g) ?? [];
  if (leftovers.length > 0) throw new Error(`manual/${page.source}: 未処理の差し込み欄があります: ${[...new Set(leftovers)].join(', ')}`);
  return rendered;
}

function isWithinPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function buildManual(outDir = DEFAULT_OUT_DIR, manualRoot = MANUAL_ROOT, repoRoot = ROOT) {
  const site = readSite(manualRoot, repoRoot);
  const preparedManual = prepareManualPages(site, manualRoot);
  const layout = readText(path.join(manualRoot, 'layout.html'));
  const targetRoot = path.resolve(repoRoot, outDir);
  const resolvedManualRoot = path.resolve(manualRoot);
  if (isWithinPath(targetRoot, resolvedManualRoot)) throw new Error('出力先が原稿の manual/ を含むため組み立てを中止しました');
  // 出力先は組み立ての前に消すので、原稿の中では dist の下だけを許す。
  if (isWithinPath(resolvedManualRoot, targetRoot) && !isWithinPath(path.join(resolvedManualRoot, 'dist'), targetRoot)) {
    throw new Error('出力先が原稿の manual/ の中にあるため組み立てを中止しました');
  }
  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(targetRoot, 'assets'), { recursive: true });
  const generated = [];
  for (const page of site.pages) {
    const outputPath = path.join(targetRoot, outputFor(page));
    fs.writeFileSync(outputPath, renderPage(layout, site, page, preparedManual), 'utf8');
    generated.push(outputPath);
  }
  copyAssets(path.join(manualRoot, 'assets'), path.join(targetRoot, 'assets'));
  const searchIndexPath = path.join(targetRoot, SEARCH_INDEX_OUTPUT);
  fs.writeFileSync(searchIndexPath, serializeSearchIndex(preparedManual.searchIndex), 'utf8');
  generated.push(...listFiles(path.join(targetRoot, 'assets')).map(file => path.join(targetRoot, 'assets', ...file.split('/'))));
  return generated;
}

function parseArgs(argv) {
  let outDir = DEFAULT_OUT_DIR;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--out') throw new Error(`不明なオプションです: ${argv[index]}`);
    if (argv[index + 1] === undefined) throw new Error('--out に値がありません');
    outDir = argv[index + 1];
    index += 1;
  }
  return outDir;
}

function main(argv = process.argv.slice(2)) {
  try {
    const outDir = parseArgs(argv);
    const generated = buildManual(outDir);
    console.log(`[manual:build] ${generated.length} ファイルを ${path.resolve(ROOT, outDir)} に出力しました。`);
  } catch (error) {
    console.error(`[manual:build] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_OUT_DIR,
  HELP_ANCHOR_NAME_PATTERN,
  MAX_SEARCH_INDEX_BYTES,
  NAV_GROUP_ORDER,
  SEARCH_INDEX_OUTPUT,
  buildManual,
  createNavLinks,
  createPageNavigation,
  createPageList,
  createSearchIndex,
  createSectionLinks,
  decodeHtmlEntities,
  escapeHtml,
  extractHtmlText,
  extractIds,
  isWithinPath,
  listFiles,
  parseArgs,
  prepareManualPages,
  preparePageContent,
  readSite,
  relativeUrl,
  renderPage,
  serializeSearchIndex,
  validateSite,
};

if (require.main === module) main();
