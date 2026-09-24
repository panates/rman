import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { RmanApplication } from '../../src/core/application.js';
import type { ManifestProvider } from '../../src/core/manifest.js';
import { definePlatform, type Platform } from '../../src/core/plugin.js';
import { Repository } from '../../src/core/repository.js';
import { Workspace } from '../../src/core/workspace.js';
import { createApp, createRepository, usePlugin, useTestEcosystem } from '../_fixture.js';

/** Stands in for a second technology: `other.json`, whose `members` names its own child packages. */
const otherManifest: ManifestProvider = {
  name: 'other',
  fileName: 'other.json',
  read(dir) {
    const file = path.join(dir, 'other.json');
    if (!fs.existsSync(file)) return undefined;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return { name: raw.name, version: raw.version ?? '0.0.0', raw };
  },
  write() {},
};

const otherPlatform: Platform = definePlatform({
  name: 'other',
  manifestProvider: otherManifest,
  getWorkspace(dir) {
    const file = path.join(dir, 'other.json');
    if (!fs.existsSync(file)) return undefined;
    const members = JSON.parse(fs.readFileSync(file, 'utf-8'))?.members;
    return Array.isArray(members) ? members.map((m: string) => path.join(dir, m)) : [];
  },
});

/**
 * A platform whose provider names its own **parent** as a child - the loop the visited set exists
 * for. Deliberately not a self-reference: `dir` naming `dir` would be caught by any guard, while
 * naming the directory above it is the shape a path-computing provider actually produces.
 */
const selfNamingPlatform: Platform = definePlatform({
  name: 'loop',
  manifestProvider: {
    name: 'loop',
    fileName: 'loop.json',
    read: dir =>
      fs.existsSync(path.join(dir, 'loop.json')) ? { name: path.basename(dir), version: '0.0.0', raw: {} } : undefined,
    write: () => undefined,
  },
  getWorkspace(dir) {
    if (!fs.existsSync(path.join(dir, 'loop.json'))) return undefined;
    const child = path.join(dir, 'child');
    return fs.existsSync(path.join(child, 'loop.json')) ? [child] : [path.resolve(dir, '..')];
  },
});

/**
 * **Discovery descends, and asks each directory's own technology.**
 *
 * `Workspace.Provider` used to be `(root) => { root, packageDirs }`: asked once, at the top, by the
 * first platform that recognized it. Two things followed, and both were documented as limitations
 * rather than fixed - a polyglot repository's package set was decided by whichever technology was
 * listed first in `plugins`, and a package nested inside another was only recoverable afterwards by
 * comparing path prefixes.
 *
 * The provider answers for one directory now and the recursion is the core's, so a platform only
 * ever speaks about its own packages - which is all a platform knows. These pin the walk itself;
 * `repository.spec.ts` pins what a repository makes of it.
 */
