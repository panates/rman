import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { VersionPlanService } from '../../src/services/version-plan.service.js';
import { createRepository, planner, registryCalls, registryVersions, service, useTestEcosystem } from '../_fixture.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-version-test-'));
}

describe('services/version', () => {
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

  function entryFor(plan: VersionPlanService.Entry[], name: string): VersionPlanService.Entry {
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

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', from: '1.0.0', to: '1.0.1' });
    });

    it('a "feat:" commit implies minor', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'feat: a feature');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
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

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '2.0.0' });
    });

    it('a "BREAKING CHANGE:" footer implies major, same as an inline "!" marker', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'feat: a feature\n\nBREAKING CHANGE: drops the old API entirely');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
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

        const repo = await createRepository(dir);
        const plan = await planner().getPlan(repo);
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

        const repo = await createRepository(dir);
        const plan = await planner().getPlan(repo);
        expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.1.0' });
      });

      it('can also escalate a plain "fix:" up to major', async () => {
        const dir = tmp();
        writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
        initGit(dir);
        commitAll(dir, 'init');
        fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
        commitAll(dir, 'fix: actually a breaking fix\n\nRelease-As: major');

        const repo = await createRepository(dir);
        const plan = await planner().getPlan(repo);
        expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '2.0.0' });
      });

      it('is case-insensitive', async () => {
        const dir = tmp();
        writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
        initGit(dir);
        commitAll(dir, 'init');
        fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
        commitAll(dir, 'feat: ship now\n\nrelease-as: PATCH');

        const repo = await createRepository(dir);
        const plan = await planner().getPlan(repo);
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

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.0.1' });
    });

    it('a package with no real commits since its last tag reports no-change', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
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

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'no-change' });
    });

    it('a never-tagged package treats its entire history as unreleased, even with no remote at all', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'feat: first ever commit');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
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

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo, { bump: 'major' });
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ to: '2.0.0' });
    });

    it('an explicit semver version is used verbatim', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo, { bump: '9.9.9' });
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '9.9.9' });
    });

    it('an invalid bump value throws, naming what was expected', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      const repo = await createRepository(dir);
      await expect(planner().getPlan(repo, { bump: 'nonsense' })).rejects.toThrow(/Invalid "bump"/);
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

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo, { preid: 'beta' });
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.0.1-beta.0' });
    });

    it('starts a fresh prerelease line for an explicit minor/major severity too', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo, { bump: 'major', preid: 'beta' });
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

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo, { preid: 'beta' });
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

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo, { preid: 'rc' });
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.0.2-rc.0' });
    });

    it('has no effect when bump is an explicit semver version', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo, { bump: '9.9.9', preid: 'beta' });
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '9.9.9' });
    });
  });

  describe('group propagation (a monorepo with two same-group packages)', () => {
    function fixture(): string {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
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

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.0.1' });
      expect(entryFor(plan, 'pkg-b')).toMatchObject({ status: 'no-change', from: '1.0.0' });
    });

    it('minor: the changed package AND its transitive in-group dependent both bump to the same version', async () => {
      const dir = fixture();
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'feat: a feature in pkg-a');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.1.0' });
      expect(entryFor(plan, 'pkg-b')).toMatchObject({ status: 'bump', to: '1.1.0' });
    });

    it('major: every group member bumps, changed or not', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' }); // unrelated, no dependency
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'feat!: a breaking change in pkg-a only');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '2.0.0' });
      expect(entryFor(plan, 'pkg-b')).toMatchObject({ status: 'bump', to: '2.0.0' });
    });

    it("a group's current version is the live highest among its members, never persisted", async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.5.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.5.0');
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'fix: bump from the higher baseline');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ to: '1.5.1' });
    });
  });

  describe('.rmanrc "group" - named groups and solo packages', () => {
    it('a named group keeps its own members in lockstep, independent of the repo default', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '2.0.0' });
      fs.writeFileSync(path.join(dir, 'packages/a/.rmanrc'), JSON.stringify({ group: 'core' }));
      fs.writeFileSync(path.join(dir, 'packages/b/.rmanrc'), JSON.stringify({ group: 'core' }));
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v2.0.0');
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'feat: a feature');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      // pkg-b has no dependency on pkg-a, so only minor's *dependent* cascade wouldn't apply -
      // but they share a named group, so this is really "unrelated packages, same group" (like the
      // repo-wide default group) - only the changed one moves unless severity forces the rest.
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '2.1.0', group: 'core' });
      expect(entryFor(plan, 'pkg-b')).toMatchObject({ status: 'no-change', group: 'core' });
    });

    it('group: false makes a package solo even when the rest of the repo defaults to grouped', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '5.0.0' });
      fs.writeFileSync(path.join(dir, 'packages/b/.rmanrc'), JSON.stringify({ group: false }));
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'packages/b/x.txt'), 'x');
      commitAll(dir, 'feat!: breaking in solo pkg-b');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      // pkg-b's own major bump must never sweep pkg-a in - they aren't in the same group at all.
      expect(entryFor(plan, 'pkg-b')).toMatchObject({ status: 'bump', to: '6.0.0' });
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'no-change' });
    });
  });

  describe('cross-group propagation', () => {
    it("a package depending on another group's bumped package always gets exactly a patch, from its own group's ceiling", async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
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

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ to: '2.0.0' });
      // pkg-c does NOT jump to 2.0.0 - it gets a plain patch from its own group's own version line.
      expect(entryFor(plan, 'pkg-c')).toMatchObject({ status: 'bump', to: '3.0.1' });
      expect(entryFor(plan, 'pkg-c').reason).toContain('pkg-a');
    });

    it('a cross-group forced patch never cascades further within the receiving group', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
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

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      expect(entryFor(plan, 'pkg-c')).toMatchObject({ status: 'bump', to: '3.0.1' }); // forced patch
      expect(entryFor(plan, 'pkg-d')).toMatchObject({ status: 'no-change' }); // group-mate, but unrelated - never swept
    });
  });

  describe('root (monorepo) - informational only', () => {
    it('reflects the single shared version when every group ends up on the same one', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, version: '0.0.0', workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'fix: a bug');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      expect(entryFor(plan, 'root')).toMatchObject({ status: 'bump', to: '1.0.1' });
    });

    it('switches to a calendar version once groups diverge - the highest would stand still', async () => {
      // pkg-b sits on a higher line and doesn't move, so "highest version among the groups" would
      // report 9.0.0 both before and after: a release with no identity of its own to be named after.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, version: '9.0.0', workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '9.0.0' });
      fs.writeFileSync(path.join(dir, 'packages/b/.rmanrc'), JSON.stringify({ group: 'other' }));
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0'); // establish a released baseline for both packages first
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'fix: only pkg-a changes');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo, { now: () => new Date(2026, 8, 15, 14, 30) });
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ to: '1.0.1' });
      expect(entryFor(plan, 'pkg-b')).toMatchObject({ status: 'no-change' });
      expect(entryFor(plan, 'root')).toMatchObject({ status: 'bump', to: '2026.9.15-1430' });
    });

    it('stays on calendar once it is there, even if the repo falls back to a single group', async () => {
      // Going back would *lower* the root version (2026.9.15-1430 -> 1.0.1 compares as a decrease).
      const dir = tmp();
      writeJson(dir, 'package.json', {
        name: 'root',
        private: true,
        version: '2026.9.15-1430',
        workspaces: ['packages/*'],
      });
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'fix: a bug');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo, { now: () => new Date(2026, 8, 16, 9, 5) });
      expect(entryFor(plan, 'root')).toMatchObject({ status: 'bump', to: '2026.9.16-905' });
    });

    it('is never included for a non-monorepo (single-package) repository', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'solo', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'fix: a bug');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      expect(plan.some(e => e.package.name === 'root')).toBe(false);
      expect(entryFor(plan, 'solo')).toMatchObject({ status: 'bump', to: '1.0.1' });
    });

    it('reports no-change (not bump) when nothing in the repository changed at all', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      expect(entryFor(plan, 'root')).toMatchObject({ status: 'no-change' });
    });
  });

  describe('dirty packages', () => {
    it('defaults to status "error" - a dirty package aborts the plan from being safely applied', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'packages/a/dirty.txt'), 'uncommitted');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'error' });
    });

    it('ignoreDirty: true downgrades it to "skip" instead, excluding just that package', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'packages/a/dirty.txt'), 'uncommitted');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo, { ignoreDirty: true });
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'skip' });
    });
  });

  describe('.rmanrc "publish.skip"', () => {
    it('has no effect on version - the package still bumps normally', async () => {
      // Deliberately independent of publish/changelog: a package can be meaningfully versioned
      // even if it's never published, e.g. purely for internal tracking - see PublishService's
      // and ChangelogService's own "publish.skip" handling for the commands that DO respect it.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0', rman: { publish: { skip: true } } });
      initGit(dir);
      commitAll(dir, 'init');
      fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
      commitAll(dir, 'fix: a bug');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.0.1' });
    });
  });

  describe('boundary detection - the same detectChangeHash "changelog" measures from', () => {
    it("prefers the package's own reachable tag, without ever reaching for the npm registry", async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'feat: initial');
      git(dir, 'tag', 'v1.0.0');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'fix: a bug');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      /** A tag resolved the boundary, so the package's own ecosystem is never asked - the registry
       *  fallback exists for a package with *no* tag, and nothing else. */
      expect(registryCalls).toEqual([]);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.0.1', reason: 'changed since v1.0.0' });
    });

    it('falls back to what the ecosystem reports published when no tag is reachable from HEAD', async () => {
      // The tag exists but sits off HEAD's own ancestry (a release cut on another branch, history
      // rewritten since, ...) - so "git describe" finds nothing. Without the registry fallback
      // (`ManifestProvider.publishedVersion`) the whole history would read as unreleased, inflating
      // this patch into a minor off the "feat:" above.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'feat: initial');
      git(dir, 'checkout', '-q', '-b', 'side');
      fs.writeFileSync(path.join(dir, 'side.txt'), 's');
      commitAll(dir, 'chore: side work');
      git(dir, 'tag', 'v1.0.0');
      git(dir, 'checkout', '-q', '-');
      fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
      commitAll(dir, 'fix: a bug');

      const repo = await createRepository(dir);
      registryVersions.set('pkg-a', '1.0.0');
      const plan = await planner().getPlan(repo);
      expect(entryFor(plan, 'pkg-a')).toMatchObject({ status: 'bump', to: '1.0.1', reason: 'changed since v1.0.0' });
    });
  });

  describe('applyPlan()', () => {
    function fixtureWithOrigin(): { dir: string; originDir: string } {
      const dir = tmp();
      const originDir = tmp();
      fs.rmSync(originDir, { recursive: true, force: true });
      execFileSync('git', ['init', '-q', '--bare', originDir]);
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
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
      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      await service('version').applyPlan(plan);

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

    it("stamps each bumped package's Dockerfile version label into the same commit", async () => {
      // Otherwise every repo shipping an image repeats the same rewrite in its own build script -
      // and does it after the bump commit, leaving the tree dirty and git recording a stale label.
      const { dir } = fixtureWithOrigin();
      const dockerfile = path.join(dir, 'packages/a/Dockerfile');
      fs.writeFileSync(dockerfile, 'FROM node:22\nLABEL org.opencontainers.image.version="1.0.0"\n');
      commitAll(dir, 'chore: add a Dockerfile');

      const repo = await createRepository(dir);
      await service('version').applyPlan(await planner().getPlan(repo));

      expect(fs.readFileSync(dockerfile, 'utf-8')).toContain('org.opencontainers.image.version="1.1.0"');
      // In the bump commit, not left behind as a local edit for "publish" to trip over.
      expect(git(dir, 'status', '--porcelain')).toBe('');
      expect(git(dir, 'show', '--name-only', '--format=', 'HEAD')).toContain('packages/a/Dockerfile');
    });

    it('reads the same Dockerfile path "publish --target docker" builds from', async () => {
      const { dir } = fixtureWithOrigin();
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        rman: { publish: { target: ['docker'], docker: { image: 'x', dockerfile: 'docker/Dockerfile.prod' } } },
      });
      const dockerfile = path.join(dir, 'packages/a/docker/Dockerfile.prod');
      fs.mkdirSync(path.dirname(dockerfile), { recursive: true });
      fs.writeFileSync(dockerfile, 'LABEL org.opencontainers.image.version="1.0.0"\n');
      commitAll(dir, 'chore: add a Dockerfile');

      const repo = await createRepository(dir);
      await service('version').applyPlan(await planner().getPlan(repo));
      expect(fs.readFileSync(dockerfile, 'utf-8')).toContain('org.opencontainers.image.version="1.1.0"');
    });

    it('.rmanrc "version.stampDockerfile": false leaves the Dockerfile alone', async () => {
      const { dir } = fixtureWithOrigin();
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        rman: { version: { stampDockerfile: false } },
      });
      const dockerfile = path.join(dir, 'packages/a/Dockerfile');
      fs.writeFileSync(dockerfile, 'LABEL org.opencontainers.image.version="1.0.0"\n');
      commitAll(dir, 'chore: add a Dockerfile');

      const repo = await createRepository(dir);
      await service('version').applyPlan(await planner().getPlan(repo));
      expect(fs.readFileSync(dockerfile, 'utf-8')).toContain('org.opencontainers.image.version="1.0.0"');
    });

    it('stamps a .rmanrc "version.stamp" source constant into the same commit', async () => {
      // The source, not the build output: a build-time rewrite leaves the checked-in file claiming
      // a placeholder, so anything running from source reports it and git never records the release.
      const { dir } = fixtureWithOrigin();
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        rman: { version: { stamp: ['src/constants.ts'] } },
      });
      const constants = path.join(dir, 'packages/a/src/constants.ts');
      fs.mkdirSync(path.dirname(constants), { recursive: true });
      fs.writeFileSync(constants, "export const version = '1';\n");
      commitAll(dir, 'chore: add constants');

      const repo = await createRepository(dir);
      await service('version').applyPlan(await planner().getPlan(repo));

      expect(fs.readFileSync(constants, 'utf-8')).toBe("export const version = '1.1.0';\n");
      expect(git(dir, 'status', '--porcelain')).toBe('');
      expect(git(dir, 'show', '--name-only', '--format=', 'HEAD')).toContain('packages/a/src/constants.ts');
    });

    /**
     * `version.before`/`.exec`/`.after` take the same values `run.<script>` does, and must keep
     * doing so - they are the same three things, resolved by the same function now.
     *
     * `VersionService` used to carry its own `normalizeScriptValue`, which joined an array with
     * `' && '` into a single shell line and dropped anything that wasn't a string. Both had to go:
     * a function cannot be a term in a `&&` chain, and `cd x && y` in one process was never the
     * same as two steps anyway.
     */
    it('runs a function in a version hook, with the package it is versioning', async () => {
      const { dir } = fixtureWithOrigin();
      fs.writeFileSync(
        path.join(dir, '.rmanrc.cjs'),
        `module.exports = { '[*]': { version: { before: function note(ctx) {
           require('node:fs').writeFileSync(
             require('node:path').join(ctx.pkg.dirname, 'hook.txt'),
             ctx.pkg.name + ' @ ' + ctx.pkg.version,
           );
         } } } };\n`,
      );
      commitAll(dir, 'chore: add a version hook');

      const repo = await createRepository(dir);
      await service('version').applyPlan(await planner().getPlan(repo));

      /** Written *before* the bump, which is what `before` means - the assertion would pass either
       *  way if it only checked the file existed. */
      expect(fs.readFileSync(path.join(dir, 'packages/a/hook.txt'), 'utf-8')).toBe('pkg-a @ 1.0.0');
    });

    it('runs each entry of a hook list as its own step, rather than joining them with &&', async () => {
      const { dir } = fixtureWithOrigin();
      /**
       * The function writes through `ctx.cwd`, and that is the point of the case rather than an
       * incidental detail: a shell step is a child process and gets a real working directory, while
       * a function runs inside rman's own - which `run` never changes, since packages execute
       * concurrently and one `process.chdir()` would move the ground under the rest. Written as a
       * bare `'steps.txt'` this landed in the repository root while the two shell steps wrote to the
       * package (measured).
       */
      fs.writeFileSync(
        path.join(dir, '.rmanrc.cjs'),
        `module.exports = { '[pkg-a]': { version: { before: [
           'echo one >> steps.txt',
           function second(ctx) {
             const p = require('node:path').join(ctx.cwd, 'steps.txt');
             require('node:fs').appendFileSync(p, 'two\\n');
           },
           'echo three >> steps.txt',
         ] } } };\n`,
      );
      commitAll(dir, 'chore: add version hooks');

      const repo = await createRepository(dir);
      await service('version').applyPlan(await planner().getPlan(repo));

      // In order, and interleaved with the shell steps - which is what "not joined with &&" buys.
      const steps = fs.readFileSync(path.join(dir, 'packages/a/steps.txt'), 'utf-8').trim().split('\n');
      expect(steps).toEqual(['one', 'two', 'three']);
      expect(fs.existsSync(path.join(dir, 'steps.txt'))).toBe(false);
    });

    it('a listed file a package does not have is a silent no-op', async () => {
      // So one "[*]" declaration covers a repo where only some packages carry one.
      const { dir } = fixtureWithOrigin();
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        rman: { version: { stamp: ['src/constants.ts'] } },
      });
      commitAll(dir, 'chore: no constants file here');

      const repo = await createRepository(dir);
      await service('version').applyPlan(await planner().getPlan(repo));
      expect(git(dir, 'status', '--porcelain')).toBe('');
    });

    /**
     * The rewrite itself is `ManifestProvider.stampVersion`'s - how a version is *declared* is the
     * language's, not rman's. The fixture provider answers with the quoted-constant shape (the one
     * most languages share), so an identifier that is not literally `version` has to be named.
     */
    it('stamps a differently-named constant when the entry names it', async () => {
      const { dir } = fixtureWithOrigin();
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        rman: { version: { stamp: [{ file: 'src/version.go', constant: 'Version' }] } },
      });
      const file = path.join(dir, 'packages/a/src/version.go');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'const Version = "1.0.0"\n');
      commitAll(dir, 'chore: add a Go constant');

      const repo = await createRepository(dir);
      await service('version').applyPlan(await planner().getPlan(repo));

      expect(fs.readFileSync(file, 'utf-8')).toBe('const Version = "1.1.0"\n');
      expect(git(dir, 'status', '--porcelain')).toBe('');
    });

    /**
     * **A listed file that exists and holds nothing rewritable is refused, before anything is
     * written.** It used to be the same silent no-op as a missing file, which released a tagged
     * commit with a stale constant; and finding it *mid-write* left the manifest bumped on disk with
     * no commit and no tag (measured). It is a configuration mistake, so it is knowable first.
     */
    it('refuses a listed file whose version it cannot rewrite - before touching anything', async () => {
      const { dir } = fixtureWithOrigin();
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        rman: { version: { stamp: ['src/constants.ts'] } },
      });
      const constants = path.join(dir, 'packages/a/src/constants.ts');
      fs.mkdirSync(path.dirname(constants), { recursive: true });
      /** Capital `VERSION`, which the default shape does not reach unless the entry names it. */
      fs.writeFileSync(constants, "export const VERSION = '1';\n");
      commitAll(dir, 'chore: add constants');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      await expect(service('version').applyPlan(plan)).rejects.toThrow(/nothing in it could be rewritten/);

      /** Nothing was written: the manifest still reads the old version and the tree is clean. */
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8')).version).toBe('1.0.0');
      expect(git(dir, 'status', '--porcelain')).toBe('');
    });

    it('binds ${{ pkg.targetVersion }} in a version hook, and only there', async () => {
      // The version being written does not exist until the plan is computed, long after the config
      // was resolved - so these three paths are left raw at load and evaluated here.
      const { dir } = fixtureWithOrigin();
      const marker = path.join(dir, 'hook.txt');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        rman: {
          version: {
            after: `node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}', 'app:\${{ pkg.targetVersion }} was \${{ pkg.version }}')"`,
          },
        },
      });
      commitAll(dir, 'chore: add a hook');

      const repo = await createRepository(dir);
      await service('version').applyPlan(await planner().getPlan(repo));
      expect(fs.readFileSync(marker, 'utf-8')).toBe('app:1.1.0 was 1.0.0');
    });

    it('a config that names it outside a version hook fails to load at all', async () => {
      // Loudly, rather than evaluating to "undefined" and producing an `app:undefined` that looks
      // plausible - no other command has a target version to name.
      const { dir } = fixtureWithOrigin();
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        rman: { run: { deploy: 'echo ${{ pkg.targetVersion }}' } },
      });
      commitAll(dir, 'chore: misplace it');

      await expect(createRepository(dir)).rejects.toThrow(/targetVersion is only available while "version"/);
    });

    it('a package with no Dockerfile at all is unaffected', async () => {
      const { dir } = fixtureWithOrigin();
      const repo = await createRepository(dir);
      await service('version').applyPlan(await planner().getPlan(repo));
      expect(git(dir, 'status', '--porcelain')).toBe('');
    });

    it('never pushes unless options.push is set', async () => {
      const { dir, originDir } = fixtureWithOrigin();
      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      await service('version').applyPlan(plan);

      const remoteTags = execFileSync('git', ['tag', '--list'], { cwd: originDir }).toString().trim();
      expect(remoteTags.split(/\s+/)).not.toContain('v1.1.0');
    });

    it('options.push: true pushes the resulting commit(s) and tag(s)', async () => {
      const { dir, originDir } = fixtureWithOrigin();
      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      await service('version').applyPlan(plan, { push: true });

      const remoteTags = execFileSync('git', ['tag', '--list'], { cwd: originDir }).toString().trim();
      expect(remoteTags.split(/\s+/)).toContain('v1.1.0');
    });

    /**
     * **What it did, not the plan it was given.** `applyPlan` used to return that plan untouched,
     * so its only caller could re-print the table it had already shown while the commits, the tags
     * and the push stayed silent - the three things a reader does not already know.
     */
    describe('the result it reports', () => {
      it('names every commit it made, the root sync included, with its sha', async () => {
        const { dir } = fixtureWithOrigin();
        const repo = await createRepository(dir);
        const result = await service('version').applyPlan(await planner().getPlan(repo));

        /** Two: the root's informational sync, then the group's release - which is why `updated`
         *  does not count the root. A single "updated 2 packages" line used to imply two writes. */
        expect(result.commits).toHaveLength(2);
        expect(result.commits[0].message).toContain('sync root version');
        expect(result.commits[0].packages).toEqual([]);
        /** Both, in one commit: they share a group, and `pkg-b` is here because it depends on
         *  `pkg-a` - the commit carries whatever its group released. */
        expect(result.commits[1].packages).toEqual(['pkg-a', 'pkg-b']);
        for (const commit of result.commits) expect(commit.sha).toMatch(/^[0-9a-f]{7,}$/);
      });

      it('reports the tags it created, and says so when one was already there', async () => {
        const { dir } = fixtureWithOrigin();
        const repo0 = await createRepository(dir);
        const created = await service('version').applyPlan(await planner().getPlan(repo0));
        expect(created.tags).toEqual([{ name: 'v1.1.0', created: true }]);

        /**
         * The case `applyPlan`'s `tagExists` check exists for: a tag that is **not reachable from
         * HEAD**, so the boundary lookup does not see it (`git describe` for a repo-wide pattern)
         * while `git tag` does - a release cut on another branch. Putting it on HEAD instead makes
         * the *plan* empty, since the boundary then has no commits after it, and nothing is tagged
         * at all (measured, on the first version of this spec).
         */
        const other = fixtureWithOrigin();
        git(other.dir, 'checkout', '-q', '-b', 'side');
        fs.writeFileSync(path.join(other.dir, 'packages/a/side.txt'), 'side');
        commitAll(other.dir, 'chore: on the side');
        git(other.dir, 'tag', '-a', 'v1.1.0', '-m', 'v1.1.0');
        git(other.dir, 'checkout', '-q', 'main');

        const repo = await createRepository(other.dir);
        const result = await service('version').applyPlan(await planner().getPlan(repo));
        expect(result.tags).toEqual([{ name: 'v1.1.0', created: false }]);
      });

      it('says whether it pushed, which is otherwise indistinguishable', async () => {
        const a = fixtureWithOrigin();
        const repoA = await createRepository(a.dir);
        const quiet = await service('version').applyPlan(await planner().getPlan(repoA));
        expect(quiet.pushed).toBe(false);

        const b = fixtureWithOrigin();
        const repoB = await createRepository(b.dir);
        const pushed = await service('version').applyPlan(await planner().getPlan(repoB), {
          push: true,
        });
        expect(pushed.pushed).toBe(true);
      });

      it('counts only the packages actually written in "updated"', async () => {
        const { dir } = fixtureWithOrigin();
        const repo = await createRepository(dir);
        const result = await service('version').applyPlan(await planner().getPlan(repo));

        /** The plan holds the monorepo root's `'bump'` entry too - informational, never written, so
         *  three entries bump and two packages are updated. Reporting three was the old output's
         *  mistake: it listed the root as `updated root 1.0.0 -> 1.1.0`, which reads as a write. */
        expect(result.entries.filter(e => e.status === 'bump').map(e => e.package.name)).toEqual([
          'pkg-a',
          'pkg-b',
          'root',
        ]);
        expect(result.updated.map(e => e.package.name)).toEqual(['pkg-a', 'pkg-b']);
      });
    });

    it('runs a package\'s own real "version" npm script alongside the write (not instead of it)', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
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

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      await service('version').applyPlan(plan);

      expect(fs.existsSync(marker)).toBe(true);
      const a = JSON.parse(fs.readFileSync(path.join(dir, 'packages/a/package.json'), 'utf-8'));
      expect(a.version).toBe('1.0.1'); // the write still happened - the script doesn't replace it
    });

    it('does nothing at all when the plan has no bumps', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      initGit(dir);
      commitAll(dir, 'init');
      git(dir, 'tag', 'v1.0.0');

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      const before = git(dir, 'rev-parse', 'HEAD');
      await service('version').applyPlan(plan);
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

      const repo = await createRepository(dir);
      const plan = await planner().getPlan(repo);
      await service('version').applyPlan(plan);

      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      expect(pkg.version).toBe('1.0.1');
      expect(git(dir, 'status', '--porcelain')).toBe('');
      expect(git(dir, 'tag', '--list', 'v1.0.1')).toBe('v1.0.1');
    });
  });
});
