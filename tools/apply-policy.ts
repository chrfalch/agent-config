import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { isMain, parseArguments } from './cli.js';
import { compareCodePoints, PYTHON_WHITESPACE, splitLinesKeepingEnds } from './pycompat.js';
import {
  dumpPythonJson,
  jsonEqual,
  JsonObject,
  parsePythonJson,
  type JsonValue,
} from './python-json.js';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOME = os.homedir();

function readText(filename: string): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    .decode(readFileSync(filename))
    .replace(/\r\n?/g, '\n');
}

function lstrip(value: string): string {
  return value.replace(new RegExp(`^${PYTHON_WHITESPACE}+`), '');
}

function backup(source: string, backupDir: string): void {
  const relative = path.relative(HOME, source);
  const withinHome = relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  const destination = path.join(backupDir, withinHome ? relative : path.basename(source));
  const metadata = statSync(source);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  chmodSync(destination, metadata.mode);
  utimesSync(destination, metadata.atime, metadata.mtime);
}

function requireObject(value: JsonValue): JsonObject {
  if (!(value instanceof JsonObject)) throw new TypeError('Expected a JSON object');
  return value;
}

type MergeChild = (key: string, liveValue: JsonValue | undefined, policyValue: JsonValue) => JsonValue;

const takePolicy: MergeChild = (_key, _liveValue, policyValue) => policyValue;

// Earlier deploys wrote these events as inline scripts, so they are replaced
// whole rather than merged entry by entry.
const ASSERTED_HOOK_EVENTS = new Set(['PreCompact', 'SessionStart']);

// Entries an earlier policy wrote that the current one no longer writes
// identically. When a hook entry is changed, renamed or removed, add its old
// form here, or upgraded settings keep it beside the new one.
const RETIRED_HOOK_ENTRIES = new Map<string, JsonValue[]>(
  Object.entries({
    PreToolUse: [
      // ada53e6
      { matcher: 'Bash', hooks: [{ type: 'command', command: '"$HOME"/.claude/hooks/derived-data-gate.sh' }] },
    ],
  }).map(([event, entries]) => [event, entries.map((entry) => parsePythonJson(JSON.stringify(entry)))]),
);

const mergeHookEvent: MergeChild = (event, liveEntries, policyEntries) => {
  if (ASSERTED_HOOK_EVENTS.has(event) || !Array.isArray(liveEntries) || !Array.isArray(policyEntries)) {
    return policyEntries;
  }
  const owned = [...policyEntries, ...(RETIRED_HOOK_ENTRIES.get(event) ?? [])];
  const isOwned = (entry: JsonValue): boolean => owned.some((ownedEntry) => jsonEqual(entry, ownedEntry));
  return [...liveEntries.filter((entry) => !isOwned(entry)), ...policyEntries];
};

function mergeKey(
  liveValue: JsonValue | undefined,
  policyValue: JsonValue,
  mergeChild = takePolicy,
): [JsonValue, string[], string[]] {
  if (!(liveValue instanceof JsonObject && policyValue instanceof JsonObject)) {
    return [policyValue, jsonEqual(liveValue, policyValue) ? [] : [''], []];
  }
  const merged = new JsonObject();
  for (const [key, value] of liveValue.entries) merged.entries.set(key, value);
  const changed: string[] = [];
  for (const [key, value] of policyValue.entries) {
    const mergedValue = mergeChild(key, merged.entries.get(key), value);
    if (!jsonEqual(merged.entries.get(key), mergedValue)) changed.push(key);
    merged.entries.set(key, mergedValue);
  }
  const kept = [...liveValue.entries.keys()].filter((key) => !policyValue.entries.has(key));
  return [merged, changed, kept];
}

function pythonSort(values: string[]): string[] {
  return values.sort(compareCodePoints);
}

export function applyJson(
  policyPath: string,
  target: string,
  backupDir: string,
  dry = false,
): [string[], string[]] {
  const policy = requireObject(parsePythonJson(readText(policyPath)));
  if (!existsSync(target)) {
    if (!dry) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `${dumpPythonJson(policy)}\n`);
    }
    return [pythonSort([...policy.entries.keys()]), []];
  }
  const live = requireObject(parsePythonJson(readText(target)));
  const merged = new JsonObject();
  for (const [key, value] of live.entries) merged.entries.set(key, value);
  const changed: string[] = [];
  const kept: string[] = [];
  for (const [key, value] of policy.entries) {
    const [newValue, subChanged, subKept] = mergeKey(
      live.entries.get(key),
      value,
      key === 'hooks' ? mergeHookEvent : takePolicy,
    );
    merged.entries.set(key, newValue);
    changed.push(...subChanged.map((subkey) => (subkey === '' ? key : `${key}.${subkey}`)));
    kept.push(...subKept.map((subkey) => `${key}.${subkey}`));
  }
  kept.push(...[...live.entries.keys()].filter((key) => !policy.entries.has(key)));
  if (changed.length === 0) return [[], pythonSort(kept)];
  if (!dry) {
    backup(target, backupDir);
    writeFileSync(target, `${dumpPythonJson(merged)}\n`);
  }
  return [pythonSort(changed), pythonSort(kept)];
}

