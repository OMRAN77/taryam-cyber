// Vercel Serverless Function: simple TCP connect-scan of common ports.
// Intended ONLY for systems the user owns or is explicitly authorized to test.
// This performs a lightweight, low-noise scan (common ports, short timeout,
// no banner-grabbing exploitation) — informational use only.
const net = require('net');

const COMMON_PORTS = [
  { port: 21, service: 'FTP' },
  { port: 22, service: 'SSH' },
  { port: 23, service: 'Telnet' },
  { port: 25, service: 'SMTP' },
  { port: 53, service: 'DNS' },
  { port: 80, service: 'HTTP' },
  { port: 110, service: 'POP3' },
  { port: 143, service: 'IMAP' },
  { port: 443, service: 'HTTPS' },
  { port: 587, service: 'SMTP (submission)' },
  { port: 3306, service: 'MySQL' },
  { port: 3389, service: 'RDP' },
  { port: 5432, service: 'PostgreSQL' },
  { port: 6379, service: 'Redis' },
  { port: 8080, service: 'HTTP-alt' },
  { port: 27017, service: 'MongoDB' },
];

function checkPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve('open');
    });
    socket.on('timeout', () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve('filtered/closed');
    });
    socket.on('error', () => {
      if (settled) return;
      settled = true;
      resolve('closed');
    });
    socket.connect(port, host);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    let body = req.body;
    if (!body || typeof body === 'string') body = JSON.parse(body || '{}');
    const { host } = body;
    if (!host || typeof host !== 'string') {
      res.status(400).json({ error: 'Missing host' });
      return;
    }
    // Basic sanity: strip protocol/path, only allow hostname/IP characters.
    const cleanHost = host.replace(/^https?:\/\//, '').split('/')[0].trim();
    if (!/^[a-zA-Z0-9.-]{1,255}$/.test(cleanHost)) {
      res.status(400).json({ error: 'Invalid host format' });
      return;
    }
    // Block localhost / private ranges from being scanned via this shared public tool.
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0)/.test(cleanHost)) {
      res.status(400).json({ error: 'Local/private addresses are not allowed via this shared tool' });
      return;
    }

    const results = await Promise.all(
      COMMON_PORTS.map(async (p) => {
        const status = await checkPort(cleanHost, p.port, 1200);
        return { port: p.port, service: p.service, status };
      })
    );

    res.status(200).json({ host: cleanHost, results });
  } catch (e) {
    res.status(500).json({ error: 'Scan error: ' + (e && e.message ? e.message : String(e)) });
  }
};
