import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import type { VersionPlanService } from '../../../../src/services/version-plan.service.js';
import { createRepository, planner, useNodeEcosystem } from '../_fixture.js';

/**
 * **npm's own cascade table, which nothing tested until this file existed.**
 *
 * `NodeVersionPlanService.cascade` is one of the two decisions the core leaves to a technology, and
 * it decides how many of a group's packages a release touches - yet every existing case about
 * cascading lives in `services/version.service.spec.ts`, which runs on the fixture's
 * `TestVersionPlanService` and its *own* table. Those two agreed by coincidence until 2.4 changed
 * npm's answer for a patch, and the change came out green there while being invisible to it: the
 * first attempt edited npm's table and turned two of the core's cases red for the opposite reason.
 *
 * So this file asserts the npm answers specifically, through a repository carrying the node
 * platform.
 */
describe('plugins/node/NodeVersionPlanService cascade', () => {
  useNodeEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
  }

  function writeJson(dir: string, rel: string, value: unknown): void {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, undefined, 2));
  }

  /**
   * Three packages on one version line: `dep` depends on `base`, `solo` depends on nothing. That
   * third package is what separates the three answers from each other - with only a dependency pair
   * in the fixture, `dependents` and `group` are indistinguishable, which is exactly how the core's
   * own cases came to assert a title they did not test.
   */
  /* `config` is written **before** `git init`, deliberately: dropped in after the tag it would
   * leave the tree dirty, which makes every package `'error'` and aborts the plan, and it would
   * also put a commit of its own after the boundary. */
  function fixture(config: unknown = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-node-cascade-'));
    dirs.push(dir);
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    /** Marks the repository root, since `Workspace.findRoot` runs before any platform is asked
     *  what a package is. Empty by default, so `group: true` puts all three on one line. */
    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify(config));
    writeJson(dir, 'packages/base/package.json', { name: 'pkg-base', version: '1.0.0' });
    writeJson(dir, 'packages/dep/package.json', {
      name: 'pkg-dep',
      version: '1.0.0',
      dependencies: { 'pkg-base': '^1.0.0' },
    });
    writeJson(dir, 'packages/solo/package.json', { name: 'pkg-solo', version: '1.0.0' });
    git(dir, 'init');
    /** Set in the repository's own config rather than per command: `applyPlan` commits too and
     *  cannot be handed an identity, so a fixture configuring only its own commits passes on a
     *  machine with a global identity and fails on a fresh runner with `empty ident name`. */
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'init');
    git(dir, 'tag', 'v1.0.0');
    return dir;
  }

  async function planAfter(subject: string, config: unknown = {}): Promise<VersionPlanService.Entry[]> {
    const dir = fixture(config);
    fs.writeFileSync(path.join(dir, 'packages/base/x.txt'), 'x');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', subject);
    const repo = await createRepository(dir);
    return planner().getPlan(repo);
  }

  const statusOf = (plan: VersionPlanService.Entry[], name: string) => {
    const entry = plan.find(e => e.package.name === name);
    return entry && { status: entry.status, to: entry.to };
  };

  /**
   * **`patch` answered `'changed'` until 2.4**, on reasoning that is right about ranges and
   * incomplete: `^1.0.0` does resolve to `1.0.1`, so a consumer receives the fix with nothing
   * downstream released - but `pkg-dep`'s own published artifact was built against the old code,
   * and anything bundling or vendoring it kept shipping the pre-fix version, because under that
   * default nothing ever released it again.
   *
   * `pkg-solo` staying put is the negative control, and the only thing separating this from
   * `group`.
   */
  it('patch: the changed package and its in-group dependents, not an unrelated member', async () => {
    const plan = await planAfter('fix: a bug in pkg-base');
    expect(statusOf(plan, 'pkg-base')).toEqual({ status: 'bump', to: '1.0.1' });
    expect(statusOf(plan, 'pkg-dep')).toEqual({ status: 'bump', to: '1.0.1' });
    expect(statusOf(plan, 'pkg-solo')).toEqual({ status: 'no-change', to: undefined });
  });

  /** Unchanged by 2.4, and here so the table is pinned as a whole rather than at the one entry that
   *  moved - a later edit flipping `minor` has to turn something red. */
  it('minor: the same set, since a dependent is only correct once its own floor ships', async () => {
    const plan = await planAfter('feat: a feature in pkg-base');
    expect(statusOf(plan, 'pkg-base')).toEqual({ status: 'bump', to: '1.1.0' });
    expect(statusOf(plan, 'pkg-dep')).toEqual({ status: 'bump', to: '1.1.0' });
    expect(statusOf(plan, 'pkg-solo')).toEqual({ status: 'no-change', to: undefined });
  });

  /** The whole group, `pkg-solo` included: a breaking change restates every member's
   *  compatibility, and a member left at `1.0.0` would publish a `^1.0.0` range its own group no
   *  longer satisfies. */
  it('major: every member, including one that depends on nothing', async () => {
    const plan = await planAfter('feat!: breaking in pkg-base');
    expect(statusOf(plan, 'pkg-base')).toEqual({ status: 'bump', to: '2.0.0' });
    expect(statusOf(plan, 'pkg-dep')).toEqual({ status: 'bump', to: '2.0.0' });
    expect(statusOf(plan, 'pkg-solo')).toEqual({ status: 'bump', to: '2.0.0' });
  });

  /**
   * **`version.cascade` widens npm's answer, which is the only direction it may go** - and `group`
   * on a patch is what a repository releasing one number for its whole product needs (measured on
   * `panates/sqb`: 17 packages all published at 6.0.10, where a `fix:` in two of them would
   * otherwise leave the other fifteen behind permanently).
   */
  it('version.cascade "group" reaches an unrelated member on a patch', async () => {
    const plan = await planAfter('fix: a bug in pkg-base', { version: { cascade: 'group' } });
    expect(statusOf(plan, 'pkg-base')).toEqual({ status: 'bump', to: '1.0.1' });
    expect(statusOf(plan, 'pkg-solo')).toEqual({ status: 'bump', to: '1.0.1' });
  });

  /**
   * **And `changed` is a no-op under npm, not a narrowing.** The key is a floor; npm's patch answer
   * is already wider, so writing the narrowest value cannot take `pkg-dep` away. This is the case
   * somebody would actually try after reading the three choices, which is why it is pinned.
   */
  it('version.cascade "changed" cannot narrow npm, so a patch still reaches the dependent', async () => {
    const plan = await planAfter('fix: a bug in pkg-base', { version: { cascade: 'changed' } });
    expect(statusOf(plan, 'pkg-dep')).toEqual({ status: 'bump', to: '1.0.1' });
    expect(statusOf(plan, 'pkg-solo')).toEqual({ status: 'no-change', to: undefined });
  });
});
