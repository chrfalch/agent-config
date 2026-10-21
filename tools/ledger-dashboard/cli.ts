import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, fchmodSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { openLedgers } from './ledgers.js';
import { newKey, startServer } from './server.js';

const USAGE = [
  'usage: cc-ledger-dashboard [start] [--port N]   start the dashboard in the background, or show the one that runs',
  '       cc-ledger-dashboard stop                 stop it',
  '       cc-ledger-dashboard --foreground [--port N]',
].join('\n');

const STATE_FILE = path.join(homedir(), '.claude', 'ledger-dashboard.json');
const LOG_FILE = path.join(homedir(), '.claude', 'ledger-dashboard.log');
const LOCK_FILE = path.join(homedir(), '.claude', 'ledger-dashboard.lock');
const START_TIMEOUT_MS = 20_000;
// A start holds the lock while it waits for its server, so a lock much older than that belongs to a start that hangs.
const LOCK_STALE_MS = 3 * START_TIMEOUT_MS;

type Recorded = { pid: number; port: number; key: string; url: string; started: string };
type Command = { kind: 'start' | 'foreground'; port: number } | { kind: 'stop' };

export function parseArgs(argv: string[]): Command | null {
  let command: 'start' | 'stop' | undefined;
  let foreground = false;
  let port: number | undefined;
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index];
    if (word === '--foreground') foreground = true;
    else if (word === '--port') {
      const value = argv[++index] ?? '';
      if (!/^\d+$/.test(value) || Number(value) > 65535) return null;
      port = Number(value);
    } else if ((word === 'start' || word === 'stop') && command === undefined) command = word;
    else return null;
  }
  if (command === 'stop') return foreground || port !== undefined ? null : { kind: 'stop' };
  return { kind: foreground ? 'foreground' : 'start', port: port ?? 0 };
}

function readRecord(): Recorded | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { pid, port, key, url, started }: Record<string, unknown> = { ...value };
  const valid = typeof pid === 'number' && typeof port === 'number' && typeof key === 'string' && typeof url === 'string' && typeof started === 'string';
  return valid ? { pid, port, key, url, started } : null;
}

// Written whole and renamed into place, and readable only by its owner, because it holds the key.
function writeRecord(record: Recorded): void {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const temporary = `${STATE_FILE}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, STATE_FILE);
}

const hasCode = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, 'EPERM');
  }
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function claimLock(token: string): boolean {
  try {
    writeFileSync(LOCK_FILE, token, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return false;
    throw error;
  }
}

function removeStaleLock(): void {
  const held = readText(LOCK_FILE);
  if (held === null) return;
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(LOCK_FILE).mtimeMs;
  } catch {
    return;
  }
  const holder = Number.parseInt(held, 10);
  const isStale = (holder > 0 && !isAlive(holder)) || ageMs > LOCK_STALE_MS;
  // Read again just before removing, so a lock that another start took meanwhile stays.
  if (isStale && readText(LOCK_FILE) === held) rmSync(LOCK_FILE, { force: true });
}

const lockToken = (): string => `${process.pid} ${randomUUID()}\n`;

function releaseLock(token: string): void {
  if (readText(LOCK_FILE) === token) rmSync(LOCK_FILE, { force: true });
}

/** Runs `then` while no other start can, so two starts at once do not both spawn a server. */
async function whileLocked<T>(then: () => Promise<T>): Promise<T> {
  mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  const token = lockToken();
  const deadline = Date.now() + LOCK_STALE_MS + START_TIMEOUT_MS;
  while (!claimLock(token)) {
    if (Date.now() > deadline) throw new Error(`another start still holds ${LOCK_FILE}. Remove that file if no cc-ledger-dashboard runs.`);
    removeStaleLock();
    await sleep(100);
  }
  try {
    return await then();
  } finally {
    releaseLock(token);
  }
}

/** Whether the recorded server answers with its key and its pid; a pid alone may since belong to another process. */
function answers({ port, key, pid }: Recorded): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { 'x-ledger-key': key }, timeout: 2000 }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => (text += chunk));
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 && (JSON.parse(text) as { pid?: unknown }).pid === pid);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function running(): Promise<Recorded | null> {
  const record = readRecord();
  return record !== null && isAlive(record.pid) && (await answers(record)) ? record : null;
}

const alreadyRunning = (record: Recorded): string => `The ledger dashboard is already running: ${record.url}`;

async function serveInForeground(port: number): Promise<number> {
  const current = await running();
  if (current !== null) {
    console.log(alreadyRunning(current));
    return 0;
  }
  const key = newKey();
  const server = await startServer({ ledgers: await openLedgers(), key, port });
  const { port: bound } = server.address() as AddressInfo;
  const record: Recorded = { pid: process.pid, port: bound, key, url: `http://127.0.0.1:${bound}/#key=${key}`, started: new Date().toISOString() };
  writeRecord(record);
  const stop = (): void => {
    forgetRecordIfNoStartRuns(process.pid);
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.log(`Ledger dashboard: ${record.url}`);
  return 0;
}

async function waitForServer(child: ChildProcess): Promise<Recorded | { error: string }> {
  let exit: string | null = null;
  child.once('exit', (code, signal) => (exit = signal ?? `exit ${code}`));
  child.once('error', error => (exit = error.message));
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // A server started meanwhile with --foreground makes the new one exit without serving.
    if (exit !== null) return (await running()) ?? { error: `the server stopped (${exit}) before it answered. See ${LOG_FILE}.` };
    const record = readRecord();
    if (record !== null && record.pid === child.pid && (await answers(record))) return record;
    await sleep(100);
  }
  child.kill();
  return { error: `the server did not answer within ${START_TIMEOUT_MS / 1000} s. See ${LOG_FILE}.` };
}

