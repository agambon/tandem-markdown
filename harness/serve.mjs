// A static server for dist/ on 127.0.0.1, with caching off, for the harness pages.
//
//   node harness/serve.mjs [--port 5177]
//
// Or from a script: `const { url, close } = await serve({ port: 0 })` (0 picks a free port), or
// `await serveOwnBuild(name)`, which first builds the pages into a folder of the script's own.
//
// http://127.0.0.1:5177/harness/ is the harness page (the panel against a fake host) and
// http://127.0.0.1:5177/harness/lab.html the render lab. A path ending in / serves that
// folder's index.html when it has one.

import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildHarness } from '../esbuild.mjs';

const dist = path.join(import.meta.dirname, '..', 'dist');

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.wav': 'audio/wav',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function send(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

async function handle(root, request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, 'Only GET and HEAD.');
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
  } catch {
    return send(response, 400, 'Bad address.');
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.normalize(path.join(root, pathname));
  if (file !== root && !file.startsWith(root + path.sep)) return send(response, 403, 'Outside the folder served.');
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      response.writeHead(302, { Location: `${pathname}/`, 'Cache-Control': 'no-store' });
      return response.end();
    }
    const body = await readFile(file);
    const type = types[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    send(response, 200, request.method === 'HEAD' ? undefined : body, type);
  } catch {
    send(response, 404, `Not found: ${pathname}. Build first: node esbuild.mjs --harness`);
  }
}

/** Starts the server for `root`. Resolves with its base address and a function that stops it. */
export function serve({ port = 5177, root = dist } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      handle(root, request, response).catch(() => send(response, 500, 'Server error.'));
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({
        url: `http://127.0.0.1:${actual}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * Builds the panel and the harness pages into dist/specs/<name>/, then serves that folder on a
 * free port. Two scripts with different names can run at once: neither writes what the other reads.
 */
export async function serveOwnBuild(name) {
  const root = path.join(dist, 'specs', name);
  await buildHarness(root);
  return serve({ port: 0, root });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv.indexOf('--port');
  const port = flag >= 0 ? Number(process.argv[flag + 1]) : 5177;
  if (!Number.isInteger(port) || port < 0) {
    console.error('Give --port a number, for example --port 5177.');
    process.exit(1);
  }
  const { url } = await serve({ port });
  console.log(`Serving dist/ at ${url}`);
  console.log(`  Harness page: ${url}harness/`);
  console.log(`  Render lab:   ${url}harness/lab.html`);
}
