import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { applyJson, applyToml } from '../tools/apply-policy.js';
import { freshHome, REPO, run } from './helpers.js';

function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'apply-policy-compat-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('JSON output retains Python key order, ASCII escaping, floats, and backup metadata', (t) => {
  const directory = temporaryDirectory(t);
  const policy = path.join(directory, 'policy.json');
  const target = path.join(directory, 'live.json');
  const backupDirectory = path.join(directory, 'backup');
  const original = '{"7":"😀","é":{"3":false},"untouched":1.0}\n';
  writeFileSync(policy, '{"é":{"10":"☃","2":1.0},"owned":true}\n');
  writeFileSync(target, original);
  chmodSync(target, 0o640);
  const timestamp = new Date('2020-02-03T04:05:06.000Z');
  utimesSync(target, timestamp, timestamp);

  const [changed, kept] = applyJson(policy, target, backupDirectory);

  assert.deepEqual(changed, ['owned', 'é.10', 'é.2']);
  assert.deepEqual(kept, ['7', 'untouched', 'é.3']);
  assert.equal(
    readFileSync(target, 'utf8'),
    '{\n  "7": "\\ud83d\\ude00",\n  "\\u00e9": {\n    "3": false,\n    "10": "\\u2603",\n    "2": 1.0\n  },\n  "untouched": 1.0,\n  "owned": true\n}\n',
  );
  const backup = path.join(backupDirectory, path.basename(target));
  assert.equal(readFileSync(backup, 'utf8'), original);
  assert.equal(statSync(backup).mode & 0o777, 0o640);
  assert.equal(statSync(backup).mtimeMs, timestamp.getTime());
});

test('JSON dry run reports changes without writing or backing up', (t) => {
  const directory = temporaryDirectory(t);
  const policy = path.join(directory, 'policy.json');
  const target = path.join(directory, 'live.json');
  const backupDirectory = path.join(directory, 'backup');
  writeFileSync(policy, '{"missing":null,"changed":2}\n');
  writeFileSync(target, '{"changed":1}\n');

  assert.deepEqual(applyJson(policy, target, backupDirectory, true), [['changed'], []]);
  assert.equal(readFileSync(target, 'utf8'), '{"changed":1}\n');
  assert.equal(existsSync(backupDirectory), false);
});

test('TOML editing is line based, normalizes newlines, and preserves local tables', (t) => {
  const directory = temporaryDirectory(t);
  const target = path.join(directory, 'config.toml');
  const backupDirectory = path.join(directory, 'backup');
  const original = '  approval_policy = "old"\r\n# keep\r\n[projects.x]\r\ntrust_level = "trusted"\r\n';
  writeFileSync(target, original);

  const [changed, tables] = applyToml(
    path.join(REPO, 'codex/policy.toml'),
    target,
    backupDirectory,
  );

  assert.deepEqual(changed, ['approval_policy', 'sandbox_mode']);
  assert.equal(tables, 1);
  assert.equal(
    readFileSync(target, 'utf8'),
    'approval_policy = "on-request"\n# keep\nsandbox_mode = "workspace-write"\n\n[projects.x]\ntrust_level = "trusted"\n',
  );
  assert.equal(readFileSync(path.join(backupDirectory, path.basename(target)), 'utf8'), original);
});

test('TOML current policy does not create a backup', (t) => {
  const directory = temporaryDirectory(t);
  const target = path.join(directory, 'config.toml');
  const backupDirectory = path.join(directory, 'backup');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    target,
    'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n[plugins.example]\nenabled = true\n',
  );

  assert.deepEqual(
    applyToml(path.join(REPO, 'codex/policy.toml'), target, backupDirectory),
    [[], 1],
  );
  assert.equal(existsSync(backupDirectory), false);
});

test('TOML preserves large local integers and inserts compact arrays with distinct numeric types', (t) => {
  const directory = temporaryDirectory(t);
  const policy = path.join(directory, 'policy.toml');
  const target = path.join(directory, 'config.toml');
  writeFileSync(policy, 'items = [1, 2.0, "é"]\n');
  writeFileSync(target, 'local = 9007199254740993\n');
  assert.deepEqual(applyToml(policy, target, path.join(directory, 'backup')), [['items'], 0]);
  assert.equal(readFileSync(target, 'utf8'), 'local = 9007199254740993\nitems = [1, 2.0, "\\u00e9"]\n');
});

