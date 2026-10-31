import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { freshHome, REPO, run } from './helpers.js';

test('filtered deploy resolves tsx outside the repository without invoking Python', (t) => {
  const home = freshHome(t);
  const bin = path.join(home, 'bin');
  mkdirSync(bin);
  for (const name of ['python', 'python3']) {
    writeFileSync(path.join(bin, name), '#!/bin/sh\necho "Python must not run" >&2\nexit 99\n', { mode: 0o755 });
  }
  const result = spawnSync(path.join(REPO, 'bin/deploy'), ['--models', 'opus-5.5', '--no-codex', '--no-githooks'], {
    cwd: home,
    env: { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') },
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.ok(result.stdout.includes('rules    generated, not linked:'));
  assert.ok(result.stdout.includes('claude   policy keys applied:'));
  assert.ok(readFileSync(path.join(home, '.claude/rules/40-model-routing.md'), 'utf8').includes('opus-5.5'));
});

function symlinkedRepo(t: TestContext): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'ledger-link-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const link = path.join(directory, 'repo');
  symlinkSync(REPO, link);
  return link;
}

for (const args of [['--help'], ['--dry-run']]) {
  test(`bin/deploy behaves the same through a symlinked path: ${args.join(' ')}`, (t) => {
    const home = freshHome(t);
    const outcome = (deploy: string) => {
      const { status, stdout, stderr } = run(home, [deploy], ...args);
      return { status, stdout, stderr };
    };
    const direct = outcome(path.join(REPO, 'bin/deploy'));
    assert.equal(direct.status, 0, direct.stderr);
    assert.deepEqual(outcome(path.join(symlinkedRepo(t), 'bin/deploy')), direct);
  });
}

test('bin/deploy links into the repository by the path it was called through', (t) => {
  const home = freshHome(t);
  const repo = symlinkedRepo(t);
  const deploy = [path.join(repo, 'bin/deploy')] as const;
  const first = run(home, deploy);
  assert.equal(first.status, 0, first.stderr);
  const manifest = readFileSync(path.join(home, '.claude/.ledger-manifest'), 'utf8').trim().split('\n');
  const intoRepo = manifest.map((file) => readlinkSync(file)).filter((target) => !target.startsWith(home));
  assert.ok(intoRepo.length > 0);
  for (const target of intoRepo) assert.ok(target.startsWith(`${repo}/`), target);
  const second = run(home, deploy, '--dry-run');
  assert.equal(second.status, 0, second.stderr);
  assert.doesNotMatch(second.stdout, /relink/);
});

test('bin/deploy retires a CLAUDE.md symlink that points into the repository by its symlinked path', (t) => {
  const home = freshHome(t);
  const repo = symlinkedRepo(t);
  const old = path.join(home, '.claude/CLAUDE.md');
  symlinkSync(path.join(repo, 'ledger.template.md'), old);
  const result = run(home, [path.join(repo, 'bin/deploy')]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith('retire   ~/.claude/CLAUDE.md   (the contract now ships as rules)\n'), result.stdout);
  assert.equal(lstatSync(old, { throwIfNoEntry: false }), undefined);
});

test('bin/deploy --dry-run prints the same paths when HOME ends in a slash', (t) => {
  const home = freshHome(t);
  const dryRun = (homeVariable: string) => spawnSync(path.join(REPO, 'bin/deploy'), ['--dry-run'], {
    cwd: REPO,
    env: { ...process.env, HOME: homeVariable, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const plain = dryRun(home);
  assert.equal(plain.status, 0, plain.stderr);
  const slashed = dryRun(`${home}/`);
  assert.deepEqual({ status: slashed.status, stdout: slashed.stdout, stderr: slashed.stderr }, { status: 0, stdout: plain.stdout, stderr: '' });
});

test('build-rules runs its CLI through a symlinked path', (t) => {
  const home = freshHome(t);
  const result = run(home, [process.execPath, '--import', 'tsx', path.join(symlinkedRepo(t), 'tools/build-rules.ts')]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '--out is required\n');
});

// bin/deploy finds node through `#!/usr/bin/env node`, so a `node` early on PATH that
// preloads a version override makes the real runtime report `version` to the script.
function runUnderNode(home: string, version: string, ...args: string[]) {
  const bin = path.join(home, 'bin');
  mkdirSync(bin);
  const preload = path.join(bin, 'version.cjs');
  writeFileSync(preload, `Object.defineProperty(process.versions, 'node', { value: '${version}' });\n`);
  // tsx picks module.register() over module.registerHooks() from the faked version, and the real
  // Node may deprecate it (DEP0205). A real Node of the faked version prints no such warning.
  writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nexec '${process.execPath}' --disable-warning=DEP0205 --require '${preload}' "$@"\n`, { mode: 0o755 });
  return spawnSync(path.join(REPO, 'bin/deploy'), args, {
    cwd: home,
    env: { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

for (const version of ['18.19.0', '20.11.0']) {
  test(`bin/deploy rejects Node ${version} with one error`, (t) => {
    const result = runUnderNode(freshHome(t), version, '--dry-run');
    assert.deepEqual({ status: result.status, stdout: result.stdout, stderr: result.stderr }, { status: 1, stdout: '', stderr: 'deploy: Node.js >=20.12 is required\n' });
  });
}

test('bin/deploy accepts Node 20.12 and runs deploy with the forwarded arguments', (t) => {
  const result = runUnderNode(freshHome(t), '20.12.0', '--dry-run', '--no-codex');
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
  assert.ok(result.stdout.startsWith('DRY RUN -- nothing below is written.\n'), result.stdout);
  assert.ok(result.stdout.includes('\nagents   not deployed: sol-implementer astra-implementer astra-reviewer codex-runner\n'), result.stdout);
});

const install = { complete: 'holds a finished install', partial: 'lacks .package-lock.json', failing: 'lacks it and npm ci fails' } as const;

// A copy of bin/deploy in a repository whose tools/deploy.ts reports how it was run.
// The fake npm prints where and how it ran; a successful one finishes the install by
// linking the real node_modules, which the copy needs to load tsx.
function runStubRepo(home: string, state: keyof typeof install, ...args: string[]) {
  const bin = path.join(home, 'bin');
  const repo = path.join(home, 'repo with spaces');
  const modules = path.join(REPO, 'node_modules');
  mkdirSync(bin);
  mkdirSync(path.join(repo, 'bin'), { recursive: true });
  mkdirSync(path.join(repo, 'tools'));
  for (const file of ['package.json', 'bin/package.json', 'bin/deploy']) {
    writeFileSync(path.join(repo, file), readFileSync(path.join(REPO, file)), { mode: 0o755 });
  }
  writeFileSync(path.join(repo, 'tools/deploy.ts'), 'export function main(argv: string[]): void {\n  console.log([process.cwd(), process.env.DEPLOY_REPO, ...argv].join(\'\\n\'));\n}\n');
  if (state === 'complete') symlinkSync(modules, path.join(repo, 'node_modules'));
  else mkdirSync(path.join(repo, 'node_modules'));
  const finish = state === 'failing' ? 'exit 3' : `rmdir node_modules && ln -s '${modules}' node_modules`;
  writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\npwd\nprintf '%s\\n' "$@"\n${finish}\n`, { mode: 0o755 });
  const result = spawnSync(path.join(repo, 'bin/deploy'), args, {
    cwd: home,
    env: { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, repo };
}

for (const state of Object.keys(install) as (keyof typeof install)[]) {
  test(`bin/deploy ${state === 'complete' ? 'skips' : 'runs'} npm ci when node_modules ${install[state]}`, (t) => {
    const { status, stdout, stderr, repo } = runStubRepo(freshHome(t), state, '--agents', 'researcher,runner');
    const npm = `${realpathSync(repo)}\nci\n--silent\n`;
    const deployed = `${realpathSync(repo)}\n${repo}\n--agents\nresearcher,runner\n`;
    const expected = {
      complete: { status: 0, stdout: deployed, stderr: '' },
      partial: { status: 0, stdout: deployed, stderr: npm },
      failing: { status: 3, stdout: '', stderr: npm },
    }[state];
    assert.deepEqual({ status, stdout, stderr }, expected);
  });
}

function pullCheckRepo(t: TestContext, ahead = true) {
  const home = freshHome(t);
  const origin = path.join(home, 'origin.git');
  const repo = path.join(home, 'repo with spaces');
  const peer = path.join(home, 'peer');
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Deploy Test',
    GIT_AUTHOR_EMAIL: 'deploy@example.test',
    GIT_COMMITTER_NAME: 'Deploy Test',
    GIT_COMMITTER_EMAIL: 'deploy@example.test',
    DEPLOY_PULL_CHECK: '1',
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(home, 'init', '--bare', '--initial-branch=main', origin);
  git(home, 'clone', origin, repo);
  mkdirSync(path.join(repo, 'bin'));
  mkdirSync(path.join(repo, 'tools'));
  for (const file of ['package.json', 'bin/package.json', 'bin/deploy']) {
    writeFileSync(path.join(repo, file), readFileSync(path.join(REPO, file)), { mode: 0o755 });
  }
  writeFileSync(path.join(repo, 'tools/deploy.ts'), 'export function main(argv: string[]): void {\n  console.log([process.cwd(), process.env.DEPLOY_REPO, ...argv].join(\'\\n\'));\n}\n');
  symlinkSync(path.join(REPO, 'node_modules'), path.join(repo, 'node_modules'));
  git(repo, 'add', 'package.json', 'bin', 'tools');
  git(repo, 'commit', '-m', 'Initial deploy stub');
  git(repo, 'push', '-u', 'origin', 'main');
  const initialHead = git(repo, 'rev-parse', 'HEAD');
  git(home, 'clone', origin, peer);
  if (ahead) {
    writeFileSync(path.join(peer, 'remote.txt'), 'remote commit\n');
    git(peer, 'add', 'remote.txt');
    git(peer, 'commit', '-m', 'Remote commit');
    git(peer, 'push');
  }
  const deploy = (input: string, args: string[] = [], enabled = true) => {
    const result = spawnSync(path.join(repo, 'bin/deploy'), args, {
      cwd: home,
      env: { ...env, DEPLOY_PULL_CHECK: enabled ? '1' : undefined },
      input,
      encoding: 'utf8',
    });
    assert.ifError(result.error);
    return result;
  };
  const deployed = `${realpathSync(repo)}\n${repo}\n`;
  return { repo, origin, env, git, initialHead, deploy, deployed };
}

test('bin/deploy pulls new upstream commits on an empty answer', (t) => {
  const { repo, origin, git, deploy, deployed } = pullCheckRepo(t);
  const result = deploy('\n');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('origin/main has 1 new commit(s). Pull before deploying? [Y/n] '), result.stdout);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'HEAD'));
  assert.ok(result.stdout.includes(deployed), result.stdout);
});

test('bin/deploy continues without pulling when declined', (t) => {
  const { repo, git, initialHead, deploy, deployed } = pullCheckRepo(t);
  const result = deploy('n\n');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('origin/main has 1 new commit(s). Pull before deploying? [Y/n] '), result.stdout);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), initialHead);
  assert.ok(result.stdout.includes(deployed), result.stdout);
});

