import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli } from '../../src/cli.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-changelog-cmd-test-'));
}

function writeJson(dir: string, rel: string, data: unknown) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(stripAnsi(args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
}

describe('commands/changelog', () => {
  const dirs: string[] = [];
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** A monorepo with a single package "pkg-a" holding one unreleased feature commit on top of
   *  `--from <hash>`, and a real (bare) origin with the initial commit already pushed - so the
   *  commit is genuinely "not yet pushed" for the tests further below that omit `--from` entirely,
   *  not just unreachable for lack of any upstream at all (see git.spec.ts: no upstream configured
   *  -> `listCommits()` reports nothing). A real subpackage (rather than making the repo's own
   *  root package "pkg-a") also keeps its changelog entry labeled "pkg-a" - the root package
   *  itself is always labeled "<dir name> repository", never its own package.json name (see
   *  changelog.service.spec.ts). Every other test here still passes `--from <hash>` explicitly,
   *  bypassing auto-detection (and any network access) regardless. */
  function fixtureWithOneFeature(): { dir: string; baseHash: string } {
    const dir = tmp();
    const originDir = tmp();
    fs.rmSync(originDir, { recursive: true, force: true });
    execFileSync('git', ['init', '-q', '--bare', originDir]);

    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    run('init', '-q');
    run('config', 'user.email', 't@t.com');
    run('config', 'user.name', 't');
    run('add', '-A');
    run('commit', '-q', '-m', 'init');
    const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
    run('remote', 'add', 'origin', originDir);
    run('branch', '-M', 'main');
    run('push', '-u', 'origin', 'main', '-q');

    fs.writeFileSync(path.join(dir, 'packages/a/feature.txt'), 'x');
    run('add', '-A');
    run('commit', '-q', '-m', 'feat: a shiny new feature');

    return { dir, baseHash };
  }

  describe('default (no --write)', () => {
    it("prints each entry's rendered content, not a summary line", async () => {
      const { dir, baseHash } = fixtureWithOneFeature();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--from', baseHash] }));
      const joined = lines.join('\n');
      expect(joined).toContain('## pkg-a');
      expect(joined).toContain('a shiny new feature');
      expect(lines.some(l => l.includes('updated'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'packages/a/CHANGELOG.md'))).toBe(false);
    });

    it('prints "No unreleased changes." and writes nothing when there is nothing new', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();

      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--from', baseHash] }));
      expect(lines.some(l => l.includes('No unreleased changes.'))).toBe(true);
    });
  });

  describe('--write', () => {
    it('prints "updated <label> <filePath>" per entry instead of the raw content, and writes the file', async () => {
      const { dir, baseHash } = fixtureWithOneFeature();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--from', baseHash, '--write'] }));

      expect(lines.some(l => l.includes('updated') && l.includes('pkg-a') && l.includes('CHANGELOG.md'))).toBe(true);
      expect(lines.some(l => l.includes('a shiny new feature'))).toBe(false);

      const written = fs.readFileSync(path.join(dir, 'packages/a/CHANGELOG.md'), 'utf-8');
      expect(written).toContain('a shiny new feature');
    });

    it('--file-path (kebab-case CLI flag) controls where --write prepends into', async () => {
      const { dir, baseHash } = fixtureWithOneFeature();
      await captureLogs(() =>
        runCli({ cwd: dir, argv: ['changelog', '--from', baseHash, '--write', '--file-path', 'HISTORY.md'] }),
      );
      expect(fs.existsSync(path.join(dir, 'packages/a/HISTORY.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'packages/a/CHANGELOG.md'))).toBe(false);
    });
  });

  describe('--root', () => {
    it('generates for the whole repository even when run from inside a single package', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
      const baseHash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat(pkg-a): a change');
      fs.writeFileSync(path.join(dir, 'packages/b/y.txt'), 'y');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat(pkg-b): another change');

      const lines = await captureLogs(() =>
        runCli({ cwd: path.join(dir, 'packages/a'), argv: ['changelog', '--from', baseHash, '--root'] }),
      );
      const joined = lines.join('\n');
      expect(joined).toContain('## pkg-a');
      expect(joined).toContain('## pkg-b');
    });
  });

  describe('auto-detect narration ("--from" omitted)', () => {
    /** Shims a fake `npm` binary onto PATH for the duration of `fn()` - `defaultNpmViewVersion`
     *  shells out to the real `npm` via `node:child_process`, which isn't routed through this
     *  project's own PATH-augmenting `exec()` util, so it has to be a real PATH change rather than
     *  a `node_modules/.bin` shim. Restores the original PATH afterward regardless of outcome. */
    async function withFakeNpmOnPath<T>(fn: () => Promise<T>): Promise<T> {
      const binDir = mkTmp();
      dirs.push(binDir);
      const script = path.join(binDir, 'npm');
      // responds to "npm view <name> version" with nothing - same as an unpublished package -
      // so the command still falls through to its normal not-yet-pushed-commits behavior.
      fs.writeFileSync(script, '#!/usr/bin/env node\nprocess.stdout.write("");\n');
      fs.chmodSync(script, 0o755);

      const originalPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
      try {
        return await fn();
      } finally {
        process.env.PATH = originalPath;
      }
    }

    it('narrates the boundary detection before generating, when --from is omitted', async () => {
      const { dir } = fixtureWithOneFeature();
      const lines = await withFakeNpmOnPath(() => captureLogs(() => runCli({ cwd: dir, argv: ['changelog'] })));
      expect(lines.some(l => l.includes("Detecting each package's last release..."))).toBe(true);
      // the fake npm reports nothing published, so it still falls back to "not yet pushed" and
      // finds the same real commit.
      expect(lines.some(l => l.includes('a shiny new feature'))).toBe(true);
    });
  });
});
