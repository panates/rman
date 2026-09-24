import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import type { ManifestProvider } from '../../src/core/manifest.js';
import type { Package } from '../../src/core/package.js';
import { definePlatform, type Platform } from '../../src/core/plugin.js';
import { VersionPlanService } from '../../src/services/version-plan.service.js';
import { createRepository, planner, usePlugin, useTestEcosystem } from '../_fixture.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-polyglot-plan-'));
}

/** What the second technology's planner was asked, so a spec can assert it was asked *at all*. */
const asked: { boundary: string[]; cascade: string[] } = { boundary: [], cascade: [] };

/**
 * A second ecosystem's planner, deliberately answering **differently** from the fixture's on both
 * abstract members - which is the only way to tell whose answer was used.
 *
 * `detectBoundary` returns nothing (so every commit reads as unreleased, like a package whose
 * registry has never heard of it) and `cascade` always reaches the whole group, the way an
 * ecosystem pinning exact versions must.
 */
class OtherPlanService extends VersionPlanService {
  protected async detectBoundary(_git: unknown, pkg: Package): Promise<string | undefined> {
    asked.boundary.push(pkg.name);
    return undefined;
  }

  protected cascade(bump: string): VersionPlanService.Cascade {
    asked.cascade.push(bump);
    return 'group';
  }
}

/** Claims a directory only by its own marker file, so every other package is left to the fixture's
 *  reader - one repository, two ecosystems. */
const otherManifest: ManifestProvider = {
  name: 'other',
  fileName: 'other.json',
  read(dir) {
    const file = path.join(dir, 'other.json');
    if (!fs.existsSync(file)) return undefined;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return { name: raw.name, version: raw.version, private: false, raw };
  },
  write() {},
  dependencies: () => [],
};

const otherPlatform: Platform = definePlatform({
  name: 'other',
  manifestProvider: otherManifest,
  versionPlanner: new OtherPlanService(),
});

/**
 * **Which planner answers for a package is the package's own technology's.**
 *
 * `app.versionPlanner` is a single slot - last registration wins - and it used to answer
 * `detectBoundary` and `cascade` for *every* package. In a repository holding two ecosystems that
 * made both of them whichever plugin happened to register last: a Cargo package's boundary fell
 * back to `npm view`, and its cascade assumed npm's caret ranges. Same shape as the hardcoded
 * `['npm']` publish default, same fix - ask the technology that read the manifest.
 *
 * The orchestration stays with one planner, because a plan is computed for the whole repository at
 * once: groups span packages and the ripple crosses them.
 */
describe('services/version-plan: a polyglot repository', () => {
  useTestEcosystem();
  usePlugin(otherPlatform);
  beforeEach(() => {
    asked.boundary.length = 0;
    asked.cascade.length = 0;
  });

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function git(dir: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();
  }

  /**
   * A repository with one package of each technology, in one group, both with a commit.
   *
   * `pkg-other` carries a `package.json` too - the fixture's workspace provider only lists
   * directories that have one - but its `other.json` is what decides the technology, because that
   * stack is asked first.
   */
  function fixture(): string {
    const dir = mkTmp();
    dirs.push(dir);
    const write = (rel: string, data: unknown) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
    };
    write('package.json', { name: 'root', private: true, version: '1.0.0', workspaces: ['packages/*'] });
    fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
    write('packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
    write('packages/other/package.json', { name: 'pkg-other', version: '1.0.0' });
    write('packages/other/other.json', { name: 'pkg-other', version: '1.0.0' });

    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t.com');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'chore: init');
    /**
     * **The tag is what makes the two boundaries differ, and that is the point.** The fixture's
     * planner detects it (`ChangeHashService`, `v*` through `git describe`), so `pkg-a` has nothing
     * unreleased. This technology's returns `undefined` regardless, so `pkg-other` reads its whole
     * history - a package whose registry has never heard of it. One repository, two answers.
     */
    git(dir, 'tag', 'v1.0.0');
    fs.writeFileSync(path.join(dir, 'packages/other/x.txt'), 'x');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'feat: something in the other ecosystem');
    return dir;
  }

  it('reads each package as the technology that claimed it', async () => {
    const repo = await createRepository(fixture());
    expect(repo.getPackage('pkg-a')?.provider).toBe('test');
    expect(repo.getPackage('pkg-other')?.provider).toBe('other');
  });

  it("asks each package's own planner for its boundary, not the last one registered", async () => {
    const repo = await createRepository(fixture());
    await planner().getPlan(repo);
    /** The fixture's stack is registered last and is the orchestrator, so before this change its
     *  planner answered for both. Only the package this one claimed reaches it. */
    expect(asked.boundary).toEqual(['pkg-other']);
  });

  /**
   * The two answers differ on purpose: the fixture's `cascade` returns `'dependents'` for a minor
   * and this one returns `'group'`. Taking the widest is the deliberate direction - a cascade that
   * is too narrow releases too little, which `cascade`'s own doc calls the invisible failure, while
   * one that is too wide releases a package that did not strictly need it.
   */
  it('takes the widest cascade when a group holds two technologies', async () => {
    const repo = await createRepository(fixture());
    const plan = await planner().getPlan(repo);
    expect(asked.cascade.length).toBeGreaterThan(0);

    /** `pkg-a` has no commit of its own; `'group'` is what reaches it, `'dependents'` would not -
     *  it depends on nothing. */
    const a = plan.find(e => e.package.name === 'pkg-a');
    expect([a?.status, a?.reason]).toEqual(['bump', expect.stringContaining('in-group member')]);
  });
});
