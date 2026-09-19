import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli, useTestEcosystem } from '../_fixture.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-diff-cmd-test-'));
}

function writeJson(dir: string, rel: string, data: unknown) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
}

/** A run that errors out (an already-logged error) hits cli.ts's `.fail()` handler, which calls
 *  the real `process.exit(1)` - fatal to the test runner itself, since it's the same process. */
/**
 * Runs a CLI call that is **expected to fail**, swallowing the rejection so the assertions below can
 * inspect what it printed - and failing the test if the command unexpectedly succeeds.
 *
 * This used to stub `process.exit`, because `runCli` called it from inside the library and would
 * otherwise have taken the whole test process down. The exit belongs to the bin entry alone now, so
 * a failed command is an ordinary rejected promise - and this helper can assert the failure instead
 * of merely surviving it, which the stub never did.
 */
async function expectCliFailure(fn: () => Promise<void>): Promise<void> {
  await fn().then(
    () => {
      throw new Error('expected the command to fail, but it resolved');
    },
    () => undefined,
  );
}

async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe('commands/diff', () => {
  useTestEcosystem();

  const dirs: string[] = [];
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function git(dir: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
  }

  function monorepoFixture(): string {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
     *  since it runs before the plugins that would know what a package is. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.com');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    git(dir, 'tag', 'v1.0.0');
    fs.writeFileSync(path.join(dir, 'packages/a/feature.txt'), 'new content in pkg-a');
    fs.writeFileSync(path.join(dir, 'packages/b/other.txt'), 'new content in pkg-b');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'feat: changes in both packages');
    return dir;
  }

  it('with no package given, diffs the whole repository since its last tag', async () => {
    const dir = monorepoFixture();
    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['diff'] }));
    const output = lines.join('\n');
    expect(output).toContain('packages/a/feature.txt');
    expect(output).toContain('packages/b/other.txt');
    expect(output).toContain('new content in pkg-a');
  });

  it('with a package name, scopes the diff to just that package', async () => {
    const dir = monorepoFixture();
    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['diff', 'pkg-a'] }));
    const output = lines.join('\n');
    expect(output).toContain('packages/a/feature.txt');
    expect(output).not.toContain('packages/b/other.txt');
  });

  it('running from inside a package directory scopes the diff to it, same as naming it', async () => {
    const dir = monorepoFixture();
    const lines = await captureLogs(() => runCli({ cwd: path.join(dir, 'packages/a'), argv: ['diff'] }));
    const output = lines.join('\n');
    expect(output).toContain('packages/a/feature.txt');
    expect(output).not.toContain('packages/b/other.txt');
  });

  it('prints "No changes since <tag>." when nothing changed', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.com');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    git(dir, 'tag', 'v1.0.0');

    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['diff'] }));
    expect(lines.some(l => l.includes('No changes since v1.0.0.'))).toBe(true);
  });

  it('errors clearly for an unknown package name', async () => {
    const dir = monorepoFixture();
    const lines = await captureLogs(() =>
      expectCliFailure(() => runCli({ cwd: dir, argv: ['diff', 'no-such-package'] })),
    );
    expect(lines.some(l => l.includes('No such package "no-such-package"'))).toBe(true);
  });

  it('reports no tag found when the target was never released', async () => {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.com');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');

    const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['diff'] }));
    expect(lines.some(l => l.includes('No release tag found for "pkg-a"'))).toBe(true);
  });
});
