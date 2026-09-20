import fs from 'node:fs';
import path from 'node:path';
import glob from 'fast-glob';
import { runCli as cliRunCli } from '../src/cli.js';
import { RmanApplication } from '../src/core/application.js';
import type { ManifestProvider } from '../src/core/manifest.js';
import type { Package } from '../src/core/package.js';
import type { PublishTarget } from '../src/core/publish-target.js';
import { Repository } from '../src/core/repository.js';
import type { ServiceMap } from '../src/core/service.js';
import { baseTechStack, type TechStack } from '../src/core/tech-stack.js';
import { Workspace } from '../src/core/workspace.js';
import { ChangeHashService } from '../src/services/change-hash.service.js';
import { RunService } from '../src/services/run.service.js';
import { VersionPlanService } from '../src/services/version-plan.service.js';
import type { GitHelper } from '../src/utils/git.js';
import { stampVersionConstant } from '../src/utils/version-stamp.js';

/**
 * The ecosystem rman's **core** specs run against.
 *
 * The core has no manifest provider, no workspace provider and no version planner of its own - that
 * is the whole point of the plugin seams - so a core spec has to bring one. It cannot borrow
 * `rman-node`'s: that package *depends on* this one, so importing it here would invert the build
 * order and make the core's tests pass only because its own plugin happened to be correct.
 *
 * This provider reads `package.json`, and that is a fixture convenience rather than a statement: the
 * specs were written writing that file, and a synthetic format would mean rewriting thirty of them
 * to prove something [`ecosystem-agnostic.spec.ts`](core/ecosystem-agnostic.spec.ts) proves
 * directly instead, with a format that is nobody's. What matters here is that the *core* reads it
 * only through the seam - the provider is named `'test'`, not `'node'`, and nothing in `src/` knows
 * this file exists.
 */
export const testManifest: ManifestProvider = {
  name: 'test',
  fileName: 'package.json',

  read(dir) {
    const file = path.join(dir, 'package.json');
    if (!fs.existsSync(file)) return undefined;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return {
      name: typeof raw?.name === 'string' && raw.name ? raw.name : path.basename(dir),
      version: typeof raw?.version === 'string' && raw.version ? raw.version : '0.0.0',
      private: !!raw?.private,
      raw: raw ?? {},
    };
  },

  write(dir, manifest) {
    const raw = { ...manifest.raw, version: manifest.version };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(raw, undefined, 2) + '\n', 'utf-8');
  },

  dependencies(manifest, candidates) {
    const declared = Object.assign({}, ...DEPENDENCY_KEYS.map(key => manifest.raw[key]));
    const byName = new Map(candidates.map(p => [p.name, p]));
    const result: Package[] = [];
    for (const name of Object.keys(declared)) {
      const pkg = byName.get(name);
      if (pkg && !result.includes(pkg)) result.push(pkg);
    }
    return result;
  },

  /** What the fixture's "registry" reports - see `registryVersions`. This is the seam the specs
   *  that used to inject an `npmViewVersion` function now use, and it exercises the real path
   *  (`ChangeHashService.detect` asking the provider) instead of bypassing it. */
  async publishedVersion(pkg) {
    registryCalls.push(pkg.name);
    return registryVersions.get(pkg.name);
  },

  /** The quoted-constant shape, via the helper the core exports for exactly this - so a core spec
   *  can exercise `version.stamp` without `rman-node`. `constant` comes from the config entry. */
  stampVersion(_file, content, version, options) {
    return stampVersionConstant(content, version, options?.constant);
  },

  splitName(name) {
    const at = name.lastIndexOf('/');
    return at > 0 ? { scope: name.slice(0, at), unscopedName: name.slice(at + 1) } : { unscopedName: name };
  },

  updateDependencyVersions(manifest, bumped) {
    const versionByName = new Map([...bumped].map(([pkg, version]) => [pkg.name, version]));
    for (const key of DEPENDENCY_KEYS) {
      const deps = manifest.raw[key];
      if (!deps) continue;
      for (const depName of Object.keys(deps)) {
        const to = versionByName.get(depName);
        if (to) deps[depName] = '^' + to;
      }
    }
  },
};

