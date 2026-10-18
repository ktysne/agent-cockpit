const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function templateIncludes(template, webPath) {
  // latin1 はバイトと文字の位置が一致するため、UTF-8 の本文を変換せずに切り出せる。
  const source = template.toString('latin1');
  const markers = /^[\t ]*(?:<!-- cockpit:include (.*?) -->|\/\* cockpit:include (.*?) \*\/|\/\/ cockpit:include ([^\r\n]*))[\t ]*(?:\r?\n|$)/gm;
  return [...source.matchAll(markers)].map(match => {
    const name = match[1] ?? match[2] ?? match[3];
    if (!/^[a-z0-9-]+\.(css|html|js)$/.test(name)) {
      throw new Error(`画面の部品名が不正です: ${name}`);
    }
    return { start: match.index, end: match.index + match[0].length, file: path.join(path.dirname(webPath), name) };
  });
}

function assembleTemplate(template, includes, parts) {
  const chunks = [];
  let offset = 0;
  for (const [index, include] of includes.entries()) {
    chunks.push(template.subarray(offset, include.start), parts[index]);
    offset = include.end;
  }
  chunks.push(template.subarray(offset));
  return Buffer.concat(chunks);
}

function composeUiTemplateSync(webPath) {
  const template = fs.readFileSync(webPath);
  const includes = templateIncludes(template, webPath);
  return assembleTemplate(template, includes, includes.map(include => fs.readFileSync(include.file)));
}

async function composeUiTemplate(webPath) {
  const template = await fsp.readFile(webPath);
  const includes = templateIncludes(template, webPath);
  const parts = await Promise.all(includes.map(include => fsp.readFile(include.file)));
  return assembleTemplate(template, includes, parts);
}

async function readUiTemplateStamp(webPath, previous = null) {
  const stat = await fsp.stat(webPath);
  const templateStamp = `${stat.mtimeMs}:${stat.size}`;
  const files = previous?.templateStamp === templateStamp ? previous.files
    : templateIncludes(await fsp.readFile(webPath), webPath).map(include => include.file);
  const stamps = await Promise.all(files.map(async file => {
    const part = await fsp.stat(file);
    return `${part.mtimeMs}:${part.size}`;
  }));
  return { templateStamp, files, stamp: JSON.stringify([templateStamp, ...stamps]) };
}

module.exports = { composeUiTemplate, composeUiTemplateSync, readUiTemplateStamp };
