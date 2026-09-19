import fs from 'node:fs';
import path from 'node:path';
import glob from 'fast-glob';
import { RmanApplication } from '../src/core/application.js';
import type { ManifestProvider } from '../src/core/manifest.js';
import type { Package } from '../src/core/package.js';
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
 * Registers the fixture ecosystem for every test in the enclosing `describe`.
 *
 * Call it inside a `describe`, not at module scope: the root hook in
 * [`support/mocha-root-hooks.ts`](../../../support/mocha-root-hooks.ts) empties every registry
 * before each test, so registration has to happen *after* that - which is what a `beforeEach`
 * declared here does (mocha runs hooks outermost-first, and the root hook is the outermost).
 *
 * `Repository.create` only ever *adds* what `plugins` names, never clears, so a repository built by
 * a spec - directly or through `runCli` - sees these.
 */
export function useTestEcosystem(): void {
  beforeEach(registerTestEcosystem);
}

/**
 * Registers a `BinPath` provider offering `<dir>/local-bin` at **every level from `cwd` upward**,
 * for a spec that stubs an executable.
 *
 * Walking up is the part that is easy to get wrong: `exec` runs a step in the *package's* directory,
 * so a provider offering only `<cwd>/local-bin` serves a command run at the repository root and
 * nothing else. Measured - a stubbed `docker` sitting at the root was invisible from
 * `packages/a`, and the **real** `docker` ran instead.
 *
 * The directory is `local-bin`, deliberately not `node_modules/.bin`: that is npm's layout, and
 * `rman-node` is what contributes it. A core spec must not depend on it.
 */
export function useLocalBin(): void {
  beforeEach(() => {
    /** Its own stack, so it can be added to a repository that already has `testTechStack` - a
     *  technology contributing only binaries is exactly what the base stack's optional fields
     *  allow, and the manifest provider that recognizes nothing keeps it from claiming packages. */
    RmanApplication.current().techStacks.add({
      name: 'local-bin',
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
 * The same registration without mocha's hooks - for a **subprocess**.
 *
 * `version --interactive` can only be tested by driving a real stdin, so those specs spawn a child
 * that imports `runCli` itself. That child has no mocha and no `beforeEach`, and the repository it
 * runs in names no plugin, so without calling this it has no manifest provider and no planner.
 */
export function registerTestEcosystem(): void {
  registryVersions.clear();
  registryCalls.length = 0;
  RmanApplication.current().techStacks.add(testTechStack);
  RmanApplication.current().versionPlanner = testTechStack.versionPlanner;
}

/**
 * The core's synthetic technology, as one thing.
 *
 * Named `'test'` rather than `'node'` on purpose: a core spec must not be able to pass because
 * `rman-node`'s answers happened to be right. Declaring it as one `TechStack` is also what the
 * four separate registrations could never say - that these answers belong together, and that a
 * package claimed by this manifest provider is the one whose steps and binaries these are.
 */
export const testTechStack: TechStack = {
  name: 'test',
  manifestProvider: testManifest,
  workspaceProvider: testWorkspace,
  runSteps: testSteps,
  versionPlanner: new TestVersionPlanService(),
};

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

/**
 * The service a spec is exercising, from the application the fixture's repository attached itself
 * to.
 *
 * `Repository.create` attaches, so a spec that has built one already has the application this
 * reaches - which is why the old `SomeService.method(repo, ...)` shape disappears rather than
 * moving: the repository was always available, the parameter only restated it.
 */
export function service<K extends keyof ServiceMap>(name: K): ServiceMap[K] {
  return RmanApplication.current().getService(name);
}