/** Packages from the root manifest's `workspaces` globs - the shape the fixtures write. */
export const testWorkspace: Workspace.Provider = (root: string): Workspace.Layout | undefined => {
  const file = path.join(root, 'package.json');
  if (!fs.existsSync(file)) return undefined;
  let patterns: unknown;
  try {
    patterns = JSON.parse(fs.readFileSync(file, 'utf-8'))?.workspaces;
  } catch {
    return undefined;
  }
  if (!Array.isArray(patterns)) return undefined;

  const packageDirs: string[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    const dirs = glob.sync(pattern, { cwd: root, absolute: true, deep: 0, onlyDirectories: true });
    for (const dir of dirs) if (fs.existsSync(path.join(dir, 'package.json'))) packageDirs.push(dir);
  }
  return { root, packageDirs };
};

/**
 * A step source for the core specs: `pre<script>`/`<script>`/`post<script>` out of the fixture
 * manifest's `scripts`, mapped onto rman's three slots.
 *
 * The core has no step source either - `package.json#scripts` is `rman-node`'s. But
 * `getScriptSteps`' precedence (`override` -> contributed -> config, slot by slot) *is* core logic,
 * and testing it needs *a* contribution. Deliberately simpler than the real one: no `&&` splitting,
 * no `parseNpmScript`. That npm's own lifecycle maps onto these slots correctly is
 * `rman-node`'s to prove, not this file's.
 */
export const testSteps: RunService.StepSource = (pkg: Package, script: string) => {
  const scripts = pkg.manifest.raw?.scripts;
  if (!scripts || typeof scripts !== 'object') return undefined;
  const one = (name: string): string[] => (typeof scripts[name] === 'string' && scripts[name] ? [scripts[name]] : []);
  const slots: RunService.ScriptSlots = {
    before: one('pre' + script),
    exec: one(script),
    after: one('post' + script),
  };
  if (!slots.before!.length && !slots.exec!.length && !slots.after!.length) return undefined;
  return slots;
};

/**
 * The planner the core specs plan with. `VersionPlanService` is abstract, so `version`/`changed`
 * have nothing to ask without one.
 *
 * `cascade` repeats semver's familiar mapping because that is the behaviour the existing specs
 * assert; that it *has* to be stated here at all is the seam working.
 */
export class TestVersionPlanService extends VersionPlanService {
  protected detectBoundary(git: GitHelper, pkg: Package): Promise<string | undefined> {
    return ChangeHashService.detect(git, pkg);
  }

  protected cascade(bump: string): VersionPlanService.Cascade {
    if (bump === 'major') return 'group';
    if (bump === 'minor') return 'dependents';
    return 'changed';
  }
}

/**
 * Arms the fixture ecosystem for every test in the enclosing `describe`.
 *
 * Nothing is registered globally any more - there is nowhere to register. This records what the
 * next `createRepository()` should build its application with, and the record is cleared between
 * cases so nothing survives one.
 */
export function useTestEcosystem(): void {
  beforeEach(() => {
    registryVersions.clear();
    registryCalls.length = 0;
    extraStacks.length = 0;
    extraTargets.length = 0;
    lastApp = undefined;
  });
}

/**
 * Registers a `TechStack` offering `<dir>/local-bin` at **every level from `cwd` upward**, for a
 * spec that stubs an executable.
 *
 * Walking up is the part that is easy to get wrong: a step runs in the *package's* directory, so a
 * provider offering only `<cwd>/local-bin` serves a command run at the repository root and nothing
 * else. Measured - a stubbed `docker` sitting at the root was invisible from `packages/a`, and the
 * **real** `docker` ran instead.
 *
 * The directory is `local-bin`, deliberately not `node_modules/.bin`: that is npm's layout, and
 * `rman-node` is what contributes it. A core spec must not depend on it.
 */
export function useLocalBin(): void {
  beforeEach(() => {
    extraStacks.push({
      name: 'local-bin',
      /** A technology contributing only directories is a real shape - a PATH contributor
       *  recognizes no package - and the base stack's reader is what keeps it from claiming any. */
      manifestProvider: baseTechStack.manifestProvider,
      binPathsProvider: cwd => {
        const dirs: string[] = [];
        let previous: string | undefined;
        let dir = path.resolve(cwd);
        while (previous !== dir) {
          dirs.push(path.join(dir, 'local-bin'));
          previous = dir;
          dir = path.resolve(dir, '..');
        }
        return dirs;
      },
    });
  });
}

