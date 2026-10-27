import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { freshHome, run } from './helpers.js';

const BUILD_RULES = [process.execPath, '--import', 'tsx', 'tools/build-rules.ts'] as const;
const VOCABULARY = 'argent astra-implementer astra-reviewer codex fable-5 gh-stack gpt-6-astra gpt-6-luna gpt-6.1-sol gpt-6.1-terra haiku-5.5 opus-5.5 opus-implementer researcher reviewer runner sol-implementer sonnet-5.5 ui-runner\n';

function fixture(t: TestContext, files: Record<string, string> = {}) {
  const home = freshHome(t);
  const src = path.join(home, 'src');
  const out = path.join(home, 'out');
  mkdirSync(src);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(src, name), text);
  return { home, src, out, build: (...args: string[]) => run(home, BUILD_RULES, '--src', src, '--out', out, ...args) };
}

test('build-rules vocabulary is sorted and bypasses feature validation and output creation', (t) => {
  const { home, out } = fixture(t);
  const result = run(home, BUILD_RULES, '--vocabulary', '--features', 'unknown');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, VOCABULARY);
  assert.equal(result.stderr, '');
  assert.equal(existsSync(out), false);
});

test('build-rules gates whole files, retains frontmatter, and reports sorted skipped names', (t) => {
  const kept = '---\npaths: src/**\nneeds: argent, runner\n---\nKeep me\n';
  const { build, out } = fixture(t, {
    'z.md': '---\nneeds: codex\n---\nCodex\n',
    'a.md': '---\nneeds: gh-stack\n---\nStack\n',
    'kept.md': kept,
    'ignored.txt': 'Not markdown',
    '.hidden.md': 'Hidden\n',
  });
  const result = build('--features', ' argent,runner,argent, ,');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'rules    not written: a.md, z.md\n');
  assert.equal(result.stderr, '');
  assert.deepEqual(readdirSync(out).sort(), ['.hidden.md', 'kept.md']);
  assert.equal(readFileSync(path.join(out, 'kept.md'), 'utf8'), kept);
  assert.equal(readFileSync(path.join(out, '.hidden.md'), 'utf8'), 'Hidden\n');
});

test('build-rules filters nested blocks and normalizes blank runs and final whitespace', (t) => {
  const { build, out } = fixture(t, { 'nested.md': 'Start\n\n\n<!-- needs: argent -->\nOuter\n<!-- needs: runner -->\nInner\n<!-- /needs -->\nAfter inner\n<!-- /needs -->\n\n\nEnd  \n\n' });
  const result = build('--features=argent');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(readFileSync(path.join(out, 'nested.md'), 'utf8'), 'Start\n\nOuter\nAfter inner\n\nEnd\n');
});

test('build-rules suppresses a satisfied inner block when its parent is absent', (t) => {
  const { build, out } = fixture(t, { 'nested.md': 'Before\n<!-- needs: argent -->\nOuter\n<!-- needs: runner -->\nInner\n<!-- /needs -->\n<!-- /needs -->\nAfter' });
  const result = build('--features', 'runner');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(path.join(out, 'nested.md'), 'utf8'), 'Before\nAfter\n');
});

test('build-rules requires codex for every codex-only model', (t) => {
  const models = ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra'];
  const { build, out } = fixture(t, Object.fromEntries(models.map((model) => [`${model}.md`, `---\nneeds: ${model}\n---\n${model}\n`])));
  const absent = build('--features', models.join(','));
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(absent.stdout, 'rules    not written: gpt-6-astra.md, gpt-6-luna.md, gpt-6.1-sol.md, gpt-6.1-terra.md\n');
  assert.deepEqual(readdirSync(out), []);
  const present = build('--features', [...models, 'codex'].join(','));
  assert.equal(present.status, 0, present.stderr);
  assert.equal(present.stdout, '');
  assert.equal(readdirSync(out).length, 4);
});

test('build-rules replaces output symlinks without changing their sources', (t) => {
  const { build, src, out } = fixture(t, { 'rule.md': 'Text\n\n\n' });
  mkdirSync(out);
  symlinkSync(path.join(src, 'rule.md'), path.join(out, 'rule.md'));
  const result = build();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(lstatSync(path.join(out, 'rule.md')).isSymbolicLink(), false);
  assert.equal(readFileSync(path.join(out, 'rule.md'), 'utf8'), 'Text\n');
  assert.equal(readFileSync(path.join(src, 'rule.md'), 'utf8'), 'Text\n\n\n');
});

