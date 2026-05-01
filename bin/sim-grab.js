#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bridgeDir = resolve(root, 'bridge');
const webDistDir = resolve(root, 'web', 'dist');
const bridgeEntry = resolve(bridgeDir, 'dist', 'index.js');
const captureDir = resolve(bridgeDir, 'capture');
const captureBin = resolve(captureDir, '.build', 'release', 'sim-grab-capture');
const bridgePort = process.env.PORT || '7878';
const webPort = process.env.SIM_GRAB_WEB_PORT || process.env.WEB_PORT || '7879';

function printHelp() {
  console.log(`sim-grab

Usage:
  sim-grab

Environment:
  PORT                  Bridge websocket/health port. Default: 7878
  SIM_GRAB_WEB_PORT     Browser UI port. Default: 7879
  CAPTURE=0             Disable ScreenCaptureKit and use simctl screenshots

Requirements:
  Node.js, Xcode command line tools, a booted iOS Simulator, and idb for AX/input.
`);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printHelp();
  process.exit(0);
}

if (!existsSync(bridgeEntry) || !existsSync(resolve(webDistDir, 'index.html'))) {
  console.error('[sim-grab] build artifacts are missing; run `bun run build` before starting from a checkout');
  process.exit(1);
}

console.log('[sim-grab] starting bridge and browser UI');
console.log(`[sim-grab] UI:     http://localhost:${webPort}`);
console.log(`[sim-grab] bridge: http://localhost:${bridgePort}/health`);

const children = [];
let webServer = null;
let shuttingDown = false;

await ensureCaptureHelper();

function run(label, command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      PORT: bridgePort,
      SIM_GRAB_WEB_PORT: webPort,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  pipeOutput(label, child.stdout);
  pipeOutput(label, child.stderr);

  child.on('error', (err) => {
    if (shuttingDown) return;
    console.error(`[sim-grab] ${label} failed: ${err.message}`);
    shutdown(1);
  });
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`[sim-grab] ${label} stopped (exit ${code})`);
    shutdown(code || 1);
  });

  children.push(child);
  return child;
}

function pipeOutput(label, stream) {
  stream.setEncoding('utf8');
  let pending = '';
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      if (line.length) console.log(`[${label}] ${line}`);
    }
  });
  stream.on('end', () => {
    if (pending.length) console.log(`[${label}] ${pending}`);
  });
}

async function startStaticServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const rawPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const relativePath = rawPath.replace(/^\/+/, '');
    const filePath = resolve(webDistDir, relativePath);

    if (!filePath.startsWith(webDistDir + '/') && filePath !== webDistDir) {
      res.writeHead(403).end('forbidden');
      return;
    }

    try {
      const info = await stat(filePath);
      const finalPath = info.isDirectory() ? join(filePath, 'index.html') : filePath;
      let body = await readFile(finalPath);
      const type = contentType(finalPath);
      if (finalPath.endsWith('index.html')) {
        const config = `<script>window.__SIM_GRAB_CONFIG__=${JSON.stringify({ bridgePort })}</script>`;
        body = Buffer.from(body.toString('utf8').replace('</head>', `${config}</head>`));
      }
      res.writeHead(200, {
        'content-type': type,
        'cache-control': finalPath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(Number(webPort), '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  webServer = server;
}

function contentType(path) {
  switch (extname(path)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Already exited.
    }
  }
  webServer?.close(() => {});
  setTimeout(() => process.exit(code), 150);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

await startStaticServer();
run('bridge', process.execPath, [bridgeEntry], { cwd: bridgeDir });

async function ensureCaptureHelper() {
  if (process.env.CAPTURE === '0') return;
  if (process.platform !== 'darwin') return;
  if (existsSync(captureBin)) return;
  if (!existsSync(resolve(captureDir, 'Package.swift'))) return;

  console.log('[sim-grab] building ScreenCaptureKit helper');
  try {
    const code = await runForeground('swift', ['build', '-c', 'release'], captureDir, 'capture-build');
    if (code === 0) return;
  } catch (err) {
    console.warn(`[sim-grab] could not run swift build: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.warn('[sim-grab] ScreenCaptureKit helper build failed; falling back to simctl screenshots');
}

function runForeground(command, args, cwd, label) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    pipeOutput(label, child.stdout);
    pipeOutput(label, child.stderr);
    child.on('error', rejectRun);
    child.on('exit', (code) => resolveRun(code ?? 1));
  });
}
