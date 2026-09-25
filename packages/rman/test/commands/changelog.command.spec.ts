import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { runCli, useTestEcosystem } from '../_fixture.js';

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

/**
 * **A heading naming `name`**, whatever shape the heading happens to take - `## v1.2.0`,
 * `## Unreleased — pkg-a`, or a repository's own `changelog.template`. Asserting the literal
 * `'## pkg-a 1.0.0'` pinned the default template's layout in twenty-two places, so changing the
 * heading - which is a presentation decision - turned every one of them red for no defect.
 */
function headingFor(name: string): RegExp {
  return new RegExp(`^## .*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'm');
}

describe('commands/changelog', () => {
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

    /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,

     *  since it runs before the plugins that would know what a package is. */

    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
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
      expect(joined).toMatch(headingFor('pkg-a'));
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

  /**
   * **`--write` is an append, so where the file stopped is the boundary.** It was the package's
   * last release *tag*, which does not move between two writes - so a second run re-listed every
   * commit since that tag on top of the entry that already held them. Measured before the fix: one
   * commit appeared twice, under two headings carrying the same version number.
   */
  /**
   * **A floor on how far back the changelog goes.** A first `--write` reaches through every release
   * there has ever been, and for a package that has shipped for years most of that is not what a
   * changelog is for. One key rather than `auto-changelog`'s two, taking whichever form the answer
   * has - and a third neither of those covers, a commit.
   */
  describe('changelog.startingAt', () => {
    /** Three releases, each dated years apart, plus one unreleased commit - so a version floor, a
     *  date floor and a commit floor all have different right answers. */
    function historyFixture(): string {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '3.0.0' });
      const at = (date: string, ...args: string[]) =>
        execFileSync('git', args, {
          cwd: dir,
          stdio: 'pipe',
          env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
        });
      at('2019-01-01T00:00:00+00:00', 'init', '-q');
      execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'pipe' });
      at('2019-01-01T00:00:00+00:00', 'add', '-A');
      at('2019-01-01T00:00:00+00:00', 'commit', '-q', '-m', 'feat: earliest work');
      at('2019-01-01T00:00:00+00:00', 'tag', 'v1.0.0');
      for (const [file, date, version] of [
        ['a.txt', '2021-05-05T00:00:00+00:00', 'v2.0.0'],
        ['b.txt', '2024-09-09T00:00:00+00:00', 'v3.0.0'],
      ]) {
        fs.writeFileSync(path.join(dir, file), 'x');
        at(date, 'add', '-A');
        at(date, 'commit', '-q', '-m', `feat: work for ${version}`);
        at(date, 'tag', version);
      }
      fs.writeFileSync(path.join(dir, 'c.txt'), 'x');
      execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-q', '-m', 'fix: unreleased'], { cwd: dir, stdio: 'pipe' });
      return dir;
    }

    async function headingsWith(dir: string, ...argv: string[]): Promise<string[]> {
      await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write', ...argv] }));
      const written = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf-8');
      return written.split('\n').filter(l => l.startsWith('## '));
    }

    it('documents every release when nothing sets a floor', async () => {
      const headings = await headingsWith(historyFixture());
      expect(headings.filter(h => h.includes('v'))).toHaveLength(3);
    });

    it('takes a version, inclusively', async () => {
      const headings = await headingsWith(historyFixture(), '--starting-at', '2.0.0');
      expect(headings.some(h => h.includes('v2.0.0'))).toBe(true);
      expect(headings.some(h => h.includes('v1.0.0'))).toBe(false);
    });

    /** The same floor written as the tag - a repository should not have to know which spelling the
     *  key wants. */
    it('takes the release tag just as well', async () => {
      const headings = await headingsWith(historyFixture(), '--starting-at', 'v2.0.0');
      expect(headings.some(h => h.includes('v2.0.0'))).toBe(true);
      expect(headings.some(h => h.includes('v1.0.0'))).toBe(false);
    });

    it('takes a date, against each release’s own day', async () => {
      const headings = await headingsWith(historyFixture(), '--starting-at', '2024-01-01');
      expect(headings.some(h => h.includes('v3.0.0'))).toBe(true);
      expect(headings.some(h => h.includes('v2.0.0'))).toBe(false);
    });

    it('takes a commit, keeping the release that commit belongs to', async () => {
      const dir = historyFixture();
      const sha = execFileSync('git', ['rev-list', '-n1', 'v2.0.0'], { cwd: dir }).toString().trim();

      const headings = await headingsWith(dir, '--starting-at', sha);
      expect(headings.some(h => h.includes('v2.0.0'))).toBe(true);
      expect(headings.some(h => h.includes('v1.0.0'))).toBe(false);
    });

    /** The floor is about history. Dropping the commits that are not released yet would hide the
     *  very thing most runs are asking about. */
    it('never drops the unreleased entry, whatever the floor', async () => {
      for (const floor of ['3.0.0', '2026-01-01']) {
        const headings = await headingsWith(historyFixture(), '--starting-at', floor);
        expect(headings.some(h => h.includes('Unreleased'))).toBe(true);
      }
    });

    it('reads .rmanrc changelog.startingAt, and the flag wins over it', async () => {
      const dir = historyFixture();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ changelog: { startingAt: '3.0.0' } }));
      execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-q', '-m', 'chore: floor'], { cwd: dir, stdio: 'pipe' });

      expect((await headingsWith(dir)).some(h => h.includes('v2.0.0'))).toBe(false);
      fs.rmSync(path.join(dir, 'CHANGELOG.md'));
      expect((await headingsWith(dir, '--starting-at', '1.0.0')).some(h => h.includes('v1.0.0'))).toBe(true);
    });

    /** A value matching none of the three forms is a configuration mistake, and silence is the bad
     *  outcome either way: read as "never below" it leaves the changelog looking complete, read as
     *  "always below" it empties it. */
    it('refuses a value that is none of the three forms, naming all of them', async () => {
      const dir = historyFixture();
      const error = console.error;
      console.error = () => {};
      try {
        const failure = await captureLogs(() =>
          runCli({ cwd: dir, argv: ['changelog', '--starting-at', 'banana'] }),
        ).then(
          () => {
            throw new Error('expected the command to fail, but it resolved');
          },
          (e: unknown) => e as Error,
        );
        const message = failure.message;
        expect(message).toContain('changelog.startingAt');
        expect(message).toContain('version or release tag');
        expect(message).toContain('date');
        expect(message).toContain('commit');
      } finally {
        console.error = error;
      }
    });
  });

  /**
   * **`changelog.unreleased` defaults to `true`**, so the flag that does something is
   * `--no-unreleased`. `auto-changelog` defaults its equivalent off; the opposite default here is
   * deliberate - `rman changelog` exists to answer what is *not* released yet, and off by default
   * would make the common case need a flag.
   */
  describe('changelog.unreleased', () => {
    function twoReleaseFixture(): string {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: the released work');
      run('tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'later.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'fix: not released yet');
      return dir;
    }

    const written = (dir: string) => fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf-8');

    it('documents the unreleased commits by default', async () => {
      const dir = twoReleaseFixture();
      await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write'] }));
      expect(written(dir)).toContain('Unreleased');
      expect(written(dir)).toContain('not released yet');
    });

    it('--no-unreleased leaves them out, keeping the released history', async () => {
      const dir = twoReleaseFixture();
      await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write', '--no-unreleased'] }));
      expect(written(dir)).not.toContain('Unreleased');
      expect(written(dir)).not.toContain('not released yet');
      expect(written(dir)).toContain('## v1.0.0');
    });

    it('reads .rmanrc changelog.unreleased', async () => {
      const dir = twoReleaseFixture();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ changelog: { unreleased: false } }));
      execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-q', '-m', 'chore: config'], { cwd: dir, stdio: 'pipe' });

      await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write'] }));
      expect(written(dir)).not.toContain('Unreleased');
    });

    /**
     * **The guard that keeps `version --changelog` working.** Naming the version means the caller is
     * describing the release it is about to cut - the segment is "unreleased" only for the seconds
     * until it is tagged. Without this, a repository setting `unreleased: false` would find every
     * release silently documenting nothing.
     */
    it('still documents a release the caller has named, even with it off', async () => {
      const dir = twoReleaseFixture();
      await captureLogs(() =>
        runCli({ cwd: dir, argv: ['changelog', '--write', '--no-unreleased', '--release-version', '2.0.0'] }),
      );
      expect(written(dir)).toContain('## v2.0.0');
      expect(written(dir)).toContain('not released yet');
    });
  });

  describe('--write picks up where the file left off', () => {
    /** A repository with a `v1.0.0` tag and one commit on either side of it, so "since the tag"
     *  and "the whole history" are distinguishable answers. */
    function taggedFixture(): string {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: before the tag');
      run('tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'packages/a/after.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: after the tag');
      return dir;
    }

    function commit(dir: string, message: string, file: string) {
      fs.writeFileSync(path.join(dir, file), 'x');
      execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir, stdio: 'pipe' });
    }

    const read = (dir: string) => fs.readFileSync(path.join(dir, 'packages/a/CHANGELOG.md'), 'utf-8');

    it('documents the whole history when there is no changelog file yet', async () => {
      const dir = taggedFixture();
      await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write'] }));

      /** The commit *before* the tag is the one the tag boundary silently dropped - it was never
       *  written anywhere, and on the next run it would be older still. */
      expect(read(dir)).toContain('before the tag');
      expect(read(dir)).toContain('after the tag');
    });

    /**
     * **A range is cut at every release tag inside it.** Backfilling the whole history is only
     * useful if it comes out as the releases it was - measured on a real repository before this,
     * a first `--write` reached back through twelve tags and rendered every commit in all of them
     * under one `v2.1.6` heading.
     *
     * Each heading also carries **that** release's date, which is what makes the entries readable
     * as history rather than as one thing generated today.
     */
    it('cuts the backfill at each release inside the range, dated by that release', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '2.0.0' });
      const at = (date: string, ...args: string[]) =>
        execFileSync('git', args, {
          cwd: dir,
          stdio: 'pipe',
          env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date },
        });
      at('2020-01-01T00:00:00+00:00', 'init', '-q');
      execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'pipe' });
      at('2020-01-01T00:00:00+00:00', 'add', '-A');
      at('2020-01-01T00:00:00+00:00', 'commit', '-q', '-m', 'feat: the first release');
      at('2020-01-01T00:00:00+00:00', 'tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'two.txt'), 'x');
      at('2021-06-15T00:00:00+00:00', 'add', '-A');
      at('2021-06-15T00:00:00+00:00', 'commit', '-q', '-m', 'feat: the second release');
      at('2021-06-15T00:00:00+00:00', 'tag', 'v2.0.0');
      fs.writeFileSync(path.join(dir, 'three.txt'), 'x');
      execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-q', '-m', 'fix: not released yet'], { cwd: dir, stdio: 'pipe' });

      await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write'] }));
      const written = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf-8');

      /** Three segments: the two tagged releases, plus what is not released yet. */
      expect(written.match(/^## /gm)).toHaveLength(3);
      expect(written).toContain('1.0.0 (2020-01-01)');
      expect(written).toContain('2.0.0 (2021-06-15)');
      /** Newest first, so the file reads top-down as history. */
      expect(written.indexOf('not released yet')).toBeLessThan(written.indexOf('the second release'));
      expect(written.indexOf('the second release')).toBeLessThan(written.indexOf('the first release'));
      /** Each release's commits under its own heading, not pooled into one. */
      expect(written.match(/^---$/gm)).toHaveLength(2);
    });

    it('starts from the marker on the next run, so nothing is written twice', async () => {
      const dir = taggedFixture();
      await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write'] }));
      commit(dir, 'fix: later still', 'packages/a/later.txt');
      await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write'] }));

      const written = read(dir);
      expect(written).toContain('later still');
      /** The claim: the tag boundary would have re-listed this one under the new heading too. */
      expect(written.match(/after the tag/g)).toHaveLength(1);
      expect(written.match(/before the tag/g)).toHaveLength(1);
    });

    it('rewrites the one marker rather than accumulating them', async () => {
      const dir = taggedFixture();
      await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write'] }));
      commit(dir, 'fix: later still', 'packages/a/later.txt');
      await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write'] }));

      expect(read(dir).match(/rman:documented-up-to/g)).toHaveLength(1);
    });

    it('writes nothing at all when the file is already up to date', async () => {
      const dir = taggedFixture();
      await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write'] }));
      const before = read(dir);

      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write'] }));
      expect(lines.some(l => l.includes('No unreleased changes.'))).toBe(true);
      expect(read(dir)).toBe(before);
    });

    it('rules one release off from the next, and adds none above a lone entry', async () => {
      /**
       * A repository with **no** release tag, so the backfill is one segment - which is what makes
       * "no rule above the first entry" observable at all. `taggedFixture` would give two here,
       * one per side of its tag, and a rule between them; that is the split working, not a stray
       * separator.
       */
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: the only thing so far');

      await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write'] }));
      expect(read(dir)).not.toContain('\n---\n');

      commit(dir, 'fix: later still', 'packages/a/later.txt');
      await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write'] }));
      expect(read(dir)).toContain('\n---\n');
    });

    /** A print run is not appending to anything, so answering "the notes for this release" with
     *  "nothing, it is all documented" would be the wrong question answered. */
    it('a print run ignores the marker entirely', async () => {
      const dir = taggedFixture();
      await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write'] }));

      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['changelog'] }));
      expect(lines.join('\n')).toContain('after the tag');
    });

    /**
     * **The realistic shape, and the one that broke while this was written.** `rman version` makes
     * a `chore(release): v1.0.0` commit and tags *that* - and a release marker is exactly what
     * `dropVersionBumps` removes. Dropping before the split therefore leaves every tag pointing at
     * a sha no longer in the list, every cut missed, and the whole range rendered as one release.
     * So the drop happens per segment, after the cut.
     */
    it('still cuts at a tag sitting on the release commit it drops', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: the released work');
      fs.writeFileSync(path.join(dir, 'bump.txt'), 'x');
      run('add', '-A');
      /** What `version` writes, and what `isReleaseCommit` drops. */
      run('commit', '-q', '-m', 'chore(release): v1.0.0');
      run('tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'after.txt'), 'x');
      run('add', '-A');
      run('commit', '-q', '-m', 'fix: after the release');

      await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write'] }));
      const written = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf-8');

      expect(written.match(/^## /gm)).toHaveLength(2);
      /** The release commit heads its segment without appearing in it. */
      expect(written).not.toContain('chore(release)');
      expect(written.indexOf('after the release')).toBeLessThan(written.indexOf('the released work'));
    });

    /**
     * **The heading's two halves have to describe the same release.** The version is read back from
     * the package's latest tag; the date used to be `new Date()`, so regenerating notes for an
     * already-tagged release headed them with that release's number and today's date. Measured on a
     * real repository: `## @panates/eslint-config v2.1.6 (2026-09-25)` for a v2.1.6 tagged days
     * earlier.
     */
    it('dates an entry by the release it names, not by the day it was generated', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      const run = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: dir,
          stdio: 'pipe',
          env: { ...process.env, GIT_COMMITTER_DATE: '2020-03-04T10:00:00+00:00' },
        });
      run('init', '-q');
      run('config', 'user.email', 't@t.com');
      run('config', 'user.name', 't');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: the released feature');
      run('tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'later.txt'), 'x');
      execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-q', '-m', 'fix: after the release'], { cwd: dir, stdio: 'pipe' });

      /** `--write`, because only a backfill reaches back *through* the tag - a print run's boundary
       *  is that tag, so the range holds no tagged segment to date. */
      await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write'] }));
      expect(fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf-8')).toContain('## v1.0.0 (2020-03-04)');
    });

    /** The case today's date was written for, and it stays: a caller passing the version is
     *  describing a release that does not exist yet, so there is no tag to read a date off. */
    it('dates it today when the version is one that has not been tagged yet', async () => {
      const dir = taggedFixture();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--release-version', '9.9.9'] }));
      expect(lines.join('\n')).toContain(`9.9.9 (${new Date().toISOString().slice(0, 10)})`);
    });

    /** One rman did not write, or wrote before markers existed. Ordinary detection, which is where
     *  `catchUpFile` still earns its place - not the whole history, which would re-document
     *  everything the file already holds. */
    it('falls back to detection for a changelog file carrying no marker', async () => {
      const dir = taggedFixture();
      fs.writeFileSync(path.join(dir, 'packages/a/CHANGELOG.md'), '# Changelog\n\n## pkg-a 1.0.0\n\n- hand written\n');
      await captureLogs(() => runCli({ cwd: dir, argv: ['changelog', '--write'] }));

      const written = read(dir);
      expect(written).toContain('after the tag');
      expect(written).not.toContain('before the tag');
      expect(written).toContain('hand written');
    });
  });

  describe('--from-root', () => {
    it('generates for the whole repository even when run from inside a single package', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
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
        runCli({ cwd: path.join(dir, 'packages/a'), argv: ['changelog', '--from', baseHash, '--from-root'] }),
      );
      const joined = lines.join('\n');
      expect(joined).toMatch(headingFor('pkg-a'));
      expect(joined).toMatch(headingFor('pkg-b'));
    });
  });

  /**
   * `--scope /` end to end, through the real `Package.isRoot` - `package-filter.spec.ts` covers the
   * selector against fakes, which cannot tell whether "the root" is found the way the rule says.
   *
   * `changelog` is one of the two commands whose candidate list holds the root at all (`clean` is
   * the other), which is what makes the selector observable here.
   */
  describe('--scope / (the root package)', () => {
    async function repoWithRootEntry() {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
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
      /** A file under no package at all, which `owningPackage` resolves to the root - so the root
       *  has an entry of its own to select. Not the repo-wide route (`ownersOf`): that needs
       *  `BROAD_COMMIT_MIN_PACKAGES` = 3 packages before it fires at all, which would make this
       *  fixture about the threshold rather than about the selector. */
      fs.writeFileSync(path.join(dir, 'README.md'), 'readme');
      run('add', '-A');
      run('commit', '-q', '-m', 'feat: something at the root');
      return { dir, baseHash };
    }

    it('selects the root package alone', async () => {
      const { dir, baseHash } = await repoWithRootEntry();
      const lines = await captureLogs(() =>
        runCli({ cwd: dir, argv: ['changelog', '--from', baseHash, '--scope', '/'] }),
      );
      const joined = lines.join('\n');
      expect(joined).toContain('something at the root');
      expect(joined).not.toMatch(headingFor('pkg-a'));
      expect(joined).not.toMatch(headingFor('pkg-b'));
    });

    /**
     * The negative control, and the behaviour change `/` exists for: the root used to be reachable
     * by name, which is exactly what `.rmanrc`'s selectors refuse ("the root is never selected by
     * name"). Without this assertion the spec above passes whether or not the glob path still
     * matches the root.
     */
    it('and the root is no longer reachable by its own name', async () => {
      const { dir, baseHash } = await repoWithRootEntry();
      const lines = await captureLogs(() =>
        runCli({ cwd: dir, argv: ['changelog', '--from', baseHash, '--scope', 'root'] }),
      );
      expect(lines.join('\n')).not.toContain('something at the root');
    });

    it('--ignore / leaves every package but the root', async () => {
      const { dir, baseHash } = await repoWithRootEntry();
      const lines = await captureLogs(() =>
        runCli({ cwd: dir, argv: ['changelog', '--from', baseHash, '--ignore', '/'] }),
      );
      const joined = lines.join('\n');
      expect(joined).toMatch(headingFor('pkg-a'));
      expect(joined).not.toContain('something at the root');
    });
  });

  describe('auto-detect narration ("--from" omitted)', () => {
    /**
     * **No npm stub here, and none is needed** - which is worth stating, because this case used to
     * shim a fake `npm` onto `process.env.PATH` and the shim had stopped doing anything.
     *
     * The registry question belongs to the *ecosystem* now: `ChangeHashService.detect` asks the
     * package's own manifest provider for `publishedVersion`, and the core's test provider answers
     * from `registryVersions` - empty unless a spec fills it, so the answer is "never published"
     * and nothing reaches a network. The old comment even named `defaultNpmViewVersion`, a function
     * that no longer exists.
     *
     * Measured before deleting it: with the `PATH` line neutered the whole file is 56 passing,
     * exit 0. Deleting a stub that is load-bearing is how a suite starts shelling out to a real
     * binary, so the control came first.
     */
    it('narrates the boundary detection before generating, when --from is omitted', async () => {
      const { dir } = fixtureWithOneFeature();
      const lines = await captureLogs(() => runCli({ cwd: dir, argv: ['changelog'] }));
      expect(lines.some(l => l.includes("Detecting each package's last release..."))).toBe(true);
      /** Nothing is published, so detection falls back to "not yet pushed" and finds the real
       *  commit. */
      expect(lines.some(l => l.includes('a shiny new feature'))).toBe(true);
    });
  });
});
