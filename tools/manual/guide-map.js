'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PLACES = new Set(['inside', 'center', 'top', 'bottom', 'left', 'right', 'top-start', 'bottom-start']);

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function readAttributes(source) {
  const attributes = {};
  for (const match of source.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) attributes[match[1].toLowerCase()] = match[2];
  return attributes;
}

function plainText(html) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function percent(value) {
  return `${Number((value * 100).toFixed(3))}%`;
}

function readCapture(manualRoot, shot) {
  if (!/^[^/\\]+\/[^/\\]+$/.test(shot)) throw new Error(`data-shot は <定義名>/<撮影名> で指定してください: ${shot}`);
  const parts = shot.split('/');
  if (parts.some(part => part === '.' || part === '..')) throw new Error(`data-shot のパスが不正です: ${shot}`);
  const imageRoot = path.resolve(manualRoot, 'img');
  const base = path.resolve(imageRoot, ...parts);
  const relative = path.relative(imageRoot, base);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`data-shot のパスが不正です: ${shot}`);
  }
  if (!fs.existsSync(`${base}.png`)) throw new Error(`ガイドマップの画像がありません: img/${shot}.png`);
  if (!fs.existsSync(`${base}.json`)) throw new Error(`ガイドマップの部品の矩形がありません: img/${shot}.json`);
  const capture = JSON.parse(fs.readFileSync(`${base}.json`, 'utf8'));
  if (!Number.isFinite(capture.width) || !Number.isFinite(capture.height) || !Array.isArray(capture.parts)) {
    throw new Error(`部品の矩形の形式が不正です: img/${shot}.json`);
  }
  return capture;
}

function anchorFor({ x, y, width: w, height: h }, place) {
  switch (place) {
    case 'inside': return [x, y];
    case 'top': return [x + w / 2, y];
    case 'bottom': return [x + w / 2, y + h];
    case 'top-start': return [x, y];
    case 'bottom-start': return [x, y + h];
    case 'left': return [x, y + h / 2];
    case 'right': return [x + w, y + h / 2];
    default: return [x + w / 2, y + h / 2];
  }
}

function parseItem(attributes, capture, shot, number) {
  const place = attributes['data-place'] ?? (attributes['data-mark'] === 'frame' ? 'inside' : 'top');
  if (!PLACES.has(place)) throw new Error(`${shot} の ${number} 番: data-place が不正です: ${place}`);
  if (attributes['data-at'] !== undefined) {
    const point = attributes['data-at'].split(',').map(Number);
    if (point.length !== 2 || point.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error(`${shot} の ${number} 番: data-at は 0〜1 の x,y で指定してください`);
    }
    return { anchor: [point[0] * capture.width, point[1] * capture.height], place: 'center', frame: null };
  }
  const key = attributes['data-part'];
  if (!key) throw new Error(`${shot} の ${number} 番: data-part か data-at を指定してください`);
  const part = capture.parts.find(item => item.key === key && item.visible !== false);
  if (!part) throw new Error(`${shot} の ${number} 番: 画像に写った部品がありません: ${key}`);
  const bounds = part.bounds;
  const frame = attributes['data-mark'] === 'frame' ? bounds : null;
  return { anchor: anchorFor(bounds, place), place, frame };
}

function parseCrop(value, capture, shot) {
  if (value === undefined) return [[0, capture.width]];
  const ranges = value.split(',').map(range => range.trim().split('-').map(Number));
  let previousEnd = 0;
  for (const range of ranges) {
    if (range.length !== 2 || !range.every(Number.isInteger) || range[0] < previousEnd || range[1] <= range[0] || range[1] > capture.width) {
      throw new Error(`${shot}: data-crop は重ならない昇順の 開始-終了 を画素で指定してください`);
    }
    previousEnd = range[1];
  }
  return ranges;
}

function parseCropY(value, capture, shot) {
  if (value === undefined) return [0, capture.height];
  const range = value.trim().split('-').map(Number);
  if (range.length !== 2 || !range.every(Number.isInteger) || range[0] < 0 || range[1] <= range[0] || range[1] > capture.height) {
    throw new Error(`${shot}: data-crop-y は 開始-終了 を画素で指定してください`);
  }
  return range;
}

function parseDisplayWidth(value, shot) {
  if (value === undefined) return null;
  const width = Number(value);
  if (!Number.isInteger(width) || width <= 0) throw new Error(`${shot}: data-width は正の整数の CSS ピクセルで指定してください`);
  return width;
}

