import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { RmanApplication } from '../../src/core/application.js';
import { Package } from '../../src/core/classes/package.js';
import { Workspace } from '../../src/core/classes/workspace.js';
import { definePlatform, type Platform } from '../../src/core/interfaces/plugin.js';

/**
 * **Self-contained: no application, no repository, no fixture ecosystem.** `Workspace.create` takes
 * its plugins as an argument, so a spec hands over exactly the technologies the case is about -
 * which is also the proof that nothing here reaches into `plugins/`.
 *
 * **Every case here passes `presets: []`**, and the one that does not is the one about the default.
 * `Workspace.create` lays `DEFAULT_PRESETS` under every root, so without it each of these would
 * carry the `node` platform, its two commands and the npm publish target - a second technology
 * claiming directories beside the one the case is about, and a `rawConfig` full of contributions
 * nothing here is asking about.
 */
describe('core/Workspace.create()', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-workspace-'));
    dirs.push(d);
    return d;
  }

  /** A bare application. `Package` takes one to find its platform when the caller does not know it
   *  - the walk always does, so this is handed over and never consulted. */
  function app(): RmanApplication {
    return new RmanApplication();
  }

  function write(root: string, relative: string, contents: string): void {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }

  /**
   * A technology that claims a directory by one file name and finds its children through a
   * `members` list in that file - enough layout for a cascade to have levels, with no ecosystem.
   */
  function technology(name: string, fileName: string): Platform {
    const read = (dir: string) => {
      const file = path.join(dir, fileName);
      if (!fs.existsSync(file)) return undefined;
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8') || '{}');
      return { name: raw.name ?? path.basename(dir), version: raw.version ?? '0.0.0', private: false, raw };
    };
    return definePlatform({
      name,
      manifestProvider: { name, fileName, read, write: () => undefined },
      getWorkspace: (dir: string) => (read(dir)?.raw.members ?? []).map((m: string) => path.join(dir, m)) as string[],
    });
  }

  const test = technology('test', 'manifest.json');

  /** A root holding two packages, with a manifest at each level. */
  function twoPackageRepo(): string {
    const root = tmp();
    write(root, 'manifest.json', JSON.stringify({ name: 'root', members: ['packages/pkg-a', 'packages/pkg-b'] }));
    write(root, 'packages/pkg-a/manifest.json', JSON.stringify({ name: 'pkg-a' }));
    write(root, 'packages/pkg-b/manifest.json', JSON.stringify({ name: 'pkg-b' }));
    return root;
  }

  describe('discovery', () => {
    it('finds the packages the root platform names', async () => {
      const ws = await Workspace.create(twoPackageRepo(), { app: app(), presets: [], platforms: [test] });
      expect(ws.packages.map(p => path.basename(p.dirname))).toEqual(['pkg-a', 'pkg-b']);
      expect(ws.rootPackage.dirname).toBe(ws.rootDir);
      expect(ws.packages).not.toContain(ws.rootPackage);
    });

    /**
     * **The one thing holding `Package` costs, stated rather than hidden.** `Package.isRoot` reads
     * `this.repository`, which `Repository.create` assigns - so every package here answers `false`,
     * the root included. That is `Package`'s documented behaviour for one built outside a
     * repository, not a bug, and `Workspace` therefore compares directories internally rather than
     * asking. It starts answering when a repository adopts these packages.
     */
    it('leaves isRoot false until a repository adopts the packages', async () => {
      const ws = await Workspace.create(twoPackageRepo(), { app: app(), presets: [], platforms: [test] });
      expect(ws.rootPackage.isRoot).toBe(false);
    });

    it('descends, so a package can hold packages of its own', async () => {
      const root = tmp();
      write(root, 'manifest.json', JSON.stringify({ name: 'root', members: ['a'] }));
      write(root, 'a/manifest.json', JSON.stringify({ name: 'a', members: ['b'] }));
      write(root, 'a/b/manifest.json', JSON.stringify({ name: 'b' }));
      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test] });
      expect(ws.packages.map(p => p.selector)).toEqual(['a', 'b']);
      expect(ws.packageAt(path.join(root, 'a'))!.children.map(c => c.selector)).toEqual(['b']);
    });

    /** A repository no technology claims is a root with no children - the single-package answer
     *  arrived at rather than guessed. */
    it('is a root alone when nothing recognizes the directory', async () => {
      const root = tmp();
      write(root, '.rmanrc.yml', 'logLevel: info\n');
      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test] });
      expect(ws.packages).toEqual([]);
      expect(ws.rootPackage.dirname).toBe(path.resolve(root));
    });

    it('visits a directory once, so a cycle in the layout terminates', async () => {
      const root = tmp();
      write(root, 'manifest.json', JSON.stringify({ name: 'root', members: ['a'] }));
      write(root, 'a/manifest.json', JSON.stringify({ name: 'a', members: ['..'] }));
      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test] });
      expect(ws.packages.map(p => p.selector)).toEqual(['a']);
    });

    it('stops at the given depth', async () => {
      const root = tmp();
      write(root, 'manifest.json', JSON.stringify({ name: 'root', members: ['a'] }));
      write(root, 'a/manifest.json', JSON.stringify({ name: 'a', members: ['b'] }));
      write(root, 'a/b/manifest.json', JSON.stringify({ name: 'b' }));
      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test], deep: 1 });
      expect(ws.packages.map(p => p.selector)).toEqual(['a']);
    });
  });

  describe('the cascade', () => {
    it('layers every directory from the root down to the package', async () => {
      const root = twoPackageRepo();
      write(root, '.rmanrc.yml', 'logLevel: info\npackageManager: npm\n');
      write(root, 'packages/.rmanrc.yml', 'logLevel: verbose\n');
      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test] });
      const a = ws.packageAt(path.join(root, 'packages/pkg-a'))!.rawConfig;
      expect(a.logLevel).toBe('verbose');
      expect(a.packageManager).toBe('npm');
    });

    it("lets a package's own config beat every level above it", async () => {
      const root = twoPackageRepo();
      write(root, '.rmanrc.yml', 'logLevel: info\n');
      write(root, 'packages/pkg-a/.rmanrc.yml', 'logLevel: silent\n');
      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test] });
      expect(ws.packageAt(path.join(root, 'packages/pkg-a'))!.rawConfig.logLevel).toBe('silent');
      expect(ws.packageAt(path.join(root, 'packages/pkg-b'))!.rawConfig.logLevel).toBe('info');
    });

    /** `"[/]"` is the root package alone; a glob never matches the root. That one rule removes two
     *  traps - a glob cannot hand a package-shaped setting to the root, and cannot pick the root up
     *  by a name that happens to match. */
    it('applies "[/]" to the root and a glob to the packages, never the other way', async () => {
      const root = twoPackageRepo();
      write(root, '.rmanrc', JSON.stringify({ '[/]': { packageManager: 'npm' }, '[*]': { logLevel: 'verbose' } }));
      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test] });
      expect(ws.rootPackage.rawConfig.packageManager).toBe('npm');
      expect(ws.rootPackage.rawConfig.logLevel).toBeUndefined();
      expect(ws.packageAt(path.join(root, 'packages/pkg-a'))!.rawConfig.logLevel).toBe('verbose');
      expect(ws.packageAt(path.join(root, 'packages/pkg-a'))!.rawConfig.packageManager).toBeUndefined();
    });

    /**
     * **The key a preset needs.** `extends: ['node', 'cargo']` merges both configs, so a
     * package-level setting written unmarked would reach every package of either technology -
     * a cargo crate told to run `tsc -b`. A platform block says who it is for.
     */
    it('applies "[platform:...]" only to packages of that technology', async () => {
      const root = tmp();
      const other = technology('other', 'other.json');
      write(root, 'manifest.json', JSON.stringify({ name: 'root', members: ['packages/pkg-a', 'packages/pkg-b'] }));
      write(root, 'packages/pkg-a/manifest.json', JSON.stringify({ name: 'pkg-a' }));
      write(root, 'packages/pkg-b/other.json', JSON.stringify({ name: 'pkg-b' }));
      write(root, '.rmanrc', JSON.stringify({ '[platform:test]': { logLevel: 'silent' } }));

      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test, other] });
      expect(ws.packageAt(path.join(root, 'packages/pkg-a'))!.rawConfig.logLevel).toBe('silent');
      expect(ws.packageAt(path.join(root, 'packages/pkg-b'))!.rawConfig.logLevel).toBeUndefined();
    });

    it('takes a list of technologies', async () => {
      const root = tmp();
      const other = technology('other', 'other.json');
      write(root, 'manifest.json', JSON.stringify({ name: 'root', members: ['packages/pkg-a', 'packages/pkg-b'] }));
      write(root, 'packages/pkg-a/manifest.json', JSON.stringify({ name: 'pkg-a' }));
      write(root, 'packages/pkg-b/other.json', JSON.stringify({ name: 'pkg-b' }));
      write(root, '.rmanrc', JSON.stringify({ '[platform:test,other]': { logLevel: 'silent' } }));

      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test, other] });
      expect(ws.packages.map(p => p.rawConfig.logLevel)).toEqual(['silent', 'silent']);
    });

    /** The root's address is `"[/]"`; a platform block is held to the same line a glob is. */
    it('never matches the root, which has a platform of its own', async () => {
      const root = twoPackageRepo();
      write(root, '.rmanrc', JSON.stringify({ '[platform:test]': { logLevel: 'silent' } }));
      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test] });
      expect(ws.rootPackage.platform.name).toBe('test');
      expect(ws.rootPackage.rawConfig.logLevel).toBeUndefined();
      expect(ws.packageAt(path.join(root, 'packages/pkg-a'))!.rawConfig.logLevel).toBe('silent');
    });

    /** `platform` would be circular - the block is matched by platform and would be setting it -
     *  and `name` would change the selector other blocks match on. */
    it('refuses "platform" and "name" inside a platform block', async () => {
      for (const key of ['platform', 'name']) {
        const root = tmp();
        write(root, '.rmanrc', JSON.stringify({ '[platform:test]': { [key]: 'x' } }));
        await expect(Workspace.create(root, { app: app(), presets: [], platforms: [test] })).rejects.toThrow(
          new RegExp(`cannot set "${key}"`),
        );
      }
    });

    it('matches a named block against the selector', async () => {
      const root = twoPackageRepo();
      write(root, '.rmanrc', JSON.stringify({ '[pkg-a]': { logLevel: 'silent' } }));
      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test] });
      expect(ws.packageAt(path.join(root, 'packages/pkg-a'))!.rawConfig.logLevel).toBe('silent');
      expect(ws.packageAt(path.join(root, 'packages/pkg-b'))!.rawConfig.logLevel).toBeUndefined();
    });

    /** Unmarked is the level's floor wherever it sits in the file - not a fourth selector - so a
     *  block written above the plain keys still wins. */
    it('lets a selector block beat unmarked keys written below it', async () => {
      const root = twoPackageRepo();
      write(root, '.rmanrc', JSON.stringify({ '[*]': { logLevel: 'silent' }, logLevel: 'info' }));
      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test] });
      expect(ws.packageAt(path.join(root, 'packages/pkg-a'))!.rawConfig.logLevel).toBe('silent');
    });

    it('leaves the config raw - no expression is evaluated', async () => {
      const root = twoPackageRepo();
      write(root, '.rmanrc.yml', 'packageManager: "${{ pkg.name }}"\n');
      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test] });
      expect(ws.rootPackage.rawConfig.packageManager).toBe('${{ pkg.name }}');
    });
  });

  describe('selectors', () => {
    it("takes the platform's answer when no config declares one", async () => {
      const ws = await Workspace.create(twoPackageRepo(), { app: app(), presets: [], platforms: [test] });
      expect(ws.packages.map(p => p.selector)).toEqual(['pkg-a', 'pkg-b']);
    });

    it('lets a package declare its own', async () => {
      const root = twoPackageRepo();
      write(root, 'packages/pkg-a/.rmanrc.yml', 'name: renamed\n');
      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test] });
      expect(ws.packageAt(path.join(root, 'packages/pkg-a'))!.selector).toBe('renamed');
    });

    /**
     * **The two-pass step, and the one whose absence is silent.** `"[renamed]"` can only be applied
     * once the selector is known, and the selector is `name`, which is inside the config being
     * resolved - so the chain is walked once with no selector to read `name`, and again for real.
     */
    it('applies a block naming the selector a package declared for itself', async () => {
      const root = twoPackageRepo();
      write(root, 'packages/pkg-a/.rmanrc.yml', 'name: renamed\n');
      write(root, '.rmanrc', JSON.stringify({ '[renamed]': { logLevel: 'silent' } }));
      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test] });
      expect(ws.packageAt(path.join(root, 'packages/pkg-a'))!.rawConfig.logLevel).toBe('silent');
    });

    it('refuses two packages answering to one selector', async () => {
      const root = twoPackageRepo();
      write(root, 'packages/pkg-b/.rmanrc.yml', 'name: pkg-a\n');
      await expect(Workspace.create(root, { app: app(), presets: [], platforms: [test] })).rejects.toThrow(
        /Two packages answer to the selector "pkg-a"/,
      );
    });

    /** `name` cascades like every unmarked key, so one declaration above two packages is the usual
     *  way in - and the fix is different, so the message says which happened. */
    it('says so when one cascading declaration reached both', async () => {
      const root = twoPackageRepo();
      write(root, 'packages/.rmanrc.yml', 'name: shared\n');
      await expect(Workspace.create(root, { app: app(), presets: [], platforms: [test] })).rejects.toThrow(
        /Both got it from one cascading "name" declaration/,
      );
    });

    /**
     * A glob never matches the root and `"[/]"` needs no name, so the root shares an address with
     * nobody - it can answer to a selector a package also answers to.
     *
     * Written under `"[/]"` rather than unmarked, because `name` cascades like every unmarked key:
     * at the root, unmarked, it would reach *both* packages and the clash would be real.
     */
    it('does not hold the root to that uniqueness', async () => {
      const root = twoPackageRepo();
      write(root, '.rmanrc.yml', '"[/]":\n  name: pkg-a\n');
      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test] });
      expect(ws.rootPackage.selector).toBe('pkg-a');
      expect(ws.packageAt(path.join(root, 'packages/pkg-a'))!.selector).toBe('pkg-a');
    });

    it('refuses a "name" that is not a usable string', async () => {
      const root = twoPackageRepo();
      write(root, 'packages/pkg-a/.rmanrc', JSON.stringify({ name: 42 }));
      await expect(Workspace.create(root, { app: app(), presets: [], platforms: [test] })).rejects.toThrow(
        /"name" takes the selector/,
      );
    });
  });

  describe('platforms and plugins', () => {
    it('claims each directory with the technology that recognizes it', async () => {
      const root = tmp();
      const other = technology('other', 'other.json');
      write(root, 'manifest.json', JSON.stringify({ name: 'root', members: ['a'] }));
      write(root, 'a/other.json', JSON.stringify({ name: 'a' }));
      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test, other] });
      expect(ws.rootPackage.platform.name).toBe('test');
      expect(ws.packages[0]!.platform.name).toBe('other');
    });

    it('loads a technology the root config names, and uses it to walk', async () => {
      const root = tmp();
      write(root, 'p.mjs', platformModule('loaded', 'loaded.json'));
      write(root, '.rmanrc.yml', `platforms: './p.mjs'\n`);
      write(root, 'loaded.json', JSON.stringify({ name: 'root', members: ['a'] }));
      write(root, 'a/loaded.json', JSON.stringify({ name: 'a' }));
      const ws = await Workspace.create(root, { app: app(), presets: [] });
      expect(ws.platforms.map(p => p.name)).toEqual(['loaded']);
      expect(ws.packages.map(p => p.selector)).toEqual(['a']);
      /** And no plugin was invented to carry it. A technology is a `platforms` entry, whole. */
      expect(ws.plugins).toEqual([]);
    });

    /** The technologies handed in come first, so a repository's own additions come after them - and
     *  order is what decides which one claims a directory. */
    it('keeps the technologies it was given ahead of the ones a config adds', async () => {
      const root = tmp();
      write(root, 'p.mjs', platformModule('added', 'added.json'));
      write(root, '.rmanrc.yml', `platforms: './p.mjs'\n`);
      write(root, 'manifest.json', JSON.stringify({ name: 'root' }));
      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test] });
      expect(ws.platforms.map(p => p.name)).toEqual(['test', 'added']);
    });

    /**
     * **A plugin carries no technology any more**, and this is what is left of one: a name, and
     * whatever it does at a stage. `platforms` is a config key, so a package shipping a technology
     * declares it there - `Plugin.platforms` was the wrapper that step made unnecessary, and by the
     * end nothing in rman produced one.
     */
    it('loads a plugin that contributes no technology at all', async () => {
      const root = tmp();
      write(root, 'p.mjs', `export const marker = 1;\nexport default { name: 'bare' };\n`);
      write(
        root,
        'p.mjs',
        `import { definePlugin } from ${JSON.stringify(PLUGIN_SOURCE)};\n` +
          `export default definePlugin({ name: 'bare' });\n`,
      );
      write(root, '.rmanrc.yml', `plugins: './p.mjs'\n`);
      write(root, 'manifest.json', JSON.stringify({ name: 'root' }));
      const ws = await Workspace.create(root, { app: app(), presets: [], platforms: [test] });
      expect(ws.plugins.map(p => p.name)).toEqual(['bare']);
      /** It contributed nothing to the technologies, which is the point of the case. */
      expect(ws.platforms.map(p => p.name)).toEqual(['test']);
    });

    /**
     * The default that replaced detection: rman's own presets go under every root, so a repository
     * writing no config at all still has the `node` technology - and one that declared its own has
     * it **first**, since the presets are loaded after whatever the config named.
     */
    it("lays rman's own presets under the root, behind whatever the repository declared", async () => {
      const root = twoPackageRepo();
      write(root, 'package.json', JSON.stringify({ name: 'root' }));
      const ws = await Workspace.create(root, { app: app(), platforms: [test] });
      expect(ws.platforms.map(p => p.name)).toEqual(['test', 'node']);
      /** And the preset's contributions are in the root's config, which is what `cli.ts` and
       *  `Repository.create` read `commands` and `publishTargets` off. */
      expect((ws.rootPackage.rawConfig.publishTargets as { name: string }[]).map(t => t.name)).toEqual(['npm']);
      /** `manifest.json` is what `test` reads, and it came first - so it claims the root even
       *  though a `package.json` sits right beside it. */
      expect(ws.rootPackage.platform.name).toBe('test');
    });

    it('refuses a declared platform nothing provides', async () => {
      const root = tmp();
      write(root, '.rmanrc.yml', `platform: 'nowhere'\n`);
      await expect(Workspace.create(root, { app: app(), presets: [], platforms: [test] })).rejects.toThrow(
        /not a platform this repository has/,
      );
    });
  });

  describe('the steps are seams', () => {
    /**
     * `new this()`, not `new Workspace()`: a subclass inheriting the factory must build itself, or
     * an overridden step is never reached.
     *
     * `_createPackage` is the seam that makes holding `Package` rather than a shape of our own
     * worth it - a technology whose packages need to be a subclass replaces one method and keeps
     * the whole walk.
     */
    it('a subclass gets its own overrides through the inherited create()', async () => {
      class Tagged extends Package {
        readonly tagged = true;
      }
      class Custom extends Workspace {
        protected override _createPackage(dirname: string, platform: Platform): Package {
          return new Tagged(dirname, this.options.app, platform);
        }
      }
      const ws = await Custom.create(twoPackageRepo(), { app: app(), presets: [], platforms: [test] });
      expect(ws).toBeInstanceOf(Custom);
      expect(ws.packages.every(p => p instanceof Tagged)).toBe(true);
      expect(ws.rootPackage).toBeInstanceOf(Tagged);
      // The walk is untouched - the subclass replaced one step and kept the rest.
      expect(ws.packages.map(p => p.selector)).toEqual(['pkg-a', 'pkg-b']);
    });

    it('a subclass can replace the cascade without restating the rest', async () => {
      class Fixed extends Workspace {
        protected override async _cascade(): Promise<any> {
          return { logLevel: 'silent' };
        }
      }
      const ws = await Fixed.create(twoPackageRepo(), { app: app(), presets: [], platforms: [test] });
      expect(ws.packages.map(p => p.rawConfig.logLevel)).toEqual(['silent', 'silent']);
    });
  });

  describe('levels are read once', () => {
    /** The cascade walks the chain twice - once with no selector to read `name`, once for real -
     *  and every package shares the levels above it. Without the cache that is one disk read per
     *  package per level per pass. */
    it('reads each directory once however many packages and passes need it', async () => {
      const root = twoPackageRepo();
      write(root, '.rmanrc.yml', 'logLevel: info\n');
      const seen: string[] = [];
      class Counting extends Workspace {
        protected override async _readLevel(dirname: string) {
          const hit = (this as any)._levels.get(path.resolve(dirname));
          if (!hit) seen.push(path.resolve(dirname));
          return super._readLevel(dirname);
        }
      }
      await Counting.create(root, { app: app(), presets: [], platforms: [test] });
      expect(new Set(seen).size).toBe(seen.length);
    });
  });
});