// An answer typed after the prompt appears finds stdin empty at first, so a non-blocking
// fd 0 fails the read with EAGAIN.
test('bin/deploy waits for an answer typed after the prompt', async (t) => {
  const { repo, env, git, initialHead, deployed } = pullCheckRepo(t);
  const child = spawn(path.join(repo, 'bin/deploy'), [], { cwd: path.dirname(repo), env });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    if (!child.stdin.writableEnded && stdout.includes('Pull before deploying? [Y/n] ')) child.stdin.end('n\n');
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const [status] = await once(child, 'close');
  assert.doesNotMatch(stderr, /EAGAIN/);
  assert.equal(status, 0, stderr);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), initialHead);
  assert.ok(stdout.includes(deployed), stdout);
});

test('bin/deploy does not prompt when upstream has no new commits', (t) => {
  const { deploy, deployed } = pullCheckRepo(t, false);
  const result = deploy('\n');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, deployed);
});

test('bin/deploy reports new upstream commits without pulling in dry run', (t) => {
  const { repo, git, initialHead, deploy, deployed } = pullCheckRepo(t);
  const result = deploy('', ['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `deploy: origin/main has 1 new commit(s) not pulled\n${deployed}--dry-run\n`);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), initialHead);
  assert.doesNotMatch(result.stdout, /Pull before deploying\?/);
});

test('bin/deploy skips upstream check with non-TTY stdin unless enabled', (t) => {
  const { repo, git, initialHead, deploy, deployed } = pullCheckRepo(t);
  const result = deploy('', [], false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, deployed);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), initialHead);
});

test('bin/deploy aborts without deploying when fast-forward pull fails', (t) => {
  const { repo, git, deploy, deployed } = pullCheckRepo(t);
  writeFileSync(path.join(repo, 'local.txt'), 'local commit\n');
  git(repo, 'add', 'local.txt');
  git(repo, 'commit', '-m', 'Local commit');
  const result = deploy('y\n');
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes('deploy: git pull --ff-only failed; nothing deployed\n'), result.stderr);
  assert.ok(!result.stdout.includes(deployed), result.stdout);
});
