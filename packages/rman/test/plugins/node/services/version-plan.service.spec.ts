import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { NodeManifestProvider } from '../../../../src/builtins/platforms/node/node-manifest.provider.js';
import type { VersionPlanService } from '../../../../src/services/version-plan.service.js';
import { createRepository, planner, service, useNodeEcosystem } from '../_fixture.js';

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

/**
 * **npm's `private` rule keeps a package out of `version` too**, through the npm target's own
 * `skipReason` - the same answer `publish` and `rman list` give, so the three cannot disagree about
 * whether a package ships. A `private` package that declares a `publishConfig` is a source guard on
 * something set up to publish from its build directory, and is versioned like any other.
 */
describe('plugins/node: a private package and version', () => {
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

  it('skips a private package, and versions one whose private only guards the source', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-node-private-'));
    dirs.push(dir);
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ group: false }));
    writeJson(dir, 'packages/app/package.json', { name: 'app', version: '1.0.0', private: true });
    writeJson(dir, 'packages/lib/package.json', {
      name: 'lib',
      version: '1.0.0',
      private: true,
      /** Published from a build directory, so `private` guards only the source - see npm's
       *  `skipReason`, which keeps a private package published in place private. */
      publishConfig: { access: 'public', directory: 'build' },
    });
    git(dir, 'init');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'init');
    git(dir, 'tag', 'app@1.0.0');
    git(dir, 'tag', 'lib@1.0.0');
    for (const name of ['app', 'lib']) fs.writeFileSync(path.join(dir, `packages/${name}/x.txt`), 'x');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'fix: both');

    const repo = await createRepository(dir);
    const plan = await planner().getPlan(repo);
    const app = plan.find(e => e.package.name === 'app')!;
    expect(app).toMatchObject({ status: 'skip' });
    expect(app.reason).toMatch(/private/);
    expect(plan.find(e => e.package.name === 'lib')).toMatchObject({ status: 'bump', to: '1.0.1' });
  });
});

/**
 * **`.rmanrc "version.dependentRanges": keep`** - a hand-written range is left alone while it
 * accepts the new version, refused when it does not, and has its floor raised when its package is
 * released for changes of its own. Asked for by `panates/syncbridge`, whose extensions declare
 * `"@syncbridge/common": ">=1.1.0 <2"` so a release of `common` need not release all nine.
 */