describe('core/Workspace', () => {
  useTestEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-workspace-test-'));
    dirs.push(d);
    return d;
  }

  function write(dir: string, file: string, body: unknown): void {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof body === 'string' ? body : JSON.stringify(body));
  }

  describe('walk()', () => {
    it('answers with the root alone when nothing recognizes it, rather than undefined', async () => {
      const dir = tmp();
      const tree = await Workspace.walk(createApp(), dir);
      expect(tree.dirname).toBe(path.resolve(dir));
      expect(tree.children).toEqual([]);
      /** A repository is a package whatever its technology, so there is always a root node - the
       *  single-package answer arrived at rather than guessed. */
      expect(Workspace.flatten(tree)).toEqual([]);
    });

    it('descends one level for an ordinary flat workspace', async () => {
      const dir = tmp();
      write(dir, 'package.json', { name: 'root', workspaces: ['packages/*'] });
      write(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      write(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });

      const tree = await Workspace.walk(createApp(), dir);
      expect(tree.children.map(c => path.basename(c.dirname))).toEqual(['a', 'b']);
      expect(tree.children.every(c => c.children.length === 0)).toBe(true);
    });

    /**
     * **The whole point of descending**: a workspace inside a workspace. The provider is asked
     * about `packages/a` too, and `packages/a/package.json` naming `workspaces` makes it a root of
     * its own - so its members are found by the same code that found it.
     *
     * With the old seam this was unreachable: the provider was asked once, at the top, and
     * `deep: 0` on the globs meant `packages/a/inner` was simply not in the answer.
     */
    it('finds a workspace nested inside a package, which is what asking per directory buys', async () => {
      const dir = tmp();
      write(dir, 'package.json', { name: 'root', workspaces: ['packages/*'] });
      write(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0', workspaces: ['inner/*'] });
      write(dir, 'packages/a/inner/deep/package.json', { name: 'pkg-deep', version: '1.0.0' });

      const tree = await Workspace.walk(createApp(), dir);
      const a = tree.children.find(c => path.basename(c.dirname) === 'a')!;
      expect(a.children.map(c => path.basename(c.dirname))).toEqual(['deep']);
      expect(
        Workspace.flatten(tree)
          .map(n => path.basename(n.dirname))
          .sort(),
      ).toEqual(['a', 'deep']);
    });

    /**
     * **The polyglot case, and the limitation this replaces.** The fixture's platform claims
     * anything with a `package.json`; `other` claims a directory with an `other.json` and names its
     * own members. Registered second, it could never have answered under the old rule - the first
     * platform to recognize the *root* decided the whole package set.
     *
     * Here the root is the fixture's, and the node it leads to is `other`'s - which then says where
     * *its* children are. Two technologies, one tree.
     */
    describe('a nested package of another technology', () => {
      usePlugin(otherPlatform);

      it('is claimed by its own platform, and says where its own children are', async () => {
        const dir = tmp();
        write(dir, 'package.json', { name: 'root', workspaces: ['packages/*'] });
        write(dir, 'packages/sub/other.json', { name: 'sub', members: ['leaf'] });
        write(dir, 'packages/sub/package.json', { name: 'sub', version: '1.0.0' });
        write(dir, 'packages/sub/leaf/other.json', { name: 'leaf' });

        const app = createApp();
        const tree = await Workspace.walk(app, dir);
        const sub = tree.children.find(c => path.basename(c.dirname) === 'sub')!;
        /** `other` is registered first (a spec's own platforms go on first), so it claims the
         *  directory that has both files - which is what makes its `getWorkspace` the one asked. */
        expect(sub.platform.name).toBe('other');
        expect(sub.children.map(c => path.basename(c.dirname))).toEqual(['leaf']);
        expect(sub.children[0]!.platform.name).toBe('other');
      });
    });

    /**
     * **A directory is visited once**, and this is the shape that makes it necessary rather than
     * tidy: a provider naming its own parent. Without the guard the descent never ends - and a
     * provider computing paths rather than reading them can produce exactly that.
     */
    describe('a provider that names a directory already visited', () => {
      usePlugin(selfNamingPlatform);

      it('is not followed twice, so the walk terminates', async () => {
        const dir = tmp();
        write(dir, 'loop.json', { name: 'loop' });
        write(dir, 'child/loop.json', { name: 'child' });

        const tree = await Workspace.walk(createApp(), dir);
        expect(tree.platform.name).toBe('loop');
        /** `child` names the root back; the root has been visited, so it is dropped. */
        expect(Workspace.flatten(tree).map(n => path.basename(n.dirname))).toEqual(['child']);
      });
    });

    /** The same reason `findRoot` bounds its climb: a provider whose paths are computed can produce
     *  a chain with no end, and a bound is better than a hang with nothing printed. */
    it('stops descending at the given depth', async () => {
      const dir = tmp();
      write(dir, 'package.json', { name: 'root', workspaces: ['a'] });
      write(dir, 'a/package.json', { name: 'a', version: '1.0.0', workspaces: ['b'] });
      write(dir, 'a/b/package.json', { name: 'b', version: '1.0.0' });

      expect(
        Workspace.flatten(await Workspace.walk(createApp(), dir, { deep: 2 })).map(n => path.basename(n.dirname)),
      ).toEqual(['a', 'b']);
      expect(
        Workspace.flatten(await Workspace.walk(createApp(), dir, { deep: 1 })).map(n => path.basename(n.dirname)),
      ).toEqual(['a']);
    });
  });

  /**
   * **`plugins` loads; `platform` selects.**
   *
   * Which technologies a repository has available is a fact about the repository, read once at its
   * root. Which one a given directory's package belongs to is a fact about the package, and a
   * repository may hold several - so it is an ordinary cascading key. Without it the answer is
   * registration order, which is load order deciding a question about someone's code.
   */
  describe('the "platform" key', () => {
    describe('with a second technology registered', () => {
      usePlugin(otherPlatform);

      /**
       * **The declaration wins over the guess, and the guess would have been the other answer** -
       * which is what makes this a test rather than a restatement. Both files are present, and a
       * spec's own platforms register first, so `other` claims the directory unasked.
       */
      it('overrides which platform claims a directory', async () => {
        const dir = tmp();
        write(dir, '.rmanrc', {});
        write(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
        write(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
        write(dir, 'packages/a/other.json', { name: 'pkg-a' });

        expect((await createRepository(dir)).getPackage('pkg-a')!.provider).toBe('other');

        write(dir, 'packages/a/.rmanrc', { platform: 'test' });
        const declared = await createRepository(dir);
        expect(declared.getPackage('pkg-a')!.provider).toBe('test');
      });

      /**
       * It cascades like any unmarked key, so one line at the root covers a whole subtree - and a
       * package's own `.rmanrc` still overrides it for itself.
       *
       * **The root declaration also decides whose `getWorkspace` is asked there**, which is not a
       * side effect but the same statement: a directory's platform is the one that says what is
       * under it. Written the first time with only `package.json#workspaces` naming the members,
       * this fixture found *no* packages - `other` was asked, and `other` reads `members`.
       */
      it('cascades, and a closer declaration wins', async () => {
        const dir = tmp();
        write(dir, '.rmanrc', { platform: 'other' });
        write(dir, 'other.json', { name: 'root', members: ['packages/a', 'packages/b'] });
        write(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
        write(dir, 'packages/a/other.json', { name: 'pkg-a' });
        write(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
        write(dir, 'packages/b/other.json', { name: 'pkg-b' });
        write(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
        write(dir, 'packages/b/.rmanrc', { platform: 'test' });

        const repository = await createRepository(dir);
        expect(repository.getPackage('pkg-a')!.provider).toBe('other');
        expect(repository.getPackage('pkg-b')!.provider).toBe('test');
      });

      /**
       * **A platform named for a directory it does not recognize is simply untrue**, and the
       * failure it would otherwise become is invisible: the manifest reads as nothing, so the
       * package is named after its directory at `0.0.0` and the repository looks like it works.
       */
      it('is an error when the named platform does not recognize the directory', async () => {
        const dir = tmp();
        write(dir, '.rmanrc', {});
        write(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
        write(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
        write(dir, 'packages/a/.rmanrc', { platform: 'other' });

        await expect(createRepository(dir)).rejects.toThrow(/does not recognize it - it looks for "other\.json"/);
      });
    });

    it('is an error when the name is not a platform this repository has', async () => {
      const dir = tmp();
      write(dir, '.rmanrc', { platform: 'cargo' });
      write(dir, 'package.json', { name: 'root', private: true, version: '1.0.0' });

      const error = await createRepository(dir).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(error?.message).toContain('which is not a platform this repository has');
      /** The message has to say what the repository *does* have, or it only reports that something
       *  is wrong. */
      expect(error?.message).toContain('Registered: test');
      expect(error?.message).toContain('rman ships node');
    });

    /**
     * **Naming a built-in loads it**, which is the whole of what a Node package sitting inside
     * another repository has to write. Three claims in one repository, because they are one
     * decision:
     *
     * - the platform arrives although no `plugins` entry named it;
     * - **the commands do not** - `platform()` and not `contribute()`, so what is loaded is the
     *   technology. Repo-wide commands come from root `plugins`, because an `rman clean` reaching
     *   a whole Cargo repository is not what "one of my packages is Node" asked for;
     * - detection does not run, because the repository *said* something. Guessing anyway would put
     *   a second platform beside the declared one, competing for every directory the declaration
     *   did not cover.
     *
     * On a bare application, not the fixture's: with `test` registered, `node` would be a second
     * technology and detection would already be suppressed by `platforms.size`, so the spec would
     * pass without the condition it is about. The control is the case below it.
     */
    it('loads a built-in it names, the technology alone, and stands in for detection', async () => {
      const dir = tmp();
      write(dir, '.rmanrc', { platform: 'node' });
      write(dir, 'package.json', { name: 'root', private: true, version: '1.0.0' });

      const repository = await Repository.create(dir, { app: new RmanApplication() });
      expect(repository.rootPackage.provider).toBe('node');
      expect(repository.detectedBuiltin).toBeUndefined();
      /** The boundary, stated as an assertion: `clean` and `ci` are not here. */
      expect(repository.config.commands).toBeUndefined();
      expect(repository.config.publishTargets).toBeUndefined();
    });

    /** The control for the one above: the identical repository with the key removed *is* detected,
     *  and detection brings the whole built-in - commands included. */
    it('and without it the same repository is detected instead, contributions and all', async () => {
      const dir = tmp();
      write(dir, '.rmanrc', {});
      write(dir, 'package.json', { name: 'root', private: true, version: '1.0.0' });

      const app = new RmanApplication();
      app.logger.level = 'silent';
      const repository = await Repository.create(dir, { app });
      expect(repository.detectedBuiltin?.name).toBe('node');
      expect(repository.config.commands).toBeDefined();
    });

    /**
     * **Read while the packages are still being found**, so there is no `pkg` for an expression to
     * be about - this key is what decides what a package *is*. Passed through, a `${{ }}` reached
     * the lookup as raw text and failed as an unknown platform name, which sends the reader to
     * check their `plugins`.
     */
    it('refuses an expression, rather than reading it as a literal name', async () => {
      const dir = tmp();
      write(dir, '.rmanrc', { platform: '${{ pkg.provider }}' });
      write(dir, 'package.json', { name: 'root', private: true, version: '1.0.0' });

      await expect(createRepository(dir)).rejects.toThrow(/"platform" cannot be an expression/);
    });
  });

  /**
   * What a repository makes of the tree: `children` is the edge, `parent` its other half, and
   * `packages` the flattening.
   */
  describe('Repository', () => {
    it("hangs children off the root, and each package's parent points back at it", async () => {
      const dir = tmp();
      write(dir, '.rmanrc', {});
      write(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      write(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      write(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });

      const repository = await createRepository(dir);
      expect(repository.children.map(p => p.name)).toEqual(['pkg-a', 'pkg-b']);
      expect(repository.getPackage('pkg-a')!.parent).toBe(repository.rootPackage);
      expect(repository.rootPackage.parent).toBeUndefined();
      /** `Repository extends Package` while holding a separate `rootPackage` for the same
       *  directory, so both are truthfully the root - they share the one array. */
      expect(repository.children).toBe(repository.rootPackage.children);
    });

    /**
     * **The nesting the old flat list could not express.** `parent` used to be recomputed from path
     * prefixes after the fact; it is read off the walk now, so the answer comes from the same place
     * the package came from.
     */
    it('nests a package inside another, rather than hanging both off the root', async () => {
      const dir = tmp();
      write(dir, '.rmanrc', {});
      write(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      write(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0', workspaces: ['inner/*'] });
      write(dir, 'packages/a/inner/deep/package.json', { name: 'pkg-deep', version: '1.0.0' });

      const repository = await createRepository(dir);
      const a = repository.getPackage('pkg-a')!;
      const deep = repository.getPackage('pkg-deep')!;
      expect(a.children.map(p => p.name)).toEqual(['pkg-deep']);
      expect(deep.parent).toBe(a);
      expect(a.parent).toBe(repository.rootPackage);
      /** And `packages` is that tree flattened, which is what every command still reads. */
      expect(
        repository
          .getPackages()
          .map(p => p.name)
          .sort(),
      ).toEqual(['pkg-a', 'pkg-deep']);
    });

    /**
     * **`children` is walkable and `parent` is not** - one edge, two halves, and only one of them
     * can be the direction a walk goes.
     *
     * **Two cycles had to close for this, and only one of them was the tree's.** `parent` is the
     * new half; `repository` is the older one and it was enumerable since there was a `Repository` -
     * a repository holds every package, so a single back-reference makes any package a cycle
     * whatever the tree edges do. Measured before either was touched: `JSON.stringify(pkg-a)`,
     * `JSON.stringify(rootPackage)` and `JSON.stringify(rootPackage.children)` all threw, and the
     * error named the culprit (`property 'repository' closes the circle`). Making only `parent`
     * non-enumerable would have produced a tree that still cannot be dumped.
     *
     * **Asserted from the root, which is the only place the cycle is.** A leaf proves nothing -
     * `pkg-a.children` is `[]` - and that vacuous version of this spec passed with `parent`
     * enumerable (measured, while writing it).
     */
    it('walks and serializes downwards: children enumerable, parent and repository not', async () => {
      const dir = tmp();
      write(dir, '.rmanrc', {});
      write(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      write(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      write(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });

      const repository = await createRepository(dir);
      const a = repository.getPackage('pkg-a')!;
      /** Both still *readable* - non-enumerable is not private. */
      expect(a.parent).toBe(repository.rootPackage);
      expect(a.repository).toBe(repository);

      expect(Object.keys(a)).toContain('children');
      expect(Object.keys(a)).not.toContain('parent');
      expect(Object.keys(a)).not.toContain('repository');
      /** The root carries a `parent` of `undefined` in neither form - the `declare` that keeps
       *  TypeScript from emitting a class field, which it did until this was measured. */
      expect(Object.keys(repository.rootPackage)).not.toContain('parent');

      const dumped = JSON.parse(JSON.stringify(repository.rootPackage.children));
      expect(dumped.map((p: { manifest: { name: string } }) => p.manifest.name)).toEqual(['pkg-a', 'pkg-b']);
    });
  });
});