test('build-rules replaces dangling symlinks and keeps unrelated or skipped output files', (t) => {
  const { build, home, out } = fixture(t, { 'rule.md': 'New', 'skip.md': '---\nneeds: argent\n---\nSkip' });
  mkdirSync(out);
  symlinkSync(path.join(home, 'missing'), path.join(out, 'rule.md'));
  writeFileSync(path.join(out, 'skip.md'), 'Old');
  writeFileSync(path.join(out, 'unrelated.md'), 'Local');
  assert.equal(build().status, 0);
  assert.equal(readFileSync(path.join(out, 'rule.md'), 'utf8'), 'New\n');
  assert.equal(readFileSync(path.join(out, 'skip.md'), 'utf8'), 'Old');
  assert.equal(readFileSync(path.join(out, 'unrelated.md'), 'utf8'), 'Local');
});

test('build-rules normalizes universal newlines and retains indented markers literally', (t) => {
  const { build, out } = fixture(t, { 'rule.md': 'A\r\n  <!-- needs: argent -->\rB\r\n  <!-- /needs -->\r\n' });
  assert.equal(build().status, 0);
  assert.equal(readFileSync(path.join(out, 'rule.md'), 'utf8'), 'A\n  <!-- needs: argent -->\nB\n  <!-- /needs -->\n');
});

test('build-rules writes a newline for empty content and ignores nested directories', (t) => {
  const { build, src, out } = fixture(t, { 'empty.md': '' });
  mkdirSync(path.join(src, 'nested'));
  writeFileSync(path.join(src, 'nested/deep.md'), 'Nested');
  assert.equal(build().status, 0);
  assert.deepEqual(readdirSync(out), ['empty.md']);
  assert.equal(readFileSync(path.join(out, 'empty.md'), 'utf8'), '\n');
});

test('build-rules rejects unknown features before creating output', (t) => {
  const { build, out } = fixture(t);
  const result = build('--features', 'zzz,aaa,zzz');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'unknown feature(s): aaa, zzz\n');
  assert.equal(existsSync(out), false);
});

for (const [name, content, error] of [
  ['unmatched closing marker', '<!-- /needs -->\n', 'closing marker without an opening one'],
  ['unclosed opening marker', '<!-- needs: argent -->\nText\n', 'unclosed block marker'],
] as const) {
  test(`build-rules rejects ${name}`, (t) => {
    const { build, out } = fixture(t, { 'broken.md': content });
    const result = build();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.endsWith(`ValueError: ${error}\n`), result.stderr);
    assert.equal(existsSync(path.join(out, 'broken.md')), false);
  });
}

test('build-rules skips malformed blocks inside a gated-out file', (t) => {
  const { build } = fixture(t, { 'skip.md': '---\nneeds: argent\n---\n<!-- /needs -->\n' });
  const result = build();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'rules    not written: skip.md\n');
});

test('build-rules creates an empty output directory for a missing source', (t) => {
  const { home, out } = fixture(t);
  const result = run(home, BUILD_RULES, '--src', path.join(home, 'missing'), '--out', out);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.deepEqual(readdirSync(out), []);
});

test('build-rules rejects unknown CLI options and missing option values with exit 2', (t) => {
  const { home } = fixture(t);
  for (const [args, message] of [
    [['--unknown'], 'unrecognized arguments: --unknown'],
    [['--src'], 'argument --src: expected one argument'],
    [['--vocabulary=yes'], 'argument --vocabulary: ignored explicit argument "yes"'],
  ] as const) {
    const result = run(home, BUILD_RULES, ...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes(message), result.stderr);
  }
});

test('build-rules supports argparse option abbreviations and help', (t) => {
  const { home } = fixture(t);
  const vocabulary = run(home, BUILD_RULES, '--voc');
  assert.equal(vocabulary.status, 0, vocabulary.stderr);
  assert.equal(vocabulary.stdout, VOCABULARY);
  const help = run(home, BUILD_RULES, '--help');
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stderr, '');
  for (const flag of ['--src SRC', '--out OUT', '--features FEATURES', '--vocabulary', '-h, --help']) assert.ok(help.stdout.includes(flag));
});

test('build-rules help names the TypeScript program', (t) => {
  const { home } = fixture(t);
  const help = run(home, BUILD_RULES, '--help');
  assert.ok(help.stdout.startsWith('usage: build-rules.ts '), help.stdout);
});

test('build-rules requires --out', (t) => {
  const home = freshHome(t);
  const result = run(home, BUILD_RULES);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '--out is required\n');
});
