// PoC: 受け取ったパスとクエリを表示するだけのサーバー。内部ブラウザでパス付き URL を開けるかの確認に使う。
const http = require('http');

const PORT = 47800;

http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>board poc</title><p id="url">${encodeURI(req.url)}</p>`);
  })
  .listen(PORT, '127.0.0.1');
