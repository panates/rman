import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Repository, VersionPlanService } from 'rman';
import { service, useNodeEcosystem } from '../_fixture.js';

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
}

/**
 * `packageJsonManifest.updateDependencyVersions` - what keeps a sibling's dependency range in step
 * after a bump.
 *
 * **Here rather than in rman's core**, where these cases used to live: npm's four dependency fields
 * and the `"workspace:"` protocol are this plugin's knowledge, and the core no longer contains the
 * string `workspace:` at all. `version` only calls `Manifest.updateDependencyVersions` and lets the
 * provider decide what a reference even looks like.
 */
describe('augmentation/manifest - dependency ranges after a bump', () => {
  useNodeEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function fixture(pkgADependencyRange: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-wsrange-test-'));
    dirs.push(dir);
    const write = (rel: string, data: unknown) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
    };
    write('package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    write('packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    write('packages/b/package.json', {
      name: 'pkg-b',
      version: '1.0.0',
      dependencies: { 'pkg-a': pkgADependencyRange },
    });
    git(dir, 'init', '-q');
    /**
     * Identity in the **repository's own config**, not passed per command with `-c`.
     *
     * The code under test commits too - `applyPlan` makes one commit per group plus the root's
     * version sync - and it has no way to be handed an identity. With only the fixture's own
     * commits configured, this passes on any machine with a global `user.email` and fails on a
     * fresh CI runner with `fatal: empty ident name`, which is exactly where it did fail.
     */
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'init');
    git(dir, 'tag', 'v1.0.0');
    return dir;
  }

  async function bumpPkgA(dir: string): Promise<void> {
    fs.writeFileSync(path.join(dir, 'packages/a/x.txt'), 'x');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'feat!: a breaking change in pkg-a');
    const repo = await Repository.create(dir);
    const plan = await VersionPlanService.getPlanner().getPlan(repo);
    await service('version').applyPlan(plan);
  }

  function readDeps(dir: string, rel: string): Record<string, string> {
    return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf-8')).dependencies;
  }

  it('rewrites a plain semver range to the new version', async () => {
    const dir = fixture('^1.0.0');
    await bumpPkgA(dir);
    expect(readDeps(dir, 'packages/b/package.json')['pkg-a']).toBe('^2.0.0');
  });

  /**
   * **The load-bearing case.** A bare selector resolves to the dependency's *current* version at
   * publish time (see `resolveWorkspaceRange`), so rewriting it would replace a live reference with
   * a frozen one.
   */
  for (const selector of ['*', '^', '~']) {
    it(`leaves a bare "workspace:${selector}" range untouched after a bump`, async () => {
      const dir = fixture(`workspace:${selector}`);
      await bumpPkgA(dir);
      expect(readDeps(dir, 'packages/b/package.json')['pkg-a']).toBe(`workspace:${selector}`);
    });
  }

  it('bumps the embedded version of an explicit "workspace:<range>" dependency range', async () => {
    const dir = fixture('workspace:^1.0.0');
    await bumpPkgA(dir);
    expect(readDeps(dir, 'packages/b/package.json')['pkg-a']).toBe('workspace:^2.0.0');
  });
});
