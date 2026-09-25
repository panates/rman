import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'expect';
import { runCli, useTestEcosystem } from '../_fixture.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-version-cmd-test-'));
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

/** A run that ends up needing to abort (uncommitted changes without --ignore-dirty) hits cli.ts's
 *  `.fail()` handler on an already-logged error, which calls the real `process.exit(1)` - fatal to
 *  the test runner itself, since it's the same process. Stub it out for the duration of `fn()`. */
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

describe('commands/version', () => {
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

  function initGit(dir: string) {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.com');
    git(dir, 'config', 'user.name', 't');
  }

  function commitAll(dir: string, message: string) {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', message);
  }

  function fixture(): string {
    const dir = tmp();
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
     *  since it runs before the plugins that would know what a package is. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    initGit(dir);
    commitAll(dir, 'init');
    git(dir, 'tag', 'v1.0.0');
    fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
    commitAll(dir, 'fix: a bug');
    return dir;
  }

  describe('an explicit bump keyword', () => {
    it('applies immediately, printing the plan and then what the run actually did', async () => {
      const dir = fixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch'] }));
      const out = lines.join('\n');

      expect(lines.some(l => l.includes('bump') && l.includes('pkg-a') && l.includes('1.0.1'))).toBe(true);
      /**
       * **Not the table again.** A per-package `updated pkg-a 1.0.0 -> 1.0.1` roll-call used to
       * follow, which could not have differed from the rows above it - `applyPlan` returned the
       * plan untouched. What follows now is what the plan cannot say.
       */
      expect(out).toMatch(/updated \d+ package/);
      expect(out).toContain('commit');
      expect(out).toContain('tags');
      expect(out).toContain('not pushed');
      /** And the second listing is gone: the package name appears in the table, not after it. */
      expect(lines.filter(l => l.includes('updated') && l.includes('pkg-a'))).toHaveLength(0);

      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.1');
    });
  });

  describe('no bump given', () => {
    it('auto-detects and shows the plan only - nothing is written', async () => {
      const dir = fixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['version'] }));

      expect(lines.some(l => l.includes('bump') && l.includes('pkg-a'))).toBe(true);
      expect(lines.some(l => l.includes('Run again'))).toBe(true);
      expect(lines.some(l => l.includes('updated'))).toBe(false);
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.0');
    });

    it('prints "Nothing to version." when nothing changed at all', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');

      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['version'] }));
      expect(lines.some(l => l.includes('Nothing to version.'))).toBe(true);
    });
  });

  describe('--show', () => {
    it('previews an explicit bump without applying it', async () => {
      const dir = fixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch', '--show'] }));

      expect(lines.some(l => l.includes('bump') && l.includes('pkg-a') && l.includes('1.0.1'))).toBe(true);
      expect(lines.some(l => l.includes('Preview only'))).toBe(true);
      expect(lines.some(l => l.includes('updated'))).toBe(false);
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.0');
    });

    it('still uses the given severity to compute the plan, unlike omitting bump entirely', async () => {
      const dir = fixture(); // a "fix:" commit, which would auto-detect to "patch" on its own
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'major', '--show'] }));

      expect(lines.some(l => l.includes('bump') && l.includes('pkg-a') && l.includes('2.0.0'))).toBe(true);
    });

    it('rejects being combined with --interactive', async () => {
      const dir = fixture();
      await captureLogs(async () => {
        await expect(runCli({ cwd: dir, argv: ['version', 'patch', '--show', '-i'] })).rejects.toThrow(
          /mutually exclusive/,
        );
      });
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.0'); // never got far enough to apply anything
    });
  });

  describe('--yes', () => {
    it('auto-detects severity from commits and applies it without a prompt', async () => {
      const dir = fixture(); // a "fix:" commit, which auto-detects to "patch"
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['version', '--yes'] }));

      expect(lines.some(l => l.includes('bump') && l.includes('pkg-a') && l.includes('1.0.1'))).toBe(true);
      expect(lines.join('\n')).toMatch(/updated \d+ package/);
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.1');
    });

    it('rejects being combined with --interactive', async () => {
      const dir = fixture();
      await captureLogs(async () => {
        await expect(runCli({ cwd: dir, argv: ['version', '--yes', '-i'] })).rejects.toThrow(/mutually exclusive/);
      });
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.0'); // never got far enough to apply anything
    });

    it('without it, an auto-detected plan is never applied', async () => {
      const dir = fixture();
      await captureLogs(() => runCli({ cwd: dir, argv: ['version'] }));
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.0');
    });
  });

  /**
   * **A repo-wide tag cannot name a release the repository does not share**, so which pattern is
   * the default is derived from how many version lines there are rather than left to be remembered.
   *
   * Every spec here builds a real repository and reads the tags a run *creates*, end to end. The
   * seam these exercise is invisible to `change-hash.service.spec.ts`, which builds a bare
   * `new Package(dir, createApp())` - no repository, so no version lines to count, so `v*` for
   * everything. That is why the whole file stayed green when this default changed.
   */
  describe('which pattern names a release tag', () => {
    function twoLineFixture(rc: Record<string, unknown> = { group: false }): string {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify(rc));
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      /** The repository's history so far: one shared `v*` tag, which is what every repository that
       *  predates its own second version line actually has. */
      git(dir, 'tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'fix: a bug in pkg-a');
      return dir;
    }

    async function planOf(dir: string): Promise<string> {
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['version', '--show'] }));
      return lines.join('\n');
    }

    it('one version line keeps the shared v* tag', async () => {
      const dir = fixture(); // a single package, so a single line
      await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch'] }));
      expect(git(dir, 'tag', '--list').split('\n')).toContain('v1.0.1');
    });

    it('several version lines name the tag after the package', async () => {
      const dir = twoLineFixture();
      await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch', '--scope', 'pkg-a'] }));

      const tags = git(dir, 'tag', '--list').split('\n');
      expect(tags).toContain('pkg-a@1.0.1');
      expect(tags).not.toContain('v1.0.1');
    });

    /**
     * **The bridge across the default changing.** The repository has only `v1.0.0`, so `pkg-a` has
     * no tag under its own name yet - and reading the whole history instead would re-propose
     * everything ever committed. The boundary that *was* correct is the shared tag, because before
     * the split every package genuinely shared it.
     */
    it('measures from the old shared tag while a package has no tag of its own yet', async () => {
      expect(await planOf(twoLineFixture())).toContain('changed since v1.0.0');
    });

    it('reads its own tag once one exists, not the shared one', async () => {
      const dir = twoLineFixture();
      await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch', '--scope', 'pkg-a'] }));
      fs.writeFileSync(path.join(dir, 'packages/a/y.txt'), 'y');
      commitAll(dir, 'fix: another bug in pkg-a');

      expect(await planOf(dir)).toContain('changed since pkg-a@1.0.1');
    });

    /**
     * **The bridge is only for a pattern rman chose.** A repository that declared `{name}@*` itself
     * has said what names its tags; borrowing a `v*` tag it never asked about could hand a package
     * a boundary belonging to something else. So the same repository, with the same tags, answers
     * differently depending on whether the pattern was derived - which is the whole distinction.
     */
    it('never borrows the shared tag when the pattern was declared, not derived', async () => {
      const dir = twoLineFixture({ group: false, changelog: { tagPattern: '{name}@*' } });
      const out = await planOf(dir);

      expect(out).toContain('unreleased commits');
      expect(out).not.toContain('changed since v1.0.0');
    });
  });

  describe('the plan table', () => {
    /**
     * `pkg-a` and `pkg-c` share a version line; `pkg-b` sits between them in *package* order, which
     * is the order `getPlan` returns and the order the table used to print. A group releases as one
     * number, so the members being adjacent is the one thing the table is for.
     *
     * The fixture is built so the claim is observable: with the blocks removed the rows come back
     * as a-b-c, which is the same set in the same table - only `printPlan`'s ordering differs. A
     * repository whose groups happen to be contiguous would pass either way.
     */
    function groupedFixture(): string {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Selectors match **package names**, never directory names - `"[a]"` would match nothing. */
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ '[pkg-a]': { group: 'shared' }, '[pkg-c]': { group: 'shared' }, '[pkg-b]': { group: false } }),
      );
      for (const [d, name] of [
        ['a', 'pkg-a'],
        ['b', 'pkg-b'],
        ['c', 'pkg-c'],
      ]) {
        writeJson(dir, `packages/${d}/package.json`, { name, version: '1.0.0' });
      }
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      for (const d of ['a', 'b', 'c']) fs.writeFileSync(path.join(dir, `packages/${d}/x.txt`), 'x');
      commitAll(dir, 'fix: touches all three');
      return dir;
    }

    async function rows(dir: string): Promise<string[]> {
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['version', '--show'] }));
      return lines.flatMap(l => l.split('\n'));
    }

    it('prints a group’s members together, however the packages were ordered', async () => {
      const order = (await rows(groupedFixture()))
        .map(l => ['pkg-a', 'pkg-b', 'pkg-c'].find(n => l.includes(n)))
        .filter(Boolean);
      expect(order).toEqual(['pkg-a', 'pkg-c', 'pkg-b']);
    });

    it('draws a delimiter between the shared line and the packages that share none', async () => {
      const lines = await rows(groupedFixture());
      const at = (name: string) => lines.findIndex(l => l.includes(name));
      /** A rule of dashes, not the header's own - there is one of those above every table. */
      const delimiters = lines.map((l, i) => (/^[-\s]+$/.test(l) && l.includes('-') ? i : -1)).filter(i => i >= 0);

      /** The header's, one below the root, and one between the shared group and the solo package. */
      expect(delimiters.length).toBe(3);
      expect(delimiters[2]).toBeGreaterThan(at('pkg-c'));
      expect(delimiters[2]).toBeLessThan(at('pkg-b'));
    });

    /**
     * **The root heads the table.** Its number is the repository's release identity - what a GitHub
     * Release is named after, and on a calendar version one no package shares - so it is what the
     * rest of the table sits under, not a footnote below it.
     *
     * `getPlan` appends that entry, so this only holds because `planBlocks` pulls it out: reverting
     * that leaves it the last singleton, and this spec goes red (control run).
     */
    it('prints the repository root first, above every package', async () => {
      const lines = await rows(groupedFixture());
      const at = (name: string) => lines.findIndex(l => l.includes(name));
      for (const pkg of ['pkg-a', 'pkg-b', 'pkg-c']) expect(at('root')).toBeLessThan(at(pkg));
    });

    /**
     * A package that shares its line with nobody gets a group of one named after itself, so the
     * cell used to repeat the Package column. Asserted on the row rather than on the whole output,
     * because `pkg-b` appears in the Package column of that same line either way.
     */
    it('leaves the Group column blank for a package that shares its line with nobody', async () => {
      const lines = await rows(groupedFixture());
      const row = (name: string) => lines.find(l => l.includes(name))!;

      expect(row('pkg-b')).not.toContain('(pkg-b)');
      /** The genuine group still names itself - this is the half that must not be lost. */
      expect(row('pkg-a')).toContain('(shared)');
      /** `root` is what the row *is*, not the package's name, and it is the only thing saying the
       *  number beside it is the repository's identity rather than a release. */
      expect(row('root')).toContain('(root)');
    });

    /**
     * There was a spec here reading "the root prints last", back when it did, and it is worth
     * recording why it went rather than simply being inverted: it passed with the block order
     * reversed *and* with the sort that was supposed to guarantee it deleted. `buildRootEntry`
     * appends and a `Map` preserves insertion order, so the root was last whatever `planBlocks`
     * did - the spec green-lit every answer and the sort was dead code wearing a guarantee. The
     * replacement above pins the opposite arrangement, and a control confirms it can fail.
     */
  });

  describe('--ignore-dirty', () => {
    it('without it, a dirty package aborts the whole run', async () => {
      const dir = fixture();
      fs.writeFileSync(path.join(dir, 'packages/a/dirty.txt'), 'uncommitted');

      const lines = await captureLogs(() => expectCliFailure(() => runCli({ cwd: dir, argv: ['version', 'patch'] })));
      expect(lines.some(l => l.includes('error') && l.includes('pkg-a'))).toBe(true);
      expect(lines.some(l => l.includes('uncommitted local changes'))).toBe(true);
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.0'); // aborted before any write
    });

    /**
     * The abort still names the version. `--show` exists to answer "what would I get", and
     * answering it only for the packages that happen to be committed is answering it for the
     * uninteresting half - the dirty package is the one being worked on.
     *
     * Asserted on the **row**, not merely on the output containing `1.0.1` somewhere: the root's
     * own informational entry carries that number too, so `out.includes('1.0.1')` passes with the
     * fix reverted (measured - that is the vacuous form of this spec).
     */
    it('without it, the aborted row still says which version the package would have got', async () => {
      const dir = fixture();
      fs.writeFileSync(path.join(dir, 'packages/a/dirty.txt'), 'uncommitted');

      const lines = await captureLogs(() => expectCliFailure(() => runCli({ cwd: dir, argv: ['version', '--show'] })));
      const row = lines.flatMap(l => l.split('\n')).find(l => l.includes('pkg-a'));

      expect(row).toBeDefined();
      expect(row).toContain('error');
      expect(row).toContain('1.0.1');
      /** The boundary survives the overwrite - the status column already says why it failed, so
       *  the reason is where the number is explained. */
      expect(row).toContain('uncommitted local changes');
      expect(row).toContain('changed since v1.0.0');
    });

    /**
     * The other half, and the reason the two cases are not one: `--ignore-dirty` **writes**. A
     * version printed beside `skip` would name one that package is not getting, and the entry must
     * stay out of its group so no sibling inherits a number from commits nobody is releasing.
     */
    it('with it, the skipped package is given no version at all', async () => {
      const dir = fixture();
      fs.writeFileSync(path.join(dir, 'packages/a/dirty.txt'), 'uncommitted');

      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['version', '--show', '--ignore-dirty'] }));
      const row = lines.flatMap(l => l.split('\n')).find(l => l.includes('pkg-a'));

      expect(row).toBeDefined();
      expect(row).toContain('skip');
      expect(row).not.toContain('1.0.1');
      expect(row).not.toContain('->');
    });

    it('with it, the dirty package is excluded instead of aborting the run', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'packages/b/x.txt'), 'x');
      commitAll(dir, 'fix: a bug in pkg-b');
      fs.writeFileSync(path.join(dir, 'packages/a/dirty.txt'), 'uncommitted');

      await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch', '--ignore-dirty'] }));

      const a = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      const b = JSON.parse(fs.readFileSync(path.join(dir, 'packages/b/package.json'), 'utf-8'));
      expect(a.version).toBe('1.0.0'); // skipped, untouched
      expect(b.version).toBe('1.0.1'); // still applied
    });
  });

  describe('--push', () => {
    it('never pushes unless given, and reaches the remote when given', async () => {
      const dir = tmp();
      const originDir = tmp();
      fs.rmSync(originDir, { recursive: true, force: true });
      execFileSync('git', ['init', '-q', '--bare', originDir]);
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      git(dir, 'remote', 'add', 'origin', originDir);
      git(dir, 'branch', '-M', 'main');
      git(dir, 'push', '-u', 'origin', 'main', '-q');
      git(dir, 'push', '-q', 'origin', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'fix: a bug');

      await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch'] }));
      let remoteTags = execFileSync('git', ['tag', '--list'], { cwd: originDir }).toString().trim();
      expect(remoteTags).not.toContain('v1.0.1');

      fs.writeFileSync(path.join(dir, 'y.txt'), 'y');
      commitAll(dir, 'fix: another bug');
      await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch', '--push'] }));
      remoteTags = execFileSync('git', ['tag', '--list'], { cwd: originDir }).toString().trim();
      expect(remoteTags).toContain('v1.0.2');
    });
  });

  describe('--interactive / -i (real confirmation prompt, via a real subprocess)', () => {
    function runInSubprocess(dir: string, argv: string[], stdin: string): string {
      /** Resolved from *this file*, never from `process.cwd()`: with mocha run at the repository
       *  root the old form pointed at `<root>/src/cli.js`, which stopped existing the moment the
       *  sources moved under `packages/rman` (measured - these three tests failed). */
      /**
       * The child runs the **fixture's** `runCli`, not the CLI's - it is what builds an application
       * carrying the test technology.
       *
       * There is nothing else that could: the child has no mocha and no `beforeEach`, and the
       * repository it runs in names no plugin, so without one it has no manifest provider and no
       * planner. It used to call a `registerTestEcosystem()` that wrote into module-global
       * registries; those are gone, and an application is handed over instead.
       */
      const fixtureModule = path.resolve(fileURLToPath(import.meta.url), '../../_fixture.js');
      const script = `
        import('${fixtureModule.replace(/\\\\/g, '/')}').then(f =>
          f.runCli({ cwd: ${JSON.stringify(dir)}, argv: ${JSON.stringify(argv)} }),
        );
      `;
      return execFileSync('node', ['--import', '@swc-node/register/esm-register', '-e', script], {
        input: stdin,
        cwd: process.cwd(),
      }).toString();
    }

    it('"y" applies the plan', async () => {
      const dir = fixture();
      const output = runInSubprocess(dir, ['version', '--interactive'], 'y\n');
      expect(output).toContain('updated');
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.1');
    });

    it('"n" (or anything else) declines - nothing is written', async () => {
      const dir = fixture();
      const output = runInSubprocess(dir, ['version', '--interactive'], 'n\n');
      expect(output).not.toContain('updated');
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.0');
    });

    it('also asks for confirmation when an explicit bump was given', async () => {
      const dir = fixture();
      const output = runInSubprocess(dir, ['version', 'patch', '--interactive'], 'y\n');
      expect(output).toContain('Apply these changes?');
      expect(output).toContain('updated');
    });
  });

  describe('-m / --message', () => {
    // the group release commit is always the last one made - the monorepo root's own informational
    // version-sync commit goes in ahead of it, so the release tag lands on HEAD.
    it('overrides the default commit message, with {version} substituted', async () => {
      const dir = fixture();
      await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch', '--message', 'release: v{version}'] }));
      expect(git(dir, 'log', '-1', '--format=%s')).toBe('release: v1.0.1');
    });

    it('without it, falls back to the built-in default commit message', async () => {
      const dir = fixture();
      await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch'] }));
      expect(git(dir, 'log', '-1', '--format=%s')).toBe('chore(release): v1.0.1');
    });

    it('leaves the release tag on HEAD, not behind the root version-sync commit', async () => {
      const dir = fixture();
      await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch'] }));
      expect(git(dir, 'tag', '--points-at', 'HEAD')).toBe('v1.0.1');
    });
  });

  describe('--changelog', () => {
    it("writes each bumped package's CHANGELOG.md and folds it into the same commit as the version bump", async () => {
      const dir = fixture();
      await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch', '--changelog'] }));

      const changelog = fs.readFileSync(path.join(dir, 'packages/a/CHANGELOG.md'), 'utf-8');
      expect(changelog).toContain('a bug');
      // headed with the version being released, not the one it's replacing - the tag for this
      // release doesn't exist yet at the point the entry is rendered.
      expect(changelog).toContain('1.0.1');
      expect(changelog).not.toContain('1.0.0');

      // the changelog file was committed together with the version bump, not left uncommitted.
      expect(git(dir, 'status', '--porcelain')).toBe('');
      const committedFiles = git(dir, 'show', '--name-only', '--pretty=format:', 'HEAD');
      expect(committedFiles).toContain('packages/a/CHANGELOG.md');
      expect(committedFiles).toContain('packages/a/package.json');
    });

    it('without it, no CHANGELOG.md is written at all', async () => {
      const dir = fixture();
      await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch'] }));
      expect(fs.existsSync(path.join(dir, 'packages/a/CHANGELOG.md'))).toBe(false);
    });

    it('.rmanrc "version.changelog": true makes it the default - no --changelog flag needed', async () => {
      const dir = fixture();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ version: { changelog: true } }));
      commitAll(dir, 'chore: add .rmanrc');
      await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch'] }));
      expect(fs.existsSync(path.join(dir, 'packages/a/CHANGELOG.md'))).toBe(true);
    });

    it('--no-changelog overrides .rmanrc "version.changelog": true back off for one run', async () => {
      const dir = fixture();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ version: { changelog: true } }));
      commitAll(dir, 'chore: add .rmanrc');
      await captureLogs(() => runCli({ cwd: dir, argv: ['version', 'patch', '--no-changelog'] }));
      expect(fs.existsSync(path.join(dir, 'packages/a/CHANGELOG.md'))).toBe(false);
    });
  });
});
