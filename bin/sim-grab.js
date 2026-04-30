#!/usr/bin/env bun

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bridgeDir = resolve(root, 'bridge');
const webDir = resolve(root, 'web');
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
  Bun, Xcode command line tools, a booted iOS Simulator, and idb for AX/input.
`);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  printHelp();
  process.exit(0);
}

console.log('[sim-grab] starting bridge and browser UI');
console.log(`[sim-grab] UI:     http://localhost:${webPort}`);
console.log(`[sim-grab] bridge: http://localhost:${bridgePort}/health`);

const children = [];

await ensureCaptureHelper();

function run(label, command, args, options) {
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      PORT: bridgePort,
      SIM_GRAB_WEB_PORT: webPort,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  void pipeOutput(label, child.stdout);
  void pipeOutput(label, child.stderr);

  child.exited.then((code) => {
    if (shuttingDown) return;
    console.error(`[sim-grab] ${label} stopped (exit ${code})`);
    shutdown(code || 1);
  });

  children.push(child);
  return child;
}

function prefix(label, chunk) {
  const text = chunk.toString();
  for (const line of text.split(/\r?\n/)) {
    if (line.length) console.log(`[${label}] ${line}`);
  }
}

async function pipeOutput(label, stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';
    for (const line of lines) {
      if (line.length) console.log(`[${label}] ${line}`);
    }
  }

  pending += decoder.decode();
  if (pending.length) console.log(`[${label}] ${pending}`);
}

let shuttingDown = false;
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
  setTimeout(() => process.exit(code), 150);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('bridge', 'bun', ['run', 'src/index.ts'], { cwd: bridgeDir });
run('web', 'bun', ['x', 'vite', '--host', '127.0.0.1', '--port', webPort], { cwd: webDir });

async function ensureCaptureHelper() {
  if (process.env.CAPTURE === '0') return;
  if (process.platform !== 'darwin') return;
  if (await fileExists(captureBin)) return;
  if (!(await fileExists(resolve(captureDir, 'Package.swift')))) return;

  console.log('[sim-grab] building ScreenCaptureKit helper');
  try {
    const proc = Bun.spawn(['swift', 'build', '-c', 'release'], {
      cwd: captureDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    void pipeOutput('capture-build', proc.stdout);
    void pipeOutput('capture-build', proc.stderr);
    const code = await proc.exited;
    if (code === 0) return;
  } catch (err) {
    console.warn(`[sim-grab] could not run swift build: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.warn('[sim-grab] ScreenCaptureKit helper build failed; falling back to simctl screenshots');
}

async function fileExists(path) {
  return Bun.file(path).exists();
}