describe('plugins/node: version.dependentRanges keep', () => {
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

  const readJson = (dir: string, rel: string) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf-8'));

  /** syncbridge's shape: independent versioning, an extension ranging over `common`. */
  function fixture(
    config: Record<string, unknown> = { version: { dependentRanges: 'keep' } },
    extRange = '>=1.1.0 <2',
  ): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-node-ranges-'));
    dirs.push(dir);
    writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
    fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ group: false, ...config }));
    writeJson(dir, 'packages/common/package.json', { name: 'common', version: '1.1.0' });
    writeJson(dir, 'packages/ext/package.json', {
      name: 'ext',
      version: '1.0.0',
      peerDependencies: { common: extRange },
      devDependencies: { common: 'workspace:^' },
    });
    git(dir, 'init');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', 'init');
    git(dir, 'tag', 'common@1.1.0');
    git(dir, 'tag', 'ext@1.0.0');
    /** The release boundary a `group: true` variant reads - one version line tags `v*`. */
    git(dir, 'tag', 'v1.1.0');
    return dir;
  }

  function commit(dir: string, pkg: string, subject: string): void {
    fs.appendFileSync(path.join(dir, `packages/${pkg}/x.txt`), subject);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-m', subject);
  }

  const entryOf = (plan: VersionPlanService.Entry[], name: string) => plan.find(e => e.package.name === name)!;

  it('leaves a dependent alone while its range accepts the new version, and says why', async () => {
    const dir = fixture();
    commit(dir, 'common', 'feat: something new');
    const repo = await createRepository(dir);
    const plan = await planner().getPlan(repo);

    expect(entryOf(plan, 'common')).toMatchObject({ status: 'bump', to: '1.2.0' });
    expect(entryOf(plan, 'ext')).toMatchObject({ status: 'no-change' });
    expect(entryOf(plan, 'ext').reason).toMatch(/common ">=1.1.0 <2" still satisfied/);

    await service('version').applyPlan(plan);
    expect(readJson(dir, 'packages/ext/package.json').peerDependencies.common).toBe('>=1.1.0 <2');
  });

  /** The control: the same repository under `rewrite` releases the dependent for it. */
  it('releases it under the default, as before', async () => {
    const dir = fixture({});
    commit(dir, 'common', 'feat: something new');
    const repo = await createRepository(dir);
    const plan = await planner().getPlan(repo);
    expect(entryOf(plan, 'ext')).toMatchObject({ status: 'bump', to: '1.0.1' });
  });

  /**
   * **A range that no longer accepts its sibling is moved to the next window**, and the dependent
   * is released for it as under `rewrite`. It was refused instead, and measured wrong on
   * `panates/syncbridge`: a `common` major refused four packages of its own group for `^1.1.4`,
   * though every one was already planned for 2.0.0.
   */
  it('moves a range that does not accept the new version, and releases its package', async () => {
    const dir = fixture();
    commit(dir, 'common', 'feat!: breaking');
    const repo = await createRepository(dir);
    const plan = await planner().getPlan(repo);

    const ext = entryOf(plan, 'ext');
    expect(ext).toMatchObject({ status: 'bump', to: '1.0.1' });
    expect(ext.reason).toContain('range moved: common ">=1.1.0 <2" -> ">=2.0.0 <3"');

    await service('version').applyPlan(plan);
    expect(readJson(dir, 'packages/ext/package.json').peerDependencies.common).toBe('>=2.0.0 <3');
  });

  /** Inside one version line the whole group moves on a major - the case syncbridge hit. */
  it('moves an in-group caret range to the group major', async () => {
    const dir = fixture({ group: true, version: { dependentRanges: 'keep' } }, '^1.1.0');
    commit(dir, 'common', 'feat!: breaking');
    const repo = await createRepository(dir);
    const plan = await planner().getPlan(repo);
    expect(entryOf(plan, 'ext')).toMatchObject({ status: 'bump', to: '2.0.0' });

    await service('version').applyPlan(plan);
    expect(readJson(dir, 'packages/ext/package.json').peerDependencies.common).toBe('^2.0.0');
  });

  /** A shape with no single window to move - `||` - is still refused, naming what to fix by hand. */
  it('refuses a range whose shape cannot be moved, naming the field, the range and the version', async () => {
    const dir = fixture(undefined, '^1.1.0 || ^1.5.0');
    commit(dir, 'common', 'feat!: breaking');
    const repo = await createRepository(dir);
    const plan = await planner().getPlan(repo);

    const ext = entryOf(plan, 'ext');
    expect(ext.status).toBe('error');
    expect(ext.reason).toContain('peerDependencies "common": "^1.1.0 || ^1.5.0" does not accept 2.0.0');
  });

  /** Kept out of versioning, its range still moves - npm workspaces would otherwise install the
   *  sibling from the registry - and the edit rides the root's sync commit, leaving no dirty tree. */
  it('moves the range of a package kept out of versioning, and commits it', async () => {
    const dir = fixture({ version: { dependentRanges: 'keep' }, '[ext]': { publish: { skip: true } } });
    commit(dir, 'common', 'feat!: breaking');
    const repo = await createRepository(dir);
    const plan = await planner().getPlan(repo);
    expect(entryOf(plan, 'ext').status).toBe('skip');

    await service('version').applyPlan(plan);
    const ext = readJson(dir, 'packages/ext/package.json');
    expect(ext.peerDependencies.common).toBe('>=2.0.0 <3');
    expect(ext.version).toBe('1.0.0');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString().trim()).toBe('');
  });

  /** A beta is never meant for a stable range, so it neither fails one nor moves one. */
  it('lets a prerelease through without failing or touching the range', async () => {
    const dir = fixture();
    commit(dir, 'common', 'feat!: breaking');
    const repo = await createRepository(dir);
    const plan = await planner().getPlan(repo, { preid: 'beta' });
    expect(entryOf(plan, 'common')).toMatchObject({ status: 'bump', to: '2.0.0-beta.0' });
    expect(entryOf(plan, 'ext').status).toBe('no-change');
  });

  /**
   * **Released for a change of its own, the dependent's floor follows what it was built against** -
   * the only time it can have started relying on something new. The upper bound stays, and the
   * `workspace:^` reference, which follows the sibling by itself, is not touched.
   */
  it('raises the floor of a dependent released for its own change', async () => {
    const dir = fixture();
    commit(dir, 'common', 'feat: something new');
    commit(dir, 'ext', 'feat: uses it');
    const repo = await createRepository(dir);
    const plan = await planner().getPlan(repo);
    expect(entryOf(plan, 'ext')).toMatchObject({ status: 'bump', to: '1.1.0' });

    await service('version').applyPlan(plan);
    const ext = readJson(dir, 'packages/ext/package.json');
    expect(ext.peerDependencies.common).toBe('>=1.2.0 <2');
    expect(ext.devDependencies.common).toBe('workspace:^');
  });

  /** Inside one version line the same rule holds: npm's `dependents` cascade skips a dependent
   *  whose range still accepts the group's new version. */
  it('keeps an in-group dependent out of the cascade while its range accepts', async () => {
    const dir = fixture({ group: true, version: { dependentRanges: 'keep' } });
    commit(dir, 'common', 'fix: a bug');
    const repo = await createRepository(dir);
    const plan = await planner().getPlan(repo);
    expect(entryOf(plan, 'common')).toMatchObject({ status: 'bump' });
    expect(entryOf(plan, 'ext').status).toBe('no-change');
  });
});

