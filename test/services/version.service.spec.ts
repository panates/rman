import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Repository } from '../../src/core/repository.js';
import { VersionService } from '../../src/services/version.service.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-version-test-'));
}

describe('services/version', () => {
  const dirs: string[] = [];
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function writeJson(dir: string, rel: string, data: unknown) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
  }

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

  function entryFor(plan: VersionService.Entry[], name: string): VersionService.Entry {
    const e = plan.find(p => p.package.name === name);
    if (!e) throw new Error(`no plan entry for "${name}"`);
    return e;
  }

  describe('getPlan() - severity auto-detection from commits', () => {
    it('a "fix:" commit implies patch', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'fix: a bug');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', from: '1.0.0', to: '1.0.1' });
    });

    it('a "feat:" commit implies minor', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'feat: a feature');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.1.0' });
    });

    it('a "feat!:" (breaking) commit implies major, even alongside a plain fix', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'fix: a bug');
      fs.writeFileSync(path.join(dir, 'y.txt'), 'y');
      commitAll(dir, 'feat!: a breaking feature');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '2.0.0' });
    });

    it('a "BREAKING CHANGE:" footer implies major, same as an inline "!" marker', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'feat: a feature\n\nBREAKING CHANGE: drops the old API entirely');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '2.0.0' });
    });

    describe('"Release-As: <severity>" footer override', () => {
      it('lets a "feat:" commit ship as a patch instead of triggering a minor', async () => {
        const dir = tmp();
        writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
        initGit(dir);
        commitAll(dir, 'init');
        fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
        commitAll(dir, 'feat: needs to ship now, not wait for the rest of the minor\n\nRelease-As: patch');

        const repo = await Repository.create(dir);
        const plan = await VersionService.getPlan(repo);
        expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.0.1' });
      });

      it("doesn't suppress a genuine later feat without an override in the same range", async () => {
        const dir = tmp();
        writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
        initGit(dir);
        commitAll(dir, 'init');
        fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
        commitAll(dir, 'feat: ship now\n\nRelease-As: patch');
        fs.writeFileSync(path.join(dir, 'y.txt'), 'y');
        commitAll(dir, 'feat: a real, un-overridden feature');

        const repo = await Repository.create(dir);
        const plan = await VersionService.getPlan(repo);
        expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.1.0' });
      });

      it('can also escalate a plain "fix:" up to major', async () => {
        const dir = tmp();
        writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
        initGit(dir);
        commitAll(dir, 'init');
        fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
        commitAll(dir, 'fix: actually a breaking fix\n\nRelease-As: major');

        const repo = await Repository.create(dir);
        const plan = await VersionService.getPlan(repo);
        expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '2.0.0' });
      });

      it('is case-insensitive', async () => {
        const dir = tmp();
        writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
        initGit(dir);
        commitAll(dir, 'init');
        fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
        commitAll(dir, 'feat: ship now\n\nrelease-as: PATCH');

        const repo = await Repository.create(dir);
        const plan = await VersionService.getPlan(repo);
        expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.0.1' });
      });
    });

    it('a non-conventional commit still defaults to patch (something changed)', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'just a plain message');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.0.1' });
    });

    it('a package with no real commits since its last tag reports no-change', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'no-change', from: '1.0.0' });
    });

    it('a bare version-bump commit ("1.0.1") is never mistaken for a real change', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pkg-a', version: '1.0.1' }));
      commitAll(dir, '1.0.1');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'no-change' });
    });

    it('a never-tagged package treats its entire history as unreleased, even with no remote at all', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'feat: first ever commit');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.1.0' });
    });
  });

  describe('explicit bump', () => {
    it('an explicit keyword overrides auto-detection for every changed package', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'feat: would normally be minor');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo, { bump: 'major' });
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ to: '2.0.0' });
    });

    it('an explicit semver version is used verbatim', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo, { bump: '9.9.9' });
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '9.9.9' });
    });

    it('an invalid bump value throws, naming what was expected', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      const repo = await Repository.create(dir);
      await expect(VersionService.getPlan(repo, { bump: 'nonsense' })).rejects.toThrow(/Invalid "bump"/);
    });
  });

  describe('--preid', () => {
    it('starts a fresh prerelease line for a patch severity', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'fix: a bug');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo, { preid: 'beta' });
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.0.1-beta.0' });
    });

    it('starts a fresh prerelease line for an explicit minor/major severity too', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo, { bump: 'major', preid: 'beta' });
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '2.0.0-beta.0' });
    });

    it('increments an existing prerelease with the same identifier instead of starting over', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.1-beta.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'fix: a bug');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo, { preid: 'beta' });
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.0.1-beta.1' });
    });

    it('switching to a different identifier starts a fresh prerelease instead of incrementing', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.1-beta.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'fix: a bug');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo, { preid: 'rc' });
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.0.2-rc.0' });
    });

    it('has no effect when bump is an explicit semver version', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo, { bump: '9.9.9', preid: 'beta' });
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '9.9.9' });
    });
  });

  describe('applyPlan() - "workspace:" protocol dependency ranges', () => {
    function fixture(pkgADependencyRange: string): string {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-a': pkgADependencyRange },
      });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      return dir;
    }

    function readDeps(dir: string, rel: string): Record<string, string> {
      return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf-8')).dependencies;
    }

    for (const selector of ['*', '^', '~']) {
      it(`leaves a bare "workspace:${selector}" range untouched after a bump`, async () => {
        const dir = fixture(`workspace:${selector}`);
        fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
        commitAll(dir, 'feat!: a breaking change in pkg-a');

        const repo = await Repository.create(dir);
        const plan = await VersionService.getPlan(repo);
        await VersionService.applyPlan(repo, plan);

        expect(readDeps(dir, 'packages/b/package.json')['pkg-a']).toBe(`workspace:${selector}`);
      });
    }

    it('bumps the embedded version of an explicit "workspace:<range>" dependency range', async () => {
      const dir = fixture('workspace:^1.0.0');
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'feat!: a breaking change in pkg-a');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      await VersionService.applyPlan(repo, plan);

      expect(readDeps(dir, 'packages/b/package.json')['pkg-a']).toBe('workspace:^2.0.0');
    });
  });

  describe('group propagation (a monorepo with two same-group packages)', () => {
    function fixture(): string {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-a': '^1.0.0' },
      });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      return dir;
    }

    it('patch: only the changed package bumps - an unrelated group-mate stays put', async () => {
      const dir = fixture();
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'fix: a bug in pkg-a');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.0.1' });
      expect(entryFor(plan, 'pkg-b')).toMatchObject({ status: 'no-change', from: '1.0.0' });
    });

    it('minor: the changed package AND its transitive in-group dependent both bump to the same version', async () => {
      const dir = fixture();
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'feat: a feature in pkg-a');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.1.0' });
      expect(entryFor(plan, 'pkg-b')).toMatchObject({ status: 'bump', to: '1.1.0' });
    });

    it('major: every group member bumps, changed or not', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' }); // unrelated, no dependency
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'feat!: a breaking change in pkg-a only');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '2.0.0' });
      expect(entryFor(plan, 'pkg-b')).toMatchObject({ status: 'bump', to: '2.0.0' });
    });

    it("a group's current version is the live highest among its members, never persisted", async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.5.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.5.0');
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'fix: bump from the higher baseline');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ to: '1.5.1' });
    });
  });

  describe('.rmanrc "group" - named groups and solo packages', () => {
    it('a named group keeps its own members in lockstep, independent of the repo default', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '2.0.0' });
      fs.writeFileSync(path.join(dir, 'packages/a/.rmanrc'), JSON.stringify({ group: 'core' }));
      fs.writeFileSync(path.join(dir, 'packages/b/.rmanrc'), JSON.stringify({ group: 'core' }));
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v2.0.0');
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'feat: a feature');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      // pkg-b has no dependency on pkg-a, so only minor's *dependent* cascade wouldn't apply -
      // but they share a named group, so this is really "unrelated packages, same group" (like the
      // repo-wide default group) - only the changed one moves unless severity forces the rest.
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '2.1.0', group: 'core' });
      expect(entryFor(plan, 'pkg-b')).toMatchObject({ status: 'no-change', group: 'core' });
    });

    it('group: false makes a package solo even when the rest of the repo defaults to grouped', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '5.0.0' });
      fs.writeFileSync(path.join(dir, 'packages/b/.rmanrc'), JSON.stringify({ group: false }));
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'packages/b/x.txt'), 'x');
      commitAll(dir, 'feat!: breaking in solo pkg-b');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      // pkg-b's own major bump must never sweep pkg-a in - they aren't in the same group at all.
      expect(entryFor(plan, 'pkg-b')).toMatchObject({ status: 'bump', to: '6.0.0' });
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'no-change' });
    });
  });

  describe('cross-group propagation', () => {
    it("a package depending on another group's bumped package always gets exactly a patch, from its own group's ceiling", async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/c/package.json', {
        name: 'pkg-c',
        version: '3.0.0',
        dependencies: { 'pkg-a': '^1.0.0' },
      });
      fs.writeFileSync(path.join(dir, 'packages/c/.rmanrc'), JSON.stringify({ group: 'plugins' }));
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'feat!: breaking change in pkg-a');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ to: '2.0.0' });
      // pkg-c does NOT jump to 2.0.0 - it gets a plain patch from its own group's own version line.
      expect(entryFor(plan, 'pkg-c')).toMatchObject({ status: 'bump', to: '3.0.1' });
      expect(entryFor(plan, 'pkg-c').reason).toContain('pkg-a');
    });

    it('a cross-group forced patch never cascades further within the receiving group', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/c/package.json', {
        name: 'pkg-c',
        version: '3.0.0',
        dependencies: { 'pkg-a': '^1.0.0' },
      });
      // pkg-d shares pkg-c's named group, but has no dependency relationship (direct or
      // transitive) to either pkg-c or pkg-a at all - only their shared group membership could
      // possibly sweep it in, and a patch must not do that.
      writeJson(dir, 'packages/d/package.json', { name: 'pkg-d', version: '3.0.0' });
      fs.writeFileSync(path.join(dir, 'packages/c/.rmanrc'), JSON.stringify({ group: 'plugins' }));
      fs.writeFileSync(path.join(dir, 'packages/d/.rmanrc'), JSON.stringify({ group: 'plugins' }));
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'fix: patch in pkg-a');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'pkg-c')).toMatchObject({ status: 'bump', to: '3.0.1' }); // forced patch
      expect(entryFor(plan, 'pkg-d')).toMatchObject({ status: 'no-change' }); // group-mate, but unrelated - never swept
    });
  });

  describe('root (monorepo) - informational only', () => {
    it('reflects the single shared version when every group ends up on the same one', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, version: '0.0.0', workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'fix: a bug');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'root')).toMatchObject({ status: 'bump', to: '1.0.1' });
    });

    it('reflects the overall highest version when groups diverge', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '9.0.0' });
      fs.writeFileSync(path.join(dir, 'packages/b/.rmanrc'), JSON.stringify({ group: 'other' }));
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0'); // establish a released baseline for both packages first
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'fix: only pkg-a changes');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ to: '1.0.1' });
      expect(entryFor(plan, 'pkg-b')).toMatchObject({ status: 'no-change' });
      expect(entryFor(plan, 'root')).toMatchObject({ status: 'bump', to: '9.0.0' });
    });

    it('is never included for a non-monorepo (single-package) repository', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'solo', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'fix: a bug');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(plan.some(e => e.package.name === 'root')).toBe(false);
      expect(entryFor(plan, 'solo')).toMatchObject({ status: 'bump', to: '1.0.1' });
    });

    it('reports no-change (not bump) when nothing in the repository changed at all', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'root')).toMatchObject({ status: 'no-change' });
    });
  });

  describe('dirty packages', () => {
    it('defaults to status "error" - a dirty package aborts the plan from being safely applied', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'packages/a/dirty.txt'), 'uncommitted');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'error' });
    });

    it('ignoreDirty: true downgrades it to "skip" instead, excluding just that package', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'packages/a/dirty.txt'), 'uncommitted');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo, { ignoreDirty: true });
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'skip' });
    });
  });

  describe('.rmanrc "release.skip"', () => {
    it('excludes the package entirely, even though it has real changes', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0', rman: { release: { skip: true } } });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'fix: a bug');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'skip', reason: 'excluded via .rmanrc "release.skip"' });
    });
  });

  describe('applyPlan()', () => {
    function fixtureWithOrigin(): { dir: string; originDir: string } {
      const dir = tmp();
      const originDir = tmp();
      fs.rmSync(originDir, { recursive: true, force: true });
      execFileSync('git', ['init', '-q', '--bare', originDir]);
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-a': '^1.0.0' },
      });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      git(dir, 'remote', 'add', 'origin', originDir);
      git(dir, 'branch', '-M', 'main');
      git(dir, 'push', '-u', 'origin', 'main', '-q');
      git(dir, 'push', '-q', 'origin', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'feat: a feature in pkg-a');
      return { dir, originDir };
    }

    it("writes the new version and refreshes a dependent's range, commits once per group, and tags", async () => {
      const { dir } = fixtureWithOrigin();
      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      await VersionService.applyPlan(repo, plan);

      const a = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      const b = JSON.parse(fs.readFileSync(path.join(dir, 'packages/b/package.json'), 'utf-8'));
      expect(a.version).toBe('1.1.0');
      expect(b.version).toBe('1.1.0');
      expect(b.dependencies['pkg-a']).toBe('^1.1.0');

      expect(git(dir, 'status', '--porcelain')).toBe('');
      expect(git(dir, 'tag', '--list', 'v1.1.0')).toBe('v1.1.0');
      const log = git(dir, 'log', '--format=%s');
      expect(log).toContain('chore(release): v1.1.0');
    });

    it('never pushes unless options.push is set', async () => {
      const { dir, originDir } = fixtureWithOrigin();
      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      await VersionService.applyPlan(repo, plan);

      const remoteTags = execFileSync('git', ['tag', '--list'], { cwd: originDir }).toString().trim();
      expect(remoteTags.split(/\s+/)).not.toContain('v1.1.0');
    });

    it('options.push: true pushes the resulting commit(s) and tag(s)', async () => {
      const { dir, originDir } = fixtureWithOrigin();
      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      await VersionService.applyPlan(repo, plan, { push: true });

      const remoteTags = execFileSync('git', ['tag', '--list'], { cwd: originDir }).toString().trim();
      expect(remoteTags.split(/\s+/)).toContain('v1.1.0');
    });

    it('runs a package\'s own real "version" npm script alongside the write (not instead of it)', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      const marker = path.join(dir, 'ran.txt');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        scripts: { version: `node -e 'require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")'` },
      });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'fix: a bug');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      await VersionService.applyPlan(repo, plan);

      expect(fs.existsSync(marker)).toBe(true);
      const a = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      expect(a.version).toBe('1.0.1'); // the write still happened - the script doesn't replace it
    });

    it('does nothing at all when the plan has no bumps', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      const before = git(dir, 'rev-parse', 'HEAD');
      await VersionService.applyPlan(repo, plan);
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(before);
    });

    it('a non-monorepo (single-package) repository writes and commits its own root package, not just the plan', async () => {
      // Regression: root is only ever the special, write-skipped "informational" entry inside a
      // *monorepo* - for a plain single-package repo it IS the one real package, and must go
      // through the normal write+commit+tag path like any other package would.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'solo', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'fix: a bug');

      const repo = await Repository.create(dir);
      const plan = await VersionService.getPlan(repo);
      await VersionService.applyPlan(repo, plan);

      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.1');
      expect(git(dir, 'status', '--porcelain')).toBe('');
      expect(git(dir, 'tag', '--list', 'v1.0.1')).toBe('v1.0.1');
    });
  });
});
