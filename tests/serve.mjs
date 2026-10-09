// Minimal static file server for local dev and e2e tests. No dependencies.
// Usage: node tests/serve.mjs [port] [--base /CHARLIE/] [--root dir]
// With --base the repo is mounted under that prefix (mirroring GitHub Pages, which serves
// this project at https://<user>.github.io/CHARLIE/) and every other path returns 404,
// so an accidental absolute URL ("/css/app.css") fails locally exactly as it would in production.
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
let port = 4173;
let base = '/';
let root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--base') base = argv[++i];
  else if (argv[i] === '--root') root = argv[++i];
  else if (/^\d+$/.test(argv[i])) port = Number(argv[i]);
}
root = path.resolve(root);
if (!base.startsWith('/')) base = '/' + base;
if (!base.endsWith('/')) base += '/';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (base !== '/' && urlPath + '/' === base) {
      res.writeHead(301, { Location: base });
      return res.end();
    }
    if (!urlPath.startsWith(base)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end(`Not found (outside base ${base})`);
    }
    let rel = urlPath.slice(base.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const filePath = path.join(root, rel);
    if (!filePath.startsWith(root)) { res.writeHead(403); return res.end('Forbidden'); }
    let st;
    try { st = statSync(filePath); } catch { res.writeHead(404); return res.end('Not found'); }
    if (st.isDirectory()) { res.writeHead(301, { Location: urlPath + '/' }); return res.end(); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': st.size,
    });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    res.writeHead(500); res.end(String(err));
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Serving ${root} at http://127.0.0.1:${port}${base}`));
