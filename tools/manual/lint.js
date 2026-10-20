#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { composeUiTemplateSync } = require('../../src/server/ui-template');
const {
  buildManual,
  decodeHtmlEntities,
  extractHtmlText,
  extractIds,
  listFiles,
  prepareManualPages,
  readSite,
} = require('./build.js');

const ROOT = path.resolve(__dirname, '../..');
const MANUAL_ROOT = path.join(ROOT, 'manual');
const DIST_ROOT = path.join(MANUAL_ROOT, 'dist');

function attributeValues(source, tagName, attributeName) {
  const values = [];
  const tags = source.matchAll(new RegExp(`<${tagName}\\b([^>]*)>`, 'gi'));
  for (const match of tags) {
    const attribute = new RegExp(`\\b${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(match[1]);
    if (attribute) values.push(decodeHtmlEntities(attribute.slice(1).find(value => value !== undefined) ?? ''));
  }
  return values;
}

function uiLabels(source) {
  const labels = [];
  for (const match of source.matchAll(/<span\b([^>]*)>([^]*?)<\/span\s*>/gi)) {
    const classAttribute = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(match[1]);
    const className = classAttribute?.slice(1).find(value => value !== undefined) ?? '';
    if (className.split(/\s+/).includes('ui')) labels.push(extractHtmlText(match[2]));
  }
  return labels.filter(Boolean);
}

function isExternalReference(value) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value);
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function pageOutput(page) {
  return page.output ?? `${page.id}.html`;
}

function inspectLinks(page, content, preparedByOutput, errors) {
  const pageIdSet = extractIds(content);
  for (const rawHref of attributeValues(content, 'a', 'href')) {
    const href = rawHref.trim();
    if (!href || isExternalReference(href)) continue;
    const hashIndex = href.indexOf('#');
    const queryIndex = href.indexOf('?');
    const pathEnd = Math.min(...[hashIndex, queryIndex].filter(index => index >= 0), href.length);
    const rawPath = href.slice(0, pathEnd);
    const rawFragment = hashIndex < 0 ? '' : href.slice(hashIndex + 1, queryIndex >= 0 && queryIndex > hashIndex ? queryIndex : href.length);
    const fragment = decodePath(rawFragment);
    if (fragment === null) {
      errors.push(`manual/${page.source}: リンクの fragment を URL として読めません: ${href}`);
      continue;
    }
    if (!rawPath) {
      if (fragment && !pageIdSet.has(fragment)) errors.push(`manual/${page.source}: ページ内リンクの節がありません: #${fragment}`);
      continue;
    }
    const decodedPath = decodePath(rawPath);
    if (decodedPath === null) {
      errors.push(`manual/${page.source}: リンクのパスを URL として読めません: ${href}`);
      continue;
    }
    if (decodedPath.startsWith('/')) {
      if (!decodedPath.startsWith('/manual/')) continue;
    }
    const targetPath = decodedPath.startsWith('/manual/') ? decodedPath.slice('/manual/'.length) : decodedPath;
    const resolvedPath = path.posix.normalize(path.posix.join(path.posix.dirname(pageOutput(page)), targetPath));
    if (resolvedPath === '..' || resolvedPath.startsWith('../')) {
      errors.push(`manual/${page.source}: manual/ の外を指す相対リンクがあります: ${href}`);
      continue;
    }
    if (path.posix.extname(resolvedPath).toLowerCase() !== '.html') continue;
    const targetPage = preparedByOutput.get(resolvedPath);
    if (!targetPage) {
      errors.push(`manual/${page.source}: リンク先のページがありません: ${href}`);
      continue;
    }
    if (fragment && !extractIds(targetPage.content).has(fragment)) {
      errors.push(`manual/${page.source}: リンク先の節がありません: ${href}`);
    }
  }
}

function collectShotImages(manualRoot, errors) {
  const shotDirectory = path.join(manualRoot, 'shots');
  const references = new Set();
  if (!fs.existsSync(shotDirectory)) return references;
  for (const definitionFile of listFiles(shotDirectory).filter(file => file.endsWith('.json'))) {
    const definitionPath = path.join(shotDirectory, ...definitionFile.split('/'));
    const definitionLabel = `manual/shots/${definitionFile}`;
    let definition;
    try {
      definition = JSON.parse(fs.readFileSync(definitionPath, 'utf8'));
    } catch (error) {
      errors.push(`${definitionLabel}: 撮影の定義を JSON として読めません: ${error.message}`);
      continue;
    }
    if (!Array.isArray(definition.steps)) {
      errors.push(`${definitionLabel}: steps が配列ではありません`);
      continue;
    }
    const definitionName = path.posix.basename(definitionFile, '.json');
    for (const step of definition.steps.filter(item => item?.do === 'screenshot')) {
      if (typeof step.name !== 'string' || !/^[^/\\.][^/\\]*$/.test(step.name) || step.name.includes('..')) {
        errors.push(`${definitionLabel}: screenshot の name が不正です: ${step.name}`);
        continue;
      }
      const image = `${definitionName}/${step.name}.png`;
      references.add(image);
      if (!fs.existsSync(path.join(manualRoot, 'img', ...image.split('/')))) {
        errors.push(`${definitionLabel}: 撮影の画像がありません: img/${image}`);
      }
    }
  }
  return references;
}