function setTomlKey(lines: string[], key: string, rawValue: string): boolean {
  const found = lines.findIndex((line) => line.startsWith('['));
  const firstTable = found === -1 ? lines.length : found;
  for (let index = 0; index < firstTable; index++) {
    const stripped = lstrip(lines[index]!);
    if (stripped.startsWith(key) && lstrip(stripped.slice(key.length)).startsWith('=')) {
      const replacement = `${key} = ${rawValue}\n`;
      if (lines[index] === replacement) return false;
      lines[index] = replacement;
      return true;
    }
  }
  lines.splice(firstTable, 0, `${key} = ${rawValue}\n`);
  if (firstTable + 1 < lines.length && lines[firstTable + 1]!.startsWith('[')) {
    lines.splice(firstTable + 1, 0, '\n');
  }
  return true;
}

export function applyToml(
  policyPath: string,
  target: string,
  backupDir: string,
  dry = false,
): [string[] | null, number | null] {
  const policy: unknown = parseToml(readText(policyPath), { integersAsBigInt: true });
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    throw new TypeError('Expected a TOML table');
  }
  const flat = Object.entries(policy).filter((entry) => {
    const value: unknown = entry[1];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return true;
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype !== Object.prototype && prototype !== null;
  });
  if (!existsSync(target)) return [null, null];
  const lines = splitLinesKeepingEnds(readText(target));
  const changed = flat
    .filter(([key, value]) => setTomlKey(lines, key, dumpPythonJson(value, false)))
    .map(([key]) => key);
  const tables = lines.filter((line) => line.startsWith('[')).length;
  if (changed.length === 0) return [[], tables];
  const updated = lines.join('');
  parseToml(updated, { integersAsBigInt: true });
  if (!dry) {
    backup(target, backupDir);
    writeFileSync(target, updated);
  }
  return [changed, tables];
}

function applyPolicy({ backupDir, dry = false, noCodex = false, codex = false }: { backupDir: string; dry?: boolean; noCodex?: boolean; codex?: boolean }): number {
  const verb = dry ? 'would apply' : 'applied';
  const [changed, untouched] = applyJson(
    path.join(REPO, 'settings.policy.json'),
    path.join(HOME, '.claude/settings.json'),
    backupDir,
    dry,
  );
  console.log(`claude   policy keys ${verb}: ${changed.length > 0 ? changed.join(', ') : 'already current'}`);
  if (untouched.length > 0) console.log(`         left alone: ${untouched.join(', ')}`);

  const target = path.join(HOME, '.codex/config.toml');
  if (noCodex) {
    console.log('codex    skipped (--no-codex)');
    return 0;
  }
  if (!existsSync(target)) {
    if (codex) {
      console.error(`codex    ERROR: ${target} not found`);
      return 1;
    }
    console.log('codex    skipped (no ~/.codex/config.toml; pass --codex to require it)');
    return 0;
  }
  const [codexChanged, tables] = applyToml(path.join(REPO, 'codex/policy.toml'), target, backupDir, dry);
  console.log(
    `codex    policy keys ${verb}: ${codexChanged !== null && codexChanged.length > 0 ? codexChanged.join(', ') : 'already current'}`,
  );
  console.log(`         left alone: ${tables} tables of local state (projects, plugins, mcp_servers)`);
  return 0;
}

function main(): number {
  const args = parseArguments([
    { name: '--backup-dir', value: 'BACKUP_DIR', required: true },
    { name: '--no-codex' },
    { name: '--codex', help: 'fail if Codex is absent' },
    { name: '--dry-run', help: 'report changes, write nothing' },
  ]);
  const backupDir = args['--backup-dir'];
  if (typeof backupDir !== 'string') throw new TypeError('--backup-dir must be a string');
  return applyPolicy({
    backupDir,
    dry: args['--dry-run'] === true,
    noCodex: args['--no-codex'] === true,
    codex: args['--codex'] === true,
  });
}

if (isMain(import.meta.url)) {
  process.exitCode = main();
}