const start = (port: number, launcher: string): Promise<number> => whileLocked(() => startUnlessRunning(port, launcher));

async function startUnlessRunning(port: number, launcher: string): Promise<number> {
  const current = await running();
  if (current !== null) {
    console.log(alreadyRunning(current));
    return 0;
  }
  mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  // Owner-only, because the server writes its address, key included, to this log. The mode given to
  // openSync applies only to a file it creates.
  const log = openSync(LOG_FILE, 'w', 0o600);
  fchmodSync(log, 0o600);
  // Detached into its own process group, so it outlives this process and the Claude Code session that ran it.
  // No stdio is shared with this process, so whoever waits for this process's output is not kept waiting by the server.
  const child = spawn(process.execPath, [launcher, '--foreground', '--port', String(port)], { detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  child.unref();
  const started = await waitForServer(child);
  if ('error' in started) {
    console.error(`cc-ledger-dashboard: ${started.error}`);
    return 1;
  }
  console.log(`Ledger dashboard: ${started.url}`);
  console.log('Open that address in a browser. It holds the access key, which changes each time the dashboard starts.');
  console.log('The dashboard keeps running after this session ends. Stop it with /ledger:dashboard stop.');
  return 0;
}

const commandOf = (pid: number): string => spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout?.trim() ?? '';

function isDashboard(command: string): boolean {
  const words = command.split(/\s+/);
  return words.some(word => path.basename(word) === 'cc-ledger-dashboard') && words.includes('--foreground');
}

// Only while it names this pid: a server started meanwhile has written its own record.
function forgetRecord(pid: number): void {
  if (readRecord()?.pid === pid) rmSync(STATE_FILE, { force: true });
}

// Under the start lock, because a start holds it until its server has published a record, and that record could
// otherwise land between forgetRecord's check and its removal. False, with the record left, while a live start holds it.
function forgetRecordIfNoStartRuns(pid: number): boolean {
  const token = lockToken();
  if (!claimLock(token)) {
    removeStaleLock();
    if (!claimLock(token)) return false;
  }
  try {
    forgetRecord(pid);
    return true;
  } finally {
    releaseLock(token);
  }
}

async function waitForExit(pid: number): Promise<void> {
  for (let waited = 0; isAlive(pid) && waited < 5000; waited += 100) await sleep(100);
}

const LEFT_FOR_START = `Left ${STATE_FILE} in place, because a start that is running holds ${LOCK_FILE}.`;

async function stop(): Promise<number> {
  const record = readRecord();
  if (record === null) {
    console.log('No ledger dashboard is running.');
    return 0;
  }
  const { pid } = record;
  if (!isAlive(pid)) {
    const forgot = forgetRecordIfNoStartRuns(pid);
    console.log(`No ledger dashboard is running. ${forgot ? `Removed the old record in ${STATE_FILE}.` : LEFT_FOR_START}`);
    return 0;
  }
  // By its command line, because a server that hangs does not answer, and its pid may since belong to another process.
  const command = commandOf(pid);
  if (!isDashboard(command)) {
    const runs = command === '' ? 'ps shows no command for it' : `it runs ${command}`;
    console.log(`Stopped nothing: ${STATE_FILE} names process ${pid}, but ${runs}, not the ledger dashboard. The record stays; remove it if no dashboard runs.`);
    return 0;
  }
  process.kill(pid, 'SIGTERM');
  await waitForExit(pid);
  // Checked again, because the server may have exited while it waited and its pid gone to another process.
  const after = isAlive(pid) ? commandOf(pid) : '';
  if (isDashboard(after)) {
    process.kill(pid, 'SIGKILL');
    // So the server is gone when stop says so: the kernel takes milliseconds to tear down a node process.
    await waitForExit(pid);
    if (isAlive(pid)) {
      console.error(`cc-ledger-dashboard: process ${pid} still runs after SIGTERM and SIGKILL, so the ledger dashboard may not have stopped. ${STATE_FILE} stays.`);
      return 1;
    }
  }
  const forgot = forgetRecordIfNoStartRuns(pid);
  const reused = after === '' || isDashboard(after) ? '' : ` Process ${pid} now runs ${after}, not the dashboard, so it was left running.`;
  console.log(`Stopped the ledger dashboard (pid ${pid}).${reused}${forgot ? '' : ` ${LEFT_FOR_START}`}`);
  return 0;
}

export async function main(argv: string[], { launcher }: { launcher: string }): Promise<number> {
  const command = parseArgs(argv);
  if (command === null) {
    console.error(USAGE);
    return 1;
  }
  if (command.kind === 'stop') return stop();
  return command.kind === 'foreground' ? serveInForeground(command.port) : start(command.port, launcher);
}
