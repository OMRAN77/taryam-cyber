// Local stand-in for Vercel used by the browser tests: serves the repo's static
// files and runs api/*.js handlers in-process, unmodified. Listens on 127.0.0.1 only.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// The response headers vercel.json sets in production (e.g. the lab's CSP), so the
// browser tests run under the same policy. Only Vercel's "(.*)" wildcard is used.
function headerRules() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')); } catch (e) { return []; }
  return (cfg.headers || []).map((rule) => ({
    re: new RegExp('^' + rule.source.split('(.*)').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'),
    headers: rule.headers,
  }));
}
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.mp4': 'video/mp4', '.xml': 'application/xml', '.txt': 'text/plain',
  '.css': 'text/css', '.csv': 'text/csv', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
};

// options.extra: { '/path': 'body' } serves test-only scripts (with the headers of
// their path); options.headers === false serves without vercel.json's headers;
// options.onRequest(url) sees every request the server receives.
function startServer(options = {}) {
  const rules = options.headers === false ? [] : headerRules();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://local');
    if (options.onRequest) options.onRequest(req.method, u.pathname);
    for (const rule of rules) if (rule.re.test(u.pathname)) for (const h of rule.headers) res.setHeader(h.key, h.value);
    if (options.extra && Object.prototype.hasOwnProperty.call(options.extra, u.pathname)) {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(options.extra[u.pathname]);
      return;
    }
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return res; };
    res.send = (d) => { res.end(typeof d === 'string' || Buffer.isBuffer(d) ? d : JSON.stringify(d)); return res; };
    if (u.pathname.startsWith('/api/')) {
      const file = path.join(ROOT, 'api', u.pathname.slice(5).replace(/[^a-z0-9_-]/gi, '') + '.js');
      if (!fs.existsSync(file)) { res.statusCode = 404; res.end('{"error":"not found"}'); return; }
      let raw = '';
      for await (const c of req) raw += c;
      req.query = Object.fromEntries(u.searchParams);
      try { req.body = raw ? JSON.parse(raw) : {}; } catch (e) { req.body = raw; }
      try { await require(file)(req, res); } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
      return;
    }
    const p = path.join(ROOT, decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname));
    if (!p.startsWith(ROOT + path.sep)) { res.statusCode = 403; res.end(); return; }
    fs.readFile(p, (e, d) => {
      if (e) { res.statusCode = 404; res.end('not found'); return; }
      res.setHeader('Content-Type', TYPES[path.extname(p)] || 'application/octet-stream');
      res.end(d);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: 'http://127.0.0.1:' + server.address().port,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

module.exports = { startServer, ROOT };