function collectImageReferences(pages, preparedManual, manualRoot, errors) {
  const references = collectShotImages(manualRoot, errors);
  for (const page of pages) {
    const prepared = preparedManual.byId.get(page.id);
    if (!prepared) continue;
    for (const rawSource of attributeValues(prepared.content, 'img', 'src')) {
      if (!rawSource || isExternalReference(rawSource) || rawSource.startsWith('data:')) continue;
      const decoded = decodePath(rawSource);
      if (decoded === null || decoded.includes('\\')) {
        errors.push(`manual/${page.source}: 画像のパスが不正です: ${rawSource}`);
        continue;
      }
      if (decoded.startsWith('/manual/img/')) references.add(decoded.slice('/manual/img/'.length));
      else if (decoded.startsWith('/')) continue;
      else {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(pageOutput(page)), decoded));
        if (resolved === '..' || resolved.startsWith('../')) {
          errors.push(`manual/${page.source}: manual/ の外を指す相対画像があります: ${rawSource}`);
        } else if (resolved.startsWith('img/')) {
          references.add(resolved.slice('img/'.length));
        } else {
          errors.push(`manual/${page.source}: 画像は img/ 以下を指定してください: ${rawSource}`);
        }
      }
    }
  }

  const imageDirectory = path.join(manualRoot, 'img');
  const available = new Set(listFiles(imageDirectory).filter(file => path.posix.extname(file).toLowerCase() === '.png'));
  for (const reference of references) {
    if (!available.has(reference)) errors.push(`manual/img/${reference}: 原稿または撮影の定義が指す画像がありません`);
  }
  for (const file of available) {
    if (!references.has(file)) errors.push(`manual/img/${file}: どの原稿や撮影の定義からも参照されていません`);
  }
}

function compareDirectories(expectedRoot, actualRoot, errors) {
  const expected = new Set(listFiles(expectedRoot));
  const actual = new Set(listFiles(actualRoot));
  const allFiles = [...new Set([...expected, ...actual])].sort();
  for (const file of allFiles) {
    const expectedPath = path.join(expectedRoot, ...file.split('/'));
    const actualPath = path.join(actualRoot, ...file.split('/'));
    if (!expected.has(file)) {
      errors.push(`manual/dist/${file}: 組み立て結果に無いファイルがあります`);
    } else if (!actual.has(file)) {
      errors.push(`manual/dist/${file}: 組み立て結果がありません`);
    } else if (!fs.readFileSync(expectedPath).equals(fs.readFileSync(actualPath))) {
      errors.push(`manual/dist/${file}: 原稿から組み立てた結果と一致しません`);
    }
  }
}

function lintManual({ manualRoot = MANUAL_ROOT, distRoot = path.join(manualRoot, 'dist'), repoRoot = ROOT, dashboardPath = path.join(repoRoot, 'src/web/index.html') } = {}) {
  const errors = [];
  let site;
  try {
    site = readSite(manualRoot, repoRoot);
  } catch (error) {
    errors.push(...error.message.split('\n'));
    return { errors };
  }

  let preparedManual;
  try {
    preparedManual = prepareManualPages(site, manualRoot);
  } catch (error) {
    errors.push(error.message.startsWith('manual/') ? error.message : `manual/pages: ${error.message}`);
  }

  let dashboardSource = '';
  try {
    dashboardSource = composeUiTemplateSync(dashboardPath).toString('utf8');
  } catch {
    errors.push(`${path.relative(repoRoot, dashboardPath).replace(/\\/g, '/')}: ファイルがありません`);
  }

  const reviewEvaluationPath = path.join(repoRoot, 'src/shared/review-evaluation.js');
  let reviewSource = '';
  try {
    reviewSource = fs.readFileSync(reviewEvaluationPath, 'utf8');
  } catch {
    errors.push('src/shared/review-evaluation.js: ファイルがありません');
  }
  const uiSource = `${dashboardSource}\n${reviewSource}`;

  if (preparedManual) {
    for (const page of site.pages) {
      const prepared = preparedManual.byId.get(page.id);
      if (!prepared) continue;
      for (const label of uiLabels(prepared.content)) {
        if (!uiSource.includes(label)) errors.push(`manual/${page.source}: span.ui の文言が src/web/index.html と src/shared/review-evaluation.js にありません: ${label}`);
      }
      inspectLinks(page, prepared.content, new Map(preparedManual.pages.map(item => [pageOutput(item), item])), errors);
    }
    collectImageReferences(site.pages, preparedManual, manualRoot, errors);
  }

  for (const match of dashboardSource.matchAll(/\/manual\/#(help-[a-z0-9-]+)/g)) {
    if (!Object.prototype.hasOwnProperty.call(site.helpAnchors, match[1])) {
      errors.push(`src/web/index.html: 画面の導線の鍵が helpAnchors にありません: ${match[1]}`);
    }
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-manual-lint-'));
  try {
    const generatedRoot = path.join(temporaryRoot, 'dist');
    try {
      buildManual(generatedRoot, manualRoot, repoRoot);
      compareDirectories(generatedRoot, distRoot, errors);
    } catch (error) {
      errors.push(error.message.startsWith('manual/') ? error.message : `manual: 組み立てに失敗しました: ${error.message}`);
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
  return { errors };
}

function main() {
  const result = lintManual();
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`[lint:manual] ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('[lint:manual] 原稿、画像、リンク、導線、組み立て結果を検査しました。');
}

module.exports = {
  attributeValues,
  collectImageReferences,
  collectShotImages,
  compareDirectories,
  inspectLinks,
  lintManual,
  uiLabels,
};

if (require.main === module) main();
