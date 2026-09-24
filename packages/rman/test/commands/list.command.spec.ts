import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { definePlatform, type Platform } from '../../src/core/plugin.js';
import { runCli, usePlugin, useTestEcosystem } from '../_fixture.js';

/**
 * A second technology, so the platform column and `--platform` are asked of a repository that has
 * more than one answer. Recognizes `other.json`; a spec's own platforms register first, so it
 * claims a directory carrying both files.
 */
const otherPlatform: Platform = definePlatform({
  name: 'other',
  manifestProvider: {
    name: 'other',
    fileName: 'other.json',
    read: dir => {
      const file = path.join(dir, 'other.json');
      if (!fs.existsSync(file)) return undefined;
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return { name: raw.name, version: raw.version ?? '1.0.0', raw };
    },
    write: () => undefined,
  },
});

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

  /**
   * **The table draws the tree; the machine-readable forms are unchanged.**
   *
   * Discovery descends now (`Workspace.walk`), so a repository *is* a tree and a flat list threw
   * that away. The root is the row the members hang from - without it, indenting every member by
   * one level in a flat monorepo would say nothing.
   */
  describe('the tree', () => {
    it('puts the root first and indents each member under it', async () => {
      const dir = monorepoFixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['list'] }));
      expect(row(lines, 'root')).toMatch(/^root\s/);
      expect(row(lines, 'pkg-a')).toMatch(/^ {2}pkg-a\s/);
      /** And the count is still the members - the root is the tree's row, not an inventory entry. */
      expect(lines.some(l => l.includes('2 Package(s) found'))).toBe(true);
    });

    /** A package nested inside another indents twice, which is the case the flat list could not
     *  express at all - see `core/workspace.spec.ts`. */
    it('indents a package nested inside another one level further', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0', workspaces: ['inner/*'] });
      writeJson(dir, 'packages/a/inner/deep/package.json', { name: 'pkg-deep', version: '1.0.0' });

      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['list'] }));
      expect(row(lines, 'pkg-a')).toMatch(/^ {2}pkg-a\s/);
      expect(row(lines, 'pkg-deep')).toMatch(/^ {4}pkg-deep\s/);
    });

    /** The root row is the table's, not the inventory's: a script reading `--json`, `--parseable`
     *  or `--short` sees exactly what it saw before. */
    it('leaves the machine-readable forms as the members alone', async () => {
      const dir = monorepoFixture();
      const short = await captureLogs(() => runCli({ cwd: dir, argv: ['list', '--short'] }));
      expect(short.sort()).toEqual(['pkg-a', 'pkg-b']);
      const items = JSON.parse((await captureLogs(() => runCli({ cwd: dir, argv: ['list', '--json'] }))).join('\n'));
      expect(items.map((i: any) => i.name).sort()).toEqual(['pkg-a', 'pkg-b']);
      /** The tree is still *reported* there, as data rather than as indentation. */
      expect(items.every((i: any) => i.depth === 1 && i.isRoot === false)).toBe(true);
    });

    /** A single-package repository has one row, which **is** the root - so nothing is prepended and
     *  the count is still 1. It read `0 Package(s) found` when the count was derived from `isRoot`
     *  instead of from whether a row had been added (measured). */
    it('counts the one package in a single-package repository', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'package.json', { name: 'solo', version: '1.0.0' });
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['list'] }));
      expect(rows(lines).filter(l => l.includes('solo'))).toHaveLength(1);
      expect(lines.some(l => l.includes('1 Package(s) found'))).toBe(true);
    });
  });

  /**
   * **`Platform`, as a column and as a filter.**
   *
   * Which technology a package belongs to only became a per-package question when the walk started
   * finding nested packages of another platform - and until then `list` was the one place that
   * showed every package and could not say which each belonged to. So these run against a genuinely
   * polyglot repository: `pkg-other` is claimed by a second platform, and every assertion below
   * would pass vacuously in a repository where there is only one answer.
   */
  describe('the platform column and --platform', () => {
    usePlugin(otherPlatform);

    function polyglotFixture(): string {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      /** Claimed by `other`, which is registered first - so this directory is *not* the fixture
       *  platform's, although it also carries a `package.json` for the workspace glob to find. */
      writeJson(dir, 'packages/other/package.json', { name: 'pkg-other', version: '1.0.0' });
      writeJson(dir, 'packages/other/other.json', { name: 'pkg-other' });
      return dir;
    }

    it("reports each package's own platform, which differ", async () => {
      const dir = polyglotFixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['list'] }));
      expect(rows(lines)[0]).toContain('Platform');
      expect(row(lines, 'pkg-a')).toContain('test');
      expect(row(lines, 'pkg-other')).toContain('other');
    });

    it('narrows to one platform', async () => {
      const dir = polyglotFixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['list', '--platform=test', '--short'] }));
      expect(lines).toEqual(['pkg-a']);
    });

    /** A comma-separated value is split, unlike `--scope`: a platform name is a short identifier a
     *  plugin chose, so it cannot be ambiguous, where a scope glob is arbitrary text. */
    it('splits a comma-separated value, and takes the flag repeated too', async () => {
      const dir = polyglotFixture();
      const commas = await captureLogs(() => runCli({ cwd: dir, argv: ['list', '--platform=test,other', '--short'] }));
      expect(commas.sort()).toEqual(['pkg-a', 'pkg-other']);
      const repeated = await captureLogs(() =>
        runCli({ cwd: dir, argv: ['list', '--platform', 'test', '--platform', 'other', '--short'] }),
      );
      expect(repeated.sort()).toEqual(['pkg-a', 'pkg-other']);
    });

    it('is case-insensitive, since the platform decides the spelling', async () => {
      const dir = polyglotFixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['list', '--platform=OTHER', '--short'] }));
      expect(lines).toEqual(['pkg-other']);
    });

    /**
     * **An unknown name is an error, where an unmatched `--scope` glob is not**, and the difference
     * is whether rman knows the answer set. It does here, so a typo is something it can see - and
     * left alone it is the silent empty result this codebase keeps ruling out. The message lists
     * what the repository has, the same call `publish --target` makes.
     */
    it('refuses a platform no package here belongs to, listing the ones that do', async () => {
      const dir = polyglotFixture();
      const error = await expectCliFailure(() => runCli({ cwd: dir, argv: ['list', '--platform=crago', '--short'] }));
      expect(error.message).toContain('--platform "crago" matches no package');
      expect(error.message).toContain('It holds: other, test');
    });

    /** And the comma really is a separator rather than part of the name - which this says by
     *  naming the *second* entry in the error. */
    it('reports the offending entry of a comma-separated value, not the whole string', async () => {
      const dir = polyglotFixture();
      const error = await expectCliFailure(() =>
        runCli({ cwd: dir, argv: ['list', '--platform=test,crago', '--short'] }),
      );
      expect(error.message).toContain('--platform "crago" matches no package');
    });
  });
});

/**
 * A CLI call expected to fail, with **both** streams silenced while it runs.
 *
 * `console.error` and not only `console.log`: a throw from a handler is printed twice - once by
 * yargs' own `.fail()` and once by `runCli`'s catch - and left through, the reporter and the stray
 * write race for the same stream, so a result line comes out spliced. Every assertion reads
 * `error.message`, so nothing is lost by dropping the printed copy.
 */
async function expectCliFailure(fn: () => Promise<void>): Promise<Error> {
  const log = console.log;
  const error = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return await fn().then(
      () => {
        throw new Error('expected the command to fail, but it resolved');
      },
      (e: Error) => e,
    );
  } finally {
    console.log = log;
    console.error = error;
  }
}

/** `printTable` writes the whole table in **one** `console.log`, so a captured "line" is the table.
 *  Split before matching on a row - asserted against the unsplit line, `/^ {2}pkg-a/` simply never
 *  matches and the failure reads as though the indentation were missing. */
function rows(lines: string[]): string[] {
  return lines.flatMap(l => l.split('\n'));
}

function row(lines: string[], name: string): string {
  return rows(lines).find(l => l.trimStart().startsWith(name))!;
}