test('TOML line editing follows Python splitting at Unicode separators', (t) => {
  const directory = temporaryDirectory(t);
  const target = path.join(directory, 'config.toml');
  writeFileSync(target, '# comment\u2028[table]\nx = 1\n');
  assert.deepEqual(applyToml(path.join(REPO, 'codex/policy.toml'), target, path.join(directory, 'backup')), [['approval_policy', 'sandbox_mode'], 1]);
  assert.equal(readFileSync(target, 'utf8'), '# comment\u2028approval_policy = "on-request"\n\nsandbox_mode = "workspace-write"\n\n[table]\nx = 1\n');
});

test('policy rejects invalid UTF-8 in policy or live files without changing or backing up targets', (t) => {
  const directory = temporaryDirectory(t);
  for (const extension of ['json', 'toml']) {
    for (const invalidFile of ['policy', 'live']) {
      const policy = path.join(directory, `policy.${extension}`);
      const target = path.join(directory, `live.${extension}`);
      const backupDirectory = path.join(directory, 'backup');
      const valid = extension === 'json' ? '{"key":"value"}\n' : 'key = "value"\n';
      const invalid = Buffer.concat([Buffer.from(extension === 'json' ? '{"key":"' : 'key = "'), Buffer.from([0xff]), Buffer.from(extension === 'json' ? '"}\n' : '"\n')]);
      writeFileSync(policy, invalidFile === 'policy' ? invalid : valid);
      writeFileSync(target, invalidFile === 'live' ? invalid : '{}\n');
      const before = readFileSync(target);
      const apply = extension === 'json' ? applyJson : applyToml;
      assert.throws(() => apply(policy, target, backupDirectory), /encoded data was not valid/);
      assert.deepEqual(readFileSync(target), before);
      assert.equal(existsSync(backupDirectory), false);
    }
  }
});

test('invalid TOML refuses both a real apply and dry run without mutations', (t) => {
  const directory = temporaryDirectory(t);
  const target = path.join(directory, 'config.toml');
  const backupDirectory = path.join(directory, 'backup');
  const original = '[broken\n';
  writeFileSync(target, original);
  for (const dry of [false, true]) {
    assert.throws(() => applyToml(path.join(REPO, 'codex/policy.toml'), target, backupDirectory, dry));
    assert.equal(readFileSync(target, 'utf8'), original);
    assert.equal(existsSync(backupDirectory), false);
  }
});

test('policy CLI preserves dry-run and required or skipped Codex reports', (t) => {
  const home = freshHome(t);
  const policy = JSON.parse(readFileSync(path.join(REPO, 'settings.policy.json'), 'utf8')) as Record<string, unknown>;
  const target = path.join(home, '.claude/settings.json');
  writeFileSync(target, '{}\n');
  const backupDirectory = path.join(home, 'backup');
  const command = [process.execPath, '--import', 'tsx', 'tools/apply-policy.ts'] as const;
  const claude = `claude   policy keys would apply: ${Object.keys(policy).sort().join(', ')}\n`;
  const optional = run(home, command, '--backup-dir', backupDirectory, '--dry-run');
  assert.equal(optional.status, 0, optional.stderr);
  assert.equal(optional.stdout, `${claude}codex    skipped (no ~/.codex/config.toml; pass --codex to require it)\n`);
  assert.equal(optional.stderr, '');
  const required = run(home, command, '--backup-dir', backupDirectory, '--dry-run', '--codex');
  assert.equal(required.status, 1);
  assert.equal(required.stdout, claude);
  assert.equal(required.stderr, `codex    ERROR: ${path.join(home, '.codex/config.toml')} not found\n`);
  const skipped = run(home, command, '--backup-dir', backupDirectory, '--dry-run', '--codex', '--no-codex');
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(skipped.stdout, `${claude}codex    skipped (--no-codex)\n`);
  assert.equal(readFileSync(target, 'utf8'), '{}\n');
  assert.equal(existsSync(backupDirectory), false);
});