describe('plugins/node: NodeManifestProvider.referencesTo', () => {
  const provider = new NodeManifestProvider();
  const refs = (range: string, version: string) =>
    provider.referencesTo({ name: 'x', version: '1.0.0', raw: { dependencies: { dep: range } } }, 'dep', version)[0];

  it('raises the floor of the shapes a hand-written range takes, keeping the upper bound', () => {
    expect(refs('^1.1.0', '1.2.0')).toMatchObject({ accepts: true, raised: '^1.2.0' });
    expect(refs('~1.1.0', '1.1.3')).toMatchObject({ accepts: true, raised: '~1.1.3' });
    expect(refs('>=1.1.0', '1.4.0')).toMatchObject({ accepts: true, raised: '>=1.4.0' });
    expect(refs('>=1.1.0 <2', '1.2.0')).toMatchObject({ accepts: true, raised: '>=1.2.0 <2' });
    expect(refs('1.1.0 - 1.9.0', '1.2.0')).toMatchObject({ accepts: true, raised: '1.2.0 - 1.9.0' });
    expect(refs('workspace:>=1.1.0 <2', '1.2.0')).toMatchObject({ accepts: true, raised: 'workspace:>=1.2.0 <2' });
  });

  it('leaves a floor already there, and refuses to guess at an alternative', () => {
    expect(refs('^1.2.0', '1.2.0').raised).toBeUndefined();
    expect(refs('1.2.0', '1.2.0').raised).toBeUndefined();
    expect(refs('^1.0.0 || ^2.0.0', '1.2.0')).toMatchObject({ accepts: true, unraisable: true });
    expect(refs('>=1.1.0 <2', '2.0.0')).toMatchObject({ accepts: false, rewritten: '>=2.0.0 <3' });
    expect(refs('^1.1.4', '2.0.0')).toMatchObject({ accepts: false, rewritten: '^2.0.0' });
    expect(refs('~1.1.4', '1.2.0')).toMatchObject({ accepts: false, rewritten: '~1.2.0' });
    expect(refs('1.1.4', '2.0.0')).toMatchObject({ accepts: false, rewritten: '2.0.0' });
    expect(refs('workspace:^1.1.4', '2.0.0')).toMatchObject({ accepts: false, rewritten: 'workspace:^2.0.0' });
    expect(refs('>=1.1.0 <3', '3.0.0').rewritten).toBeUndefined();
    expect(refs('^1.0.0 || ^1.5.0', '2.0.0').rewritten).toBeUndefined();
    expect(refs('workspace:^', '9.0.0')).toMatchObject({ dynamic: true, accepts: true });
  });
});