function renderGuideMap(figureAttributes, listHtml, { manualRoot, imageUrl, idPrefix, uniqueId }) {
  const shot = figureAttributes['data-shot'];
  const alt = figureAttributes['data-alt'];
  if (!shot) throw new Error('guide-map に data-shot がありません');
  if (!alt) throw new Error(`${shot}: guide-map に data-alt がありません`);
  const capture = readCapture(manualRoot, shot);
  const figureId = figureAttributes.id || uniqueId(`${idPrefix}-${shot.replace(/[^\p{L}\p{N}]+/gu, '-')}`);

  const items = listHtml === null ? [] : [...listHtml.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li\s*>/gi)];
  if (listHtml !== null && items.length === 0) throw new Error(`${shot}: guide-list に項目がありません`);
  const segments = parseCrop(figureAttributes['data-crop'], capture, shot).map(([from, to]) => ({ from, to, overlays: [] }));
  const [top, bottom] = parseCropY(figureAttributes['data-crop-y'], capture, shot);
  const cropHeight = bottom - top;
  const displayWidth = parseDisplayWidth(figureAttributes['data-width'], shot);
  const segmentAt = (x, y, number) => {
    const segment = segments.find(item => x >= item.from && x <= item.to);
    if (!segment || y < top || y > bottom) throw new Error(`${shot} の ${number} 番: 札が data-crop の範囲の外にあります`);
    return segment;
  };
  const entries = [];
  items.forEach((match, index) => {
    const number = index + 1;
    const attributes = readAttributes(match[1]);
    const item = parseItem(attributes, capture, shot, number);
    const itemId = `${figureId}-${number}`;
    const name = plainText(/<(?:b|strong)\b[^>]*>([\s\S]*?)<\/(?:b|strong)\s*>/i.exec(match[2])?.[1] ?? '');
    if (!name) throw new Error(`${shot} の ${number} 番: 名称を <b> で書いてください`);
    const [anchorX, anchorY] = item.anchor;
    const segment = segmentAt(anchorX, anchorY, number);
    const segmentWidth = segment.to - segment.from;
    if (item.frame) {
      const left = Math.max(item.frame.x, segment.from);
      const right = Math.min(item.frame.x + item.frame.width, segment.to);
      const frameTop = Math.max(item.frame.y, top);
      const frameBottom = Math.min(item.frame.y + item.frame.height, bottom);
      segment.overlays.push(`<span class="gm-frame" data-gm="${number}" aria-hidden="true" style="left:${percent((left - segment.from) / segmentWidth)};top:${percent((frameTop - top) / cropHeight)};width:${percent((right - left) / segmentWidth)};height:${percent((frameBottom - frameTop) / cropHeight)}"></span>`);
    }
    segment.overlays.push(`<a class="gm-badge gm-place-${item.place}" data-gm="${number}" href="#${itemId}" style="left:${percent((anchorX - segment.from) / segmentWidth)};top:${percent((anchorY - top) / cropHeight)}" aria-label="${number}. ${escapeAttribute(name)}">${number}</a>`);
    entries.push(`<li id="${itemId}" data-gm="${number}"><span class="gm-num" aria-hidden="true">${number}</span><div class="gm-body">${match[2].trim()}</div></li>`);
  });

  const width = Math.round(capture.width / 2);
  const height = Math.round(capture.height / 2);
  const source = escapeAttribute(imageUrl(shot));
  const segmentHtml = segments.map(({ from, to, overlays }, index) => {
    const segmentWidth = to - from;
    const imageStyle = segmentWidth === capture.width && cropHeight === capture.height ? ''
      : ` style="width:${percent(capture.width / segmentWidth)};margin-left:${percent(-from / segmentWidth)};margin-top:${percent(-top / segmentWidth)}"`;
    const imageAlt = index === 0 ? escapeAttribute(alt) : '';
    return `<div class="gm-segment" style="flex-grow:${segmentWidth};aspect-ratio:${segmentWidth}/${cropHeight}">`
      + `<div class="gm-clip"><img src="${source}" width="${width}" height="${height}" alt="${imageAlt}" loading="lazy" decoding="async"${imageStyle}></div>`
      + overlays.join('')
      + '</div>';
  }).join('');
  const imageAreaStyle = displayWidth === null ? ''
    : ` style="max-width:${displayWidth}px;min-width:min(600px, ${displayWidth}px)"`;
  const zoomWidth = segments.reduce((sum, { from, to }) => sum + to - from, 0);
  const className = ['guide-map', figureAttributes.class?.replace(/\bguide-map\b/, '').trim()].filter(Boolean).join(' ');
  return `<figure class="${escapeAttribute(className)}" id="${figureId}" data-guide-map>`
    + `<div class="gm-stage"><div class="gm-image" data-zoom-width="${zoomWidth}"${imageAreaStyle}>${segmentHtml}</div></div>`
    + (listHtml === null ? '' : `<ol class="gm-list">${entries.join('')}</ol>`)
    + '</figure>';
}

