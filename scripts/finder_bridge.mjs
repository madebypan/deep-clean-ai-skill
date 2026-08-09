#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const host = '127.0.0.1';
const port = Number(process.env.AUDIT_PORT || 43177);
const directory = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(directory, 'index.html');

if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('AUDIT_PORT must be an integer from 1024 to 65535.');
if (!existsSync(indexPath)) throw new Error(`Missing report: ${indexPath}`);

function parseAudit(html) {
  const dataMatch = html.match(/<script id="auditData" type="application\/json">([\s\S]*?)<\/script>/);
  if (!dataMatch) throw new Error('The generated report does not contain embedded audit data.');
  return JSON.parse(dataMatch[1]);
}

const initialHtml = readFileSync(indexPath, 'utf8');
const audit = parseAudit(initialHtml);
const allowlist = new Map((audit.candidates || []).map((candidate) => [candidate.id, candidate]));
const bridgeToken = randomBytes(24).toString('base64url');
const tokenMarker = '<meta name="bridge-token" content="">';
if (!initialHtml.includes(tokenMarker)) throw new Error('The generated report does not contain the bridge token marker.');
const expectedHost = `${host}:${port}`;
const expectedOrigin = `http://${expectedHost}`;

function currentReportHtml() {
  const html = readFileSync(indexPath, 'utf8');
  if (!html.includes(tokenMarker)) throw new Error('The generated report does not contain the bridge token marker.');
  const currentAudit = parseAudit(html);
  const currentCandidates = Array.isArray(currentAudit.candidates) ? currentAudit.candidates : [];
  if (currentCandidates.length !== allowlist.size || currentCandidates.some((candidate) => allowlist.get(candidate.id)?.path !== candidate.path)) {
    throw new Error('The report scan data changed. Restart the Finder bridge before using the updated report.');
  }
  return html.replace(tokenMarker, `<meta name="bridge-token" content="${bridgeToken}">`);
}

function headers(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
  };
}

function send(response, status, body, contentType = 'application/json; charset=utf-8') {
  response.writeHead(status, headers(contentType));
  response.end(body);
}

function isLocal(request) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 4096) {
        reject(new Error('Request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    request.on('error', reject);
  });
}

const server = createServer(async (request, response) => {
  if (!isLocal(request)) return send(response, 403, JSON.stringify({ ok: false, error: 'Local requests only' }));
  if (request.headers.host !== expectedHost) return send(response, 403, JSON.stringify({ ok: false, error: 'Invalid Host' }));

  const url = new URL(request.url || '/', `http://${host}:${port}`);
  if (request.method === 'GET' && url.pathname === '/') {
    try { return send(response, 200, currentReportHtml(), 'text/html; charset=utf-8'); }
    catch (error) { return send(response, 409, error.message, 'text/plain; charset=utf-8'); }
  }
  if (request.method === 'GET' && url.pathname === '/health') {
    return send(response, 200, JSON.stringify({ ok: true, mode: 'finder-reveal-only', candidates: allowlist.size }));
  }
  if (request.method !== 'POST' || url.pathname !== '/reveal') {
    return send(response, 404, JSON.stringify({ ok: false, error: 'Not found' }));
  }
  if (request.headers.origin !== expectedOrigin) {
    return send(response, 403, JSON.stringify({ ok: false, error: 'Invalid Origin' }));
  }
  if (request.headers['x-audit-token'] !== bridgeToken) {
    return send(response, 403, JSON.stringify({ ok: false, error: 'Invalid bridge token' }));
  }
  if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    return send(response, 415, JSON.stringify({ ok: false, error: 'JSON required' }));
  }

  try {
    const payload = await readJson(request);
    if (typeof payload.id !== 'string' || !allowlist.has(payload.id)) {
      return send(response, 400, JSON.stringify({ ok: false, error: 'Unknown candidate ID' }));
    }
    const candidate = allowlist.get(payload.id);
    if (!existsSync(candidate.path)) {
      return send(response, 404, JSON.stringify({ ok: false, error: 'The audited item no longer exists' }));
    }
    const process = spawn('/usr/bin/open', ['-R', candidate.path], { detached: true, stdio: 'ignore' });
    process.unref();
    return send(response, 200, JSON.stringify({ ok: true, id: candidate.id }));
  } catch (error) {
    return send(response, 400, JSON.stringify({ ok: false, error: error.message }));
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') process.stderr.write(`Port ${port} is already in use. Set AUDIT_PORT to another local port.\n`);
  else process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  process.stdout.write(`Storage audit report: http://${host}:${port}/\n`);
  process.stdout.write('Finder bridge mode: reveal exact allowlisted item only. No delete, move, rename, or write API exists.\n');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
