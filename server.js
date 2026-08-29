// Minimal zero-dependency static server for local preview.
// Serves index.html, style.css, app.js, about.html, publish assets.
// Usage: node server.js [port]   (default 3000)
import http from 'http';
import { readFile } from 'fs/promises';
import { extname, join, normalize } from 'path';

const PORT = Number(process.argv[2]) || 3000;
const ROOT = process.cwd();
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') path = '/index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      // SECURITY: Prevent clickjacking
      'X-Frame-Options': 'DENY',
      // SECURITY: Prevent MIME sniffing
      'X-Content-Type-Options': 'nosniff',
      // SECURITY: XSS protection
      'X-XSS-Protection': '1; mode=block',
      // SECURITY: Referrer policy
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      // SECURITY: Permissions policy (disable camera, mic, geolocation)
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`preview server on http://127.0.0.1:${PORT}`));
