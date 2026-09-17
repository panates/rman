import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli } from '../../src/cli.js';
import { useTestEcosystem } from '../_fixture.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-list-cmd-test-'));
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

describe('commands/list', () => {
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

  function monorepoFixture(): string {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
     *  since it runs before the plugins that would know what a package is. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0', dependencies: {} });
    writeJson(dir, 'packages/b/package.json', {
      name: 'pkg-b',
      version: '2.0.0',
      private: true,
      dependencies: { 'pkg-a': '1.0.0' },
    });
    return dir;
  }

  describe('default (table) output', () => {
    it('lists every package by name and a trailing "N Package(s) found" line', async () => {
      const dir = monorepoFixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['list'] }));
      const joined = lines.join('\n');
      expect(joined).toContain('pkg-a');
      expect(joined).toContain('pkg-b');
      expect(lines.some(l => l.includes('2 Package(s) found'))).toBe(true);
    });

    it('works the same through the "ls" alias', async () => {
      const dir = monorepoFixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['ls'] }));
      expect(lines.some(l => l.includes('pkg-a'))).toBe(true);
    });
  });

  describe('--json', () => {
    it("prints a JSON array with each package's name, version, private flag and dependencies", async () => {
      const dir = monorepoFixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['list', '--json'] }));
      const items = JSON.parse(lines.join('\n'));
      expect(Array.isArray(items)).toBe(true);
      const b = items.find((i: any) => i.name === 'pkg-b');
      expect(b.version).toBe('2.0.0');
      expect(b.private).toBe(true);
      /** `list --json` reports dependency **names**, not packages: it is a serialized report for a
       *  consumer outside the process, so `ListService.Item` flattens them on the way out. The
       *  `Package[]` form is `Package.dependencies`, in-process. */
      expect(b.dependencies).toEqual(['pkg-a']);
    });
  });

  describe('--parseable', () => {
    it('prints one "location::name::version::PRIVATE::" line per package', async () => {
      const dir = monorepoFixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['list', '--parseable'] }));
      const line = lines.find(l => l.includes('pkg-b'));
      expect(line).toBe(`packages/b::pkg-b::2.0.0::PRIVATE::`);
    });
  });

  describe('--short', () => {
    it('prints only package names, one per line, nothing else', async () => {
      const dir = monorepoFixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['list', '--short'] }));
      expect(lines.sort()).toEqual(['pkg-a', 'pkg-b']);
    });
  });

  describe('--graph', () => {
    it('prints a JSON adjacency list of in-repo dependencies', async () => {
      const dir = monorepoFixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['list', '--graph'] }));
      const graph = JSON.parse(lines.join('\n'));
      expect(graph).toEqual({ 'pkg-a': [], 'pkg-b': ['pkg-a'] });
    });
  });

  describe('option conflicts', () => {
    it('rejects --graph combined with --json instead of silently picking one', async () => {
      const dir = monorepoFixture();
      const lines = await captureLogs(async () => {
        await expect(runCli({ cwd: dir, argv: ['list', '--graph', '--json'] })).rejects.toThrow(/mutually exclusive/);
      });
      expect(lines.some(l => l.includes('graph') && l.includes('json') && l.includes('mutually exclusive'))).toBe(true);
      // neither output mode's own rendering ran once the conflict was caught.
      expect(lines.some(l => l.trim().startsWith('{'))).toBe(false);
    });
  });

  describe('--changed / --changed-since', () => {
    it('--changed only lists packages with local git changes', async () => {
      const dir = monorepoFixture();
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      git('init', '-q');
      git('config', 'user.email', 't@t.com');
      git('config', 'user.name', 't');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      fs.writeFileSync(path.join(dir, 'packages/a/extra.txt'), 'dirty');

      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['list', '--changed', '--short'] }));
      expect(lines).toEqual(['pkg-a']);
    });
  });

  describe('--toposort', () => {
    it('orders dependencies before dependents instead of lexical-by-directory', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      // "a" is named to sort first lexically, but depends on "z" - toposort must still put "z" first.
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        dependencies: { 'pkg-z': '1.0.0' },
      });
      writeJson(dir, 'packages/z/package.json', { name: 'pkg-z', version: '1.0.0' });

      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['list', '--toposort', '--short'] }));
      expect(lines).toEqual(['pkg-z', 'pkg-a']);
    });
  });

  describe('--scope / --ignore / --deps / --dependents', () => {
    function chainFixture(): string {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/base/package.json', { name: 'pkg-base', version: '1.0.0' });
      writeJson(dir, 'packages/lib/package.json', {
        name: 'pkg-lib',
        version: '1.0.0',
        dependencies: { 'pkg-base': '1.0.0' },
      });
      writeJson(dir, 'packages/app/package.json', {
        name: 'pkg-app',
        version: '1.0.0',
        dependencies: { 'pkg-lib': '1.0.0' },
      });
      return dir;
    }

    it('--scope only includes packages matching the glob', async () => {
      const dir = chainFixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['list', '--scope', 'pkg-lib', '--short'] }));
      expect(lines).toEqual(['pkg-lib']);
    });

    it('--ignore excludes packages matching the glob', async () => {
      const dir = chainFixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['list', '--ignore', 'pkg-app', '--short'] }));
      expect(lines.sort()).toEqual(['pkg-base', 'pkg-lib']);
    });

    it('--scope with --deps also includes what the scoped package depends on', async () => {
      const dir = chainFixture();
      const lines = await captureLogs(() =>
        runCli({ cwd: dir, argv: ['list', '--scope', 'pkg-lib', '--deps', '--short'] }),
      );
      expect(lines.sort()).toEqual(['pkg-base', 'pkg-lib']);
    });

    it('--scope with --dependents also includes what depends on the scoped package', async () => {
      const dir = chainFixture();
      const lines = await captureLogs(() =>
        runCli({ cwd: dir, argv: ['list', '--scope', 'pkg-lib', '--dependents', '--short'] }),
      );
      expect(lines.sort()).toEqual(['pkg-app', 'pkg-lib']);
    });
  });
});