/**
 * A plugin module a config's `plugins` glob can pick up.
 *
 * **`.mjs`, not `.js`.** A `.js` file in a temp directory has no `package.json` saying
 * `"type": "module"` beside it, so Node reads it as CommonJS - and under the spec runner's ESM
 * register hook it comes back double-wrapped, `{ default: { default: plugin } }`, which reaches the
 * loader as a nameless object. `.mjs` is ESM by its own name wherever it sits.
 *
 * It imports the source directly, since a file written to a temp directory is not inside the spec
 * tree's `paths` mapping.
 */
function platformModule(name: string, fileName: string): string {
  const src = PLUGIN_SOURCE;
  return (
    `import fs from 'node:fs';\n` +
    `import path from 'node:path';\n` +
    `import { definePlatform } from ${JSON.stringify(src)};\n` +
    `const read = dir => {\n` +
    `  const file = path.join(dir, ${JSON.stringify(fileName)});\n` +
    `  if (!fs.existsSync(file)) return undefined;\n` +
    `  const raw = JSON.parse(fs.readFileSync(file, 'utf-8') || '{}');\n` +
    `  return { name: raw.name ?? path.basename(dir), version: '0.0.0', private: false, raw };\n` +
    `};\n` +
    `export default definePlatform({\n` +
    `  name: ${JSON.stringify(name)},\n` +
    `  manifestProvider: { name: ${JSON.stringify(name)}, fileName: ${JSON.stringify(fileName)}, read, write: () => undefined },\n` +
    `  getWorkspace: dir => (read(dir)?.raw.members ?? []).map(m => path.join(dir, m)),\n` +
    `});\n`
  );
}

/**
 * Where a generated module imports the factories from.
 *
 * **One definition, because a compiler cannot see this.** The path lives inside the *source text* of
 * a module written to a temp directory, so `tsc` never resolves it and a move of `plugin.ts` fails
 * at run time with `ENOENT` from an ESM loader - which is what happened when it went to
 * `core/interfaces/`. One constant makes that one edit instead of one per generated module.
 */
const PLUGIN_SOURCE = new URL('../../src/core/interfaces/plugin.ts', import.meta.url).href;