/**
 * Adds a publish target to every application the enclosing `describe` builds.
 *
 * The same rule every other seam follows: the core registers `docker` and nothing else, so a spec
 * that needs a registry to publish to **brings one**. A fake target is also the only way to
 * exercise the contribution itself - `claims`, a target's own flags, two targets colliding on an
 * option name - without borrowing `rman-node`'s npm one, which a core spec must never do.
 */
export function useTarget(target: PublishTarget): void {
  beforeEach(() => {
    extraTargets.push(target);
  });
}

/**
 * A repository, on an application carrying the fixture's technologies - what a spec calls instead
 * of `Repository.create`.
 *
 * The application is what a technology is registered into, so a spec cannot get one by creating a
 * repository and hoping something registered earlier is still there. That was exactly the old
 * failure: registries were module-global, so whichever spec ran first decided the answer for the
 * rest, and the core appeared to work in tests that had set nothing up.
 */
export function createRepository(root?: string, options?: { deep?: number }): Promise<Repository> {
  const app = createApp();
  return Repository.create(root, { ...options, app });
}

/**
 * An application carrying the fixture's technologies - for a spec that exercises something below
 * the repository, like `runBin`, which needs the bin directories but no packages.
 */
export function createApp(): RmanApplication {
  const app = new RmanApplication();
  app.techStacks.add(testTechStack);
  app.versionPlanner = testTechStack.versionPlanner;
  for (const stack of extraStacks) app.techStacks.add(stack);
  for (const target of extraTargets) app.publishTargets.add(target);
  lastApp = app;
  return app;
}

/** The version planner the last `createRepository()`'s application carries - what a spec asks for
 *  a plan with, now that there is no registry to read one out of. */
export function planner(): VersionPlanService {
  if (!lastApp) throw new Error('No application yet - call createRepository() first.');
  return VersionPlanService.getPlanner(lastApp);
}

/**
 * `runCli` on an application carrying the fixture's technologies.
 *
 * The CLI builds its own application per run, so a spec driving it has to hand one over for the
 * same reason `createRepository` does: a technology is registered *into* an application, and there
 * is no longer anywhere else for one to be.
 */
export function runCli(options?: { argv?: string[]; cwd?: string }): Promise<void> {
  return cliRunCli({ ...options, app: createApp() });
}

/** The service a spec is exercising, from the application the last `createRepository()` built. */
export function service<K extends keyof ServiceMap>(name: K): ServiceMap[K] {
  if (!lastApp) throw new Error('No application yet - call createRepository() first.');
  return lastApp.getService(name);
}

/**
 * The core's synthetic technology, as one thing.
 *
 * Named `'test'` rather than `'node'` on purpose: a core spec must not be able to pass because
 * `rman-node`'s answers happened to be right.
 */
export const testTechStack: TechStack = {
  name: 'test',
  manifestProvider: testManifest,
  workspaceProvider: testWorkspace,
  runSteps: testSteps,
  versionPlanner: new TestVersionPlanService(),
};

/** Stacks a spec asked for on top of the fixture's own - see `useLocalBin`. */
const extraStacks: TechStack[] = [];

/** Publish targets a spec asked for, on top of the core's own `docker` - see `useTarget`. */
const extraTargets: PublishTarget[] = [];
let lastApp: RmanApplication | undefined;

/**
 * What the fixture provider answers `publishedVersion` with, keyed by package name - empty unless a
 * spec fills it in, so nothing reaches a network and the default is "never published".
 *
 * Cleared before each test by `useTestEcosystem()`, since it is module state like the registries.
 */
export const registryVersions = new Map<string, string>();

/** Every package the fixture's `publishedVersion` was asked about, in order - so a spec can assert
 *  the registry was **not** consulted at all, which is the point of the tag and explicit-hash
 *  branches short-circuiting before it. Cleared alongside `registryVersions`. */
export const registryCalls: string[] = [];

const DEPENDENCY_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
