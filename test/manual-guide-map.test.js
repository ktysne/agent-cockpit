const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expandGuideMaps } = require('../tools/manual/guide-map');
const { temporaryDirectory } = require('./support/temp');

function makeManual(t, parts = [{ key: 'button', bounds: { x: 20, y: 10, width: 60, height: 20 }, visible: true }]) {
  const manualRoot = temporaryDirectory(t, 'agent-cockpit-guide-map-').directory;
  const imageRoot = path.join(manualRoot, 'img', 'sample');
  fs.mkdirSync(imageRoot, { recursive: true });
  fs.writeFileSync(path.join(imageRoot, 'screen.png'), Buffer.from([137, 80, 78, 71]));
  fs.writeFileSync(path.join(imageRoot, 'screen.json'), JSON.stringify({ width: 200, height: 100, parts }));
  return manualRoot;
}

function expand(manualRoot, source) {
  return expandGuideMaps(source, {
    manualRoot,
    imageUrl: shot => `img/${shot}.png`,
    idPrefix: 'manual-map',
  });
}

test('部品の矩形から札、枠、番号に連動する一覧を作る', t => {
  const manualRoot = makeManual(t);
  const html = expand(manualRoot, '<figure class="guide-map" data-shot="sample/screen" data-alt="画面"><ol class="guide-list"><li data-part="button" data-mark="frame" data-place="top"><b>回答欄</b>：回答を入力する。</li></ol></figure>');
  assert.match(html, /src="img\/sample\/screen\.png"/);
  assert.match(html, /class="gm-badge gm-place-top" data-gm="1" href="#manual-map-sample-screen-1"/);
  assert.match(html, /class="gm-frame" data-gm="1"/);
  assert.match(html, /<ol class="gm-list"><li id="manual-map-sample-screen-1" data-gm="1">/);
  assert.match(html, /<b>回答欄<\/b>：回答を入力する。/);
});

test('位置の図を展開し、手順の画像がある項目は説明を step-body にまとめる', t => {
  const manualRoot = makeManual(t, [
    { key: 'button', bounds: { x: 20, y: 10, width: 60, height: 20 }, visible: true },
    { key: 'field', bounds: { x: 100, y: 40, width: 70, height: 30 }, visible: true },
  ]);
  const html = expand(manualRoot, '<ol class="steps"><li><p>回答を選びます。</p><figure class="guide-map" data-shot="sample/screen" data-alt="操作画面"></figure></li></ol><figure class="locator" data-shot="sample/screen" data-part="button field" data-alt="画面上の回答欄"></figure>');
  assert.match(html, /<div class="step-body"><p>回答を選びます。<\/p><\/div>/);
  assert.match(html, /class="locator"/);
  assert.match(html, /class="lc-frame"/);
  assert.match(html, /data-zoom-width="200"/);
});

test('ガイドマップが矩形に無い鍵を参照すると組み立てを止める', t => {
  const manualRoot = makeManual(t, []);
  assert.throws(
    () => expand(manualRoot, '<figure class="guide-map" data-shot="sample/screen" data-alt="画面"><ol class="guide-list"><li data-part="missing"><b>項目</b></li></ol></figure>'),
    /画像に写った部品がありません: missing/,
  );
});