function renderLocator(figureAttributes, { manualRoot, imageUrl, idPrefix, uniqueId }) {
  const shot = figureAttributes['data-shot'];
  const alt = figureAttributes['data-alt'];
  const keys = figureAttributes['data-part']?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (!shot) throw new Error('locator に data-shot がありません');
  if (!alt) throw new Error(`${shot}: locator に data-alt がありません`);
  if (keys.length === 0) throw new Error(`${shot}: locator に data-part がありません`);
  const capture = readCapture(manualRoot, shot);
  const bounds = keys.map(key => {
    const part = capture.parts.find(item => item.key === key && item.visible !== false);
    if (!part) throw new Error(`${shot}: locator の画像に写った部品がありません: ${key}`);
    return part.bounds;
  });
  const x = Math.min(...bounds.map(b => b.x));
  const y = Math.min(...bounds.map(b => b.y));
  const width = Math.max(...bounds.map(b => b.x + b.width)) - x;
  const height = Math.max(...bounds.map(b => b.y + b.height)) - y;
  const frameStyle = `left:${percent(x / capture.width)};top:${percent(y / capture.height)};width:${percent(width / capture.width)};height:${percent(height / capture.height)}`;
  const figureId = figureAttributes.id || uniqueId(`${idPrefix}-locator-${shot.replace(/[^\p{L}\p{N}]+/gu, '-')}`);
  const className = ['locator', figureAttributes.class?.replace(/\blocator\b/, '').trim()].filter(Boolean).join(' ');
  return `<figure class="${escapeAttribute(className)}" id="${figureId}">`
    + `<div class="lc-image" data-zoom-width="${capture.width}">`
    + `<img src="${escapeAttribute(imageUrl(shot))}" width="${Math.round(capture.width / 2)}" height="${Math.round(capture.height / 2)}" alt="${escapeAttribute(alt)}" loading="lazy" decoding="async">`
    + `<span class="lc-frame" aria-hidden="true" style="${frameStyle}"></span>`
    + '</div></figure>';
}

function expandGuideMaps(source, baseOptions) {
  const usedIds = new Set([...source.matchAll(/<[a-z][^>]*\bid="([^"]*)"/gi)].map(match => match[1]));
  const uniqueId = base => {
    let id = base;
    for (let suffix = 2; usedIds.has(id); suffix++) id = `${base}-v${suffix}`;
    usedIds.add(id);
    return id;
  };
  const options = { ...baseOptions, uniqueId };
  const withLocators = source.replace(
    /<figure\b([^>]*\bclass="[^"]*\blocator\b[^"]*"[^>]*)>\s*<\/figure\s*>/gi,
    (_, attributes) => renderLocator(readAttributes(attributes), options),
  );
  const wrappedSteps = withLocators.replace(
    /(<li\b[^>]*>)((?:(?!<\/li\s*>)[\s\S])*?)(<figure\b[^>]*\bclass="[^"]*\bguide-map\b[^"]*"[^>]*>(?:\s*<ol\b[^>]*\bclass="guide-list"[^>]*>[\s\S]*?<\/ol\s*>)?\s*<\/figure\s*>\s*<\/li\s*>)/gi,
    (_, open, body, figure) => `${open}<div class="step-body">${body.trim()}</div>${figure}`,
  );
  const withoutList = wrappedSteps.replace(
    /<figure\b([^>]*\bclass="[^"]*\bguide-map\b[^"]*"[^>]*)>\s*<\/figure\s*>/gi,
    (_, attributes) => renderGuideMap(readAttributes(attributes), null, options),
  );
  const expanded = withoutList.replace(
    /<figure\b([^>]*\bclass="[^"]*\bguide-map\b[^"]*"[^>]*)>\s*<ol\b[^>]*\bclass="guide-list"[^>]*>([\s\S]*?)<\/ol\s*>\s*<\/figure\s*>/gi,
    (_, attributes, listHtml) => renderGuideMap(readAttributes(attributes), listHtml, options),
  );
  if (/class="guide-list"/i.test(expanded)) {
    throw new Error('guide-map の書式が不正です。figure の直下に <ol class="guide-list"> だけを置いてください');
  }
  return expanded;
}

module.exports = { escapeAttribute, expandGuideMaps, readAttributes };
