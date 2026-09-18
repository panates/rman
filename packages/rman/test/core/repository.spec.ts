import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { Repository } from '../../src/core/repository.js';
import { useTestEcosystem } from '../_fixture.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rman-repository-test-'));
}

function writeJson(dir: string, rel: string, data: unknown) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(data));
}

describe('core/Repository', () => {
  useTestEcosystem();

  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }

  describe('create()', () => {
    it('detects a monorepo from a "workspaces" field and discovers its packages', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });

      const repo = await Repository.create(dir);
      expect(repo.monorepo).toBe(true);
      expect(
        repo
          .getPackages()
          .map(p => p.name)
          .sort(),
      ).toEqual(['pkg-a', 'pkg-b']);
    });

    it('treats a directory with no "workspaces" field as a single package', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'solo', version: '1.0.0' });

      const repo = await Repository.create(dir);
      expect(repo.monorepo).toBe(false);
      expect(repo.getPackages().map(p => p.name)).toEqual(['solo']);
      expect(repo.rootPackage.name).toBe('solo');
    });

    /**
     * `Workspace.findRoot` runs **before any plugin is loaded** - it is looking for the config file
     * that names them - so it cannot ask what a package is. It takes the outermost `.rmanrc*` in the
     * chain, failing that the `.git` directory, failing that the directory it started from. These
     * specs are written against that, not against the old "walk up until a `package.json` has
     * `workspaces`", which was ecosystem knowledge in the one place that cannot have any.
     */
    it('walks upward from a nested cwd to the outermost .rmanrc', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      const nested = path.join(dir, 'packages', 'a', 'src', 'deep');
      fs.mkdirSync(nested, { recursive: true });

      const repo = await Repository.create(nested);
      expect(repo.dirname).toBe(dir);
      expect(repo.monorepo).toBe(true);
    });

    it('falls back to the ".git" directory when no .rmanrc names a root', async () => {
      const dir = tmp();
      fs.mkdirSync(path.join(dir, '.git'));
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      const nested = path.join(dir, 'packages', 'a');

      const repo = await Repository.create(nested);
      expect(repo.dirname).toBe(dir);
      expect(repo.monorepo).toBe(true);
    });

    it('starts from the given directory when there is neither an .rmanrc nor a .git', async () => {
      const dir = tmp();
      /** The one fixture here that deliberately writes **no** root marker - that is the case under
       *  test. `workspaces` alone means nothing to `findRoot`: knowing that a `package.json` can
       *  declare members is exactly the ecosystem knowledge it cannot have. */
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      const nested = path.join(dir, 'packages', 'a');
      fs.mkdirSync(nested, { recursive: true });
      writeJson(nested, 'package.json', { name: 'pkg-a', version: '1.0.0' });

      const repo = await Repository.create(nested);
      expect(repo.dirname).toBe(nested);
      expect(repo.monorepo).toBe(false);
    });

    /**
     * **The cost of "outermost wins", stated as a test rather than left to be discovered.** A
     * self-contained project nested inside a larger repository *and sharing its `.git`* resolves to
     * the outer root - the same repository by any definition git recognizes. A nested project with a
     * `.git` of its own is found correctly, which is the case that actually occurs.
     */
    it('resolves a nested project sharing the outer .git to the outer root', async () => {
      const dir = tmp();
      fs.mkdirSync(path.join(dir, '.git'));
      writeJson(dir, 'package.json', { name: 'root', version: '1.0.0' });
      const nested = path.join(dir, 'nested');
      fs.mkdirSync(nested, { recursive: true });
      writeJson(nested, 'package.json', { name: 'nested', version: '1.0.0' });

      const repo = await Repository.create(nested);
      expect(repo.rootPackage.name).toBe('root');
    });

    it('finds a nested project that has a .git of its own', async () => {
      const dir = tmp();
      fs.mkdirSync(path.join(dir, '.git'));
      writeJson(dir, 'package.json', { name: 'root', version: '1.0.0' });
      const nested = path.join(dir, 'nested');
      fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
      writeJson(nested, 'package.json', { name: 'nested', version: '1.0.0' });

      const repo = await Repository.create(nested);
      expect(repo.monorepo).toBe(false);
      expect(repo.rootPackage.name).toBe('nested');
    });
  });

  describe('getPackages() / getPackage()', () => {
    async function fixtureRepo(): Promise<Repository> {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-a': '1.0.0' },
      });
      writeJson(dir, 'packages/c/package.json', {
        name: 'pkg-c',
        version: '1.0.0',
        dependencies: { 'pkg-b': '1.0.0' },
      });
      return Repository.create(dir);
    }

    it('getPackage() finds a package by name, or returns undefined', async () => {
      const repo = await fixtureRepo();
      expect(repo.getPackage('pkg-b')?.name).toBe('pkg-b');
      expect(repo.getPackage('does-not-exist')).toBeUndefined();
    });

    it('getPackages({toposort:true}) orders dependencies before their dependents', async () => {
      const repo = await fixtureRepo();
      const order = repo.getPackages({ toposort: true }).map(p => p.name);
      expect(order.indexOf('pkg-a')).toBeLessThan(order.indexOf('pkg-b'));
      expect(order.indexOf('pkg-b')).toBeLessThan(order.indexOf('pkg-c'));
    });

    it('getPackages({scope}) filters to just the named package(s)', async () => {
      const repo = await fixtureRepo();
      expect(repo.getPackages({ scope: 'pkg-b' }).map(p => p.name)).toEqual(['pkg-b']);
      expect(
        repo
          .getPackages({ scope: ['pkg-a', 'pkg-c'] })
          .map(p => p.name)
          .sort(),
      ).toEqual(['pkg-a', 'pkg-c']);
      expect(repo.getPackages({ scope: 'does-not-exist' })).toEqual([]);
    });
  });

  describe('currentPackage', () => {
    function fixtureDir(): string {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      return dir;
    }

    it('is undefined when the repository was created from its own root', async () => {
      const dir = fixtureDir();
      expect((await Repository.create(dir)).currentPackage).toBeUndefined();
    });

    it('resolves to the package whose directory the repository was created from', async () => {
      const dir = fixtureDir();
      const repo = await Repository.create(path.join(dir, 'packages/a'));
      expect(repo.currentPackage?.name).toBe('pkg-a');
    });

    it('resolves to the owning package even from a directory nested deep inside it', async () => {
      const dir = fixtureDir();
      const nested = path.join(dir, 'packages/a', 'src', 'deep');
      fs.mkdirSync(nested, { recursive: true });
      const repo = await Repository.create(nested);
      expect(repo.currentPackage?.name).toBe('pkg-a');
    });

    it('is undefined for a non-monorepo (a single-package repository is always "at the root")', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'solo', version: '1.0.0' });
      expect((await Repository.create(dir)).currentPackage).toBeUndefined();
    });
  });

  describe('dependency resolution', () => {
    it('populates .dependencies from dependencies/devDependencies/peerDependencies/optionalDependencies, limited to in-repo packages', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-a': '1.0.0', lodash: '^4.0.0' },
        devDependencies: { 'pkg-nonexistent': '1.0.0' },
      });
      const repo = await Repository.create(dir);
      // lodash and pkg-nonexistent aren't workspace packages, so they're excluded.
      expect(repo.getPackage('pkg-b')?.dependencies.map(d => d.name)).toEqual(['pkg-a']);
    });

    it('resolves transitive dependencies (a depends on b depends on c => a lists both)', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        dependencies: { 'pkg-b': '1.0.0' },
      });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-c': '1.0.0' },
      });
      writeJson(dir, 'packages/c/package.json', { name: 'pkg-c', version: '1.0.0' });

      const repo = await Repository.create(dir);
      expect(
        repo
          .getPackage('pkg-a')
          ?.dependencies.map(d => d.name)
          .sort(),
      ).toEqual(['pkg-b', 'pkg-c']);
    });

    /**
     * `.rmanrc "dependencies"` states an **edge**, so an entry is a package name *or* a
     * repository-relative directory - a name identifies a package only where the ecosystem
     * guarantees uniqueness, while a directory is unique by construction.
     *
     * It used to also accept a `Record<string, string>`, documented as a "name -> range map". The
     * ranges went nowhere: the reader took `Object.keys` and dropped the values, and there was
     * nowhere for them to go - the cascade works from groups and severities, and a sibling's range
     * is rewritten in the *manifest*.
     */
    it('resolves a declared dependency by name, and by repository-relative directory', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/core/package.json', { name: 'pkg-core', version: '1.0.0' });
      writeJson(dir, 'packages/app/package.json', {
        name: 'pkg-app',
        version: '1.0.0',
        rman: { dependencies: ['pkg-core'] },
      });
      writeJson(dir, 'packages/tool/package.json', {
        name: 'pkg-tool',
        version: '1.0.0',
        rman: { dependencies: ['packages/core'] },
      });

      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-app')?.dependencies.map(d => d.name)).toEqual(['pkg-core']);
      expect(repo.getPackage('pkg-tool')?.dependencies.map(d => d.name)).toEqual(['pkg-core']);
    });

    it('ignores a declared entry that is neither a known name nor a package directory', async () => {
      // An unknown name always was ignored - the graph is a statement about packages that exist.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        rman: { dependencies: ['no-such-thing', 'packages/nowhere'] },
      });

      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-a')?.dependencies).toEqual([]);
    });

    it('does not loop forever on a 2-cycle, and a package never ends up depending on itself', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        dependencies: { 'pkg-b': '1.0.0' },
      });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-a': '1.0.0' },
      });

      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-a')?.dependencies.map(d => d.name)).toEqual(['pkg-b']);
      expect(repo.getPackage('pkg-b')?.dependencies.map(d => d.name)).toEqual(['pkg-a']);
    });

    it('does not loop forever on a 3-cycle either, and still excludes self from each package', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', {
        name: 'pkg-a',
        version: '1.0.0',
        dependencies: { 'pkg-b': '1.0.0' },
      });
      writeJson(dir, 'packages/b/package.json', {
        name: 'pkg-b',
        version: '1.0.0',
        dependencies: { 'pkg-c': '1.0.0' },
      });
      writeJson(dir, 'packages/c/package.json', {
        name: 'pkg-c',
        version: '1.0.0',
        dependencies: { 'pkg-a': '1.0.0' },
      });

      const repo = await Repository.create(dir);
      // each package transitively reaches the other two, but never itself.
      expect(
        repo
          .getPackage('pkg-a')
          ?.dependencies.map(d => d.name)
          .sort(),
      ).toEqual(['pkg-b', 'pkg-c']);
      expect(
        repo
          .getPackage('pkg-b')
          ?.dependencies.map(d => d.name)
          .sort(),
      ).toEqual(['pkg-a', 'pkg-c']);
      expect(
        repo
          .getPackage('pkg-c')
          ?.dependencies.map(d => d.name)
          .sort(),
      ).toEqual(['pkg-a', 'pkg-b']);
    });

    it('adds extra dependencies declared via a root .rmanrc selector', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[pkg-b]': { dependencies: ['pkg-a'] } }));

      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-b')?.dependencies.map(d => d.name)).toEqual(['pkg-a']);
    });
  });

  describe('config cascading (pkg.config)', () => {
    it('speaks for three audiences: "[/]" the root, "[ws:*]" the others, "[*]" all of them', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({
          foo: 'root-only',
          '[*]': { everyone: 'yes' },
          '[/]': { onlyRoot: 'yes' },
          '[ws:*]': { onlyWorkspace: 'yes' },
        }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, 'packages/b/.rmanrc'), JSON.stringify({ onlyWorkspace: 'b-own' }));

      const repo = await Repository.create(dir);
      /** The root: its own unmarked keys, plus `"[*]"` and `"[/]"` - and **not** `"[ws:*]"`.
       *  `"[*]"` reaching the root is the change here; before, selectors were not applied to the
       *  root at all, so `"[*]"` quietly meant what `"[ws:*]"` now says. */
      expect(repo.config).toEqual({ foo: 'root-only', everyone: 'yes', onlyRoot: 'yes' });
      expect(repo.getPackage('pkg-a')?.config).toEqual({ everyone: 'yes', onlyWorkspace: 'yes' });
      /** And a package's own unmarked config still beats any selector aimed at it. */
      expect(repo.getPackage('pkg-b')?.config).toEqual({ everyone: 'yes', onlyWorkspace: 'b-own' });
    });

    it('keeps the root out of a "[ws:*]" block even when it is the only selector', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[ws:*]': { group: 'lib' } }));
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

      const repo = await Repository.create(dir);
      expect(repo.config.group).toBeUndefined();
      expect(repo.getPackage('pkg-a')?.config.group).toBe('lib');
    });

    it('takes the long spelling too, and a workspace selector may carry its own glob', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ '[workspace:*]': { group: 'all-ws' }, '[ws:pkg-b]': { group: 'just-b' } }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });

      const repo = await Repository.create(dir);
      expect(repo.config.group).toBeUndefined();
      expect(repo.getPackage('pkg-a')?.config.group).toBe('all-ws');
      /** A glob-carrying workspace selector names something, so it outranks the catch-all whatever
       *  order they were written in. */
      expect(repo.getPackage('pkg-b')?.config.group).toBe('just-b');
    });

    it('in a single-package repository the root is the one package, so "[ws:*]" reaches nothing', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'solo', version: '1.0.0' });
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ '[*]': { star: 'yes' }, '[/]': { root: 'yes' }, '[ws:*]': { ws: 'yes' } }),
      );

      const repo = await Repository.create(dir);
      expect(repo.config).toEqual({ star: 'yes', root: 'yes' });
    });

    it('evaluates ${{ ... }} per package, in every string value', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, version: '2.0.0', workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({
          '[*]': {
            /** A **core** key that takes package-relative paths - the assertion is about `${{ }}`,
             *  not about stamping. It used to be `clean.include`, which is `rman-node`'s now: the
             *  core's `RmanConfig` does not declare it, and a core spec must not need a plugin. */
            version: { stamp: ['build', '../../coverage/${{ pkg.basename }}'] },
            changelog: { filePath: '${{ pkg.unscopedName }}-v${{ semver.major(pkg.version) }}.md' },
          },
        }),
      );
      writeJson(dir, 'packages/builder/package.json', { name: '@sqb/builder', version: '6.0.9' });

      const repo = await Repository.create(dir);
      // `pkg.basename` is the directory, not the package name - they differ for a scoped package.
      expect(repo.getPackage('@sqb/builder')?.config.version?.stamp).toEqual(['build', '../../coverage/builder']);
      // Real JavaScript, so there is no list of substitutions to keep growing.
      expect(repo.getPackage('@sqb/builder')?.config.changelog?.filePath).toBe('builder-v6.md');
    });

    it("a string that is nothing but one expression keeps the value's own type", async () => {
      // Otherwise this could only ever produce strings, and a boolean setting like
      // run.<script>.skip would be unreachable from an expression.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({
          '[*]': { run: { build: { skip: '${{ pkg.manifest.private === true }}', concurrency: '${{ 2 + 2 }}' } } },
        }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0', private: true });

      const repo = await Repository.create(dir);
      const cfg = repo.getPackage('pkg-a')?.config.run?.build as Record<string, unknown>;
      expect(cfg.skip).toBe(true);
      expect(cfg.concurrency).toBe(4);
    });

    it('handles several expressions in one string, and a literal ${{ produced by one', async () => {
      // The regression this guards: detecting "nothing but one expression" with an anchored
      // ^...$ regex, where a lazy quantifier still backtracks to reach the end anchor - so
      // "${{ a }} and ${{ b }}" read as a single expression whose body ran from a to b.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, version: '2.0.0', workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({
          '[*]': {
            run: {
              many: '${{ repository.name }} -> ${{ pkg.name }} v${{ pkg.version }}',
              // No escape syntax: an expression produces the literal, as in GitHub Actions.
              literal: "keep ${{ '${{' }} here",
            },
          },
        }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

      const repo = await Repository.create(dir);
      const run = repo.getPackage('pkg-a')?.config.run as Record<string, unknown>;
      expect(run.many).toBe('root -> pkg-a v1.0.0');
      expect(run.literal).toBe('keep ${{ here');
    });

    it('exposes the repository as a package plus repo-level facts', async () => {
      // The root *is* a package, so `repository` carries PackageScope's shape - and `name` (what
      // its package.json says) genuinely differs from `basename` (the directory it sits in).
      const dir = tmp();
      fs.renameSync(dir, dir + '-sqb');
      dirs.push(dir + '-sqb');
      const root = dir + '-sqb';
      writeJson(root, 'package.json', { name: 'sqb.v4', private: true, version: '4.0.8', workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(root, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(root, '.rmanrc'),
        JSON.stringify({
          '[*]': {
            run: {
              a: '${{ repository.name }} @ ${{ repository.version }} in ${{ repository.basename }}',
              b: '${{ repository.monorepo }} / ${{ repository.packages.length }}',
              c: '${{ repository.package("pkg-b")?.basename }}',
              d: '${{ repository.manifest.workspaces[0] }}',
            },
          },
        }),
      );
      writeJson(root, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(root, 'packages/bee/package.json', { name: 'pkg-b', version: '1.0.0' });

      const repo = await Repository.create(root);
      const run = repo.getPackage('pkg-a')?.config.run as Record<string, unknown>;
      expect(run.a).toBe(`sqb.v4 @ 4.0.8 in ${path.basename(root)}`);
      expect(run.b).toBe('true / 2');
      // Reaches a sibling by name, whose directory need not match it.
      expect(run.c).toBe('bee');
      expect(run.d).toBe('packages/*');
    });

    it('refuses a nullish expression embedded in text, but allows one standing alone', async () => {
      // Splicing the word "undefined" into a tag or path ("app:undefined") looks plausible and is
      // wrong. Alone it just means "unset", which is a legitimate answer.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ '[*]': { run: { tag: 'app:${{ pkg.manifest.missing }}' } } }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      await expect(Repository.create(dir)).rejects.toThrow(/run\.tag.*undefined inside a string/s);

      const ok = tmp();
      writeJson(ok, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(ok, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(ok, '.rmanrc'),
        JSON.stringify({
          '[*]': {
            run: { build: { skip: '${{ pkg.manifest.missing }}' }, tag: 'app:${{ pkg.manifest.missing ?? "dev" }}' },
          },
        }),
      );
      writeJson(ok, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      const repo = await Repository.create(ok);
      const run = repo.getPackage('pkg-a')?.config.run as Record<string, any>;
      expect(run.build.skip).toBeUndefined();
      expect(run.tag).toBe('app:dev');
    });

    it('leaves a bare {{...}} alone - it belongs to whatever else reads the command', async () => {
      // `helm template --set tag={{.Values.tag}}` must survive untouched; that is why the
      // delimiter is ${{ }} and not {{ }}.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ '[*]': { run: { deploy: 'helm template --set tag={{.Values.tag}}' } } }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-a')?.config.run?.deploy).toBe('helm template --set tag={{.Values.tag}}');
    });

    it('a failing expression names the config path holding it, instead of passing through', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ '[*]': { run: { build: { after: ['ok', '${{ pkg.nope.split("/") }}'] } } } }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

      await expect(Repository.create(dir)).rejects.toThrow(/run\.build\.after\[1\]/);
    });

    it('`vars` reaches every package, and a value that is itself an expression resolves per package', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({
          // Unmarked, at the root - the one key that does not stop at the root's own package.
          vars: { x: 1, outDir: 'build', image: 'panates/${{ pkg.basename }}' },
          '[*]': {
            /** A core key again - `publish.directory` left with `rman-node`. */
            changelog: { filePath: '${{ vars.outDir }}' },
            run: { a: '${{ vars.x }}', b: 'x is ${{ vars.x }}', c: '${{ vars.image }}:latest' },
          },
        }),
      );
      writeJson(dir, 'packages/core/package.json', { name: 'pkg-core', version: '1.0.0' });

      const repo = await Repository.create(dir);
      const pkg = repo.getPackage('pkg-core');
      expect(pkg?.config.changelog?.filePath).toBe('build');
      // Standing alone it keeps the value's own type; embedded it is stringified.
      expect(pkg?.config.run?.a).toBe(1);
      expect(pkg?.config.run?.b).toBe('x is 1');
      // The var's own `${{ pkg.basename }}` is evaluated for whoever reads it.
      expect(pkg?.config.run?.c).toBe('panates/core:latest');
    });

    it('a package overrides `vars` per key, keeping the ones it does not mention', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({
          vars: { outDir: 'build', keep: 'kept' },
          '[*]': { run: { a: '${{ vars.outDir }}/${{ vars.keep }}' } },
          '[pkg-b]': { vars: { outDir: 'dist' } },
        }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      writeJson(dir, 'packages/c/package.json', { name: 'pkg-c', version: '1.0.0' });
      // ...and in the package's own .rmanrc, not just from a selector at the root.
      fs.writeFileSync(path.join(dir, 'packages/c/.rmanrc'), JSON.stringify({ vars: { outDir: 'lib' } }));

      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-a')?.config.run?.a).toBe('build/kept');
      expect(repo.getPackage('pkg-b')?.config.run?.a).toBe('dist/kept');
      expect(repo.getPackage('pkg-c')?.config.run?.a).toBe('lib/kept');
    });

    it("lets a selector's `vars` beat the same directory's plainer statement", async () => {
      // The root's unmarked `vars` cascades, but `"[*]"` names the packages explicitly - the more
      // specific statement has to win, which is why it is merged after.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({
          vars: { who: 'root-plain' },
          '[*]': { vars: { who: 'selector-wins' }, run: { a: '${{ vars.who }}' } },
          run: { a: '${{ vars.who }}' },
        }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-a')?.config.run?.a).toBe('selector-wins');
      // The root package still reads its own, which is the only `vars` that was about it.
      expect(repo.rootPackage.config.run?.a).toBe('root-plain');
    });

    it('file.exists() answers per package, returning the path or "" so || picks the first present', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({
          '[ws:*]': {
            run: {
              build: { exec: 'tsc -b ${{ file.exists("tsconfig-build.json") || file.resolve("tsconfig.json") }}' },
              // "" rather than undefined precisely so a miss is falsy and never reaches the
              // "nullish inside a string" guard.
              miss: '${{ JSON.stringify(file.exists("nope.json")) }}',
            },
          },
        }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, 'packages/a/tsconfig-build.json'), '{}');
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, 'packages/b/tsconfig.json'), '{}');

      const repo = await Repository.create(dir);
      // One declaration, a different answer per package - resolved against each package's own
      // directory, not the repository root.
      const a = repo.getPackage('pkg-a')?.config.run?.build as Record<string, unknown>;
      const b = repo.getPackage('pkg-b')?.config.run?.build as Record<string, unknown>;
      expect(a.exec).toBe(`tsc -b ${path.join(dir, 'packages/a/tsconfig-build.json')}`);
      expect(b.exec).toBe(`tsc -b ${path.join(dir, 'packages/b/tsconfig.json')}`);
      expect(repo.getPackage('pkg-a')?.config.run?.miss).toBe('""');
    });

    it("binds Node's own `path`, so a path need not be glued together with string concatenation", async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({
          '[*]': {
            run: {
              // `+ "/" +` is what this replaces - it produces "a//b" or "ab" depending on what the
              // two halves happen to end and start with.
              a: '${{ path.join(pkg.relativeDir, "LICENSE") }}',
              b: '${{ path.basename(pkg.dirname) }}',
              // The posix flavour stays reachable for something that is always posix.
              c: '${{ path.posix.join("panates", pkg.basename) }}',
            },
          },
        }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

      const repo = await Repository.create(dir);
      const run = repo.getPackage('pkg-a')?.config.run as Record<string, unknown>;
      expect(run.a).toBe(path.join('packages/a', 'LICENSE'));
      expect(run.b).toBe('a');
      expect(run.c).toBe('panates/a');
    });

    it('file.resolveFirst() takes the first that exists, per package, and names them all when none do', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({
          '[ws:*]': {
            run: {
              build: { exec: 'tsc -b ${{ file.resolveFirst("tsconfig-build.json", "tsconfig.json") }}' },
            },
          },
        }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, 'packages/a/tsconfig-build.json'), '{}');
      writeJson(dir, 'packages/b/package.json', { name: 'pkg-b', version: '1.0.0' });
      fs.writeFileSync(path.join(dir, 'packages/b/tsconfig.json'), '{}');

      const repo = await Repository.create(dir);
      const exec = (name: string) =>
        (repo.getPackage(name)?.config.run?.build as Record<string, unknown>).exec as string;
      expect(exec('pkg-a')).toBe(`tsc -b ${path.join(dir, 'packages/a/tsconfig-build.json')}`);
      expect(exec('pkg-b')).toBe(`tsc -b ${path.join(dir, 'packages/b/tsconfig.json')}`);
    });

    it('file.resolveFirst() fails rather than leaving the command an argument short', async () => {
      // The reason it exists next to an `exists() || exists()` chain: ending such a chain in
      // `exists()` yields `tsc -b ` with nothing after it, and tsc then quietly falls back to the
      // directory's default instead of saying the package has no build config.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({
          '[ws:*]': { run: { build: { exec: '${{ file.resolveFirst("a.json", "b.json") }}' } } },
        }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

      await expect(Repository.create(dir)).rejects.toThrow(/found none of: "a\.json", "b\.json"/);
    });

    it('file.resolve() throws when nothing is there, naming the config path and the path it tried', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ '[ws:*]': { run: { build: { exec: 'tsc -b ${{ file.resolve("tsconfig.json") }}' } } } }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

      await expect(Repository.create(dir)).rejects.toThrow(
        /run\.build\.exec[\s\S]*file\.resolve\("tsconfig\.json"\) found nothing at .*packages.a.tsconfig\.json/,
      );
    });

    it("reads the config's own keys bare, so a value need not restate another", async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({
          '[*]': {
            // Declared *after* the value that reads it: resolution is on demand, so the order of
            // keys in the file says nothing about the answer.
            run: { build: { after: 'cp README.md ${{ publish.directory }}/' } },
            publish: { directory: 'out-${{ pkg.basename }}' },
          },
        }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

      const repo = await Repository.create(dir);
      const build = repo.getPackage('pkg-a')?.config.run?.build as Record<string, unknown>;
      // The key it read was itself an expression, and resolved before being handed over.
      expect(build.after).toBe('cp README.md out-a/');
    });

    it('a whole subtree is readable, keeping its own type', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ '[*]': { clean: { include: ['build'] }, run: { x: '${{ clean.include[0] }}' } } }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-a')?.config.run?.x).toBe('build');
    });

    it('reports a cycle as a cycle, naming the keys in it', async () => {
      // The trap: a host getter that throws inside a `vm` property interceptor has its exception
      // swallowed and V8 then reports the global as *absent* - so this used to surface as
      // "publish is not defined", sending the reader after a missing key instead of a loop.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({
          '[*]': { publish: { directory: '${{ clean.include }}' }, clean: { include: '${{ publish.directory }}' } },
        }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

      await expect(Repository.create(dir)).rejects.toThrow(/forms a cycle: publish -> clean -> publish/);
    });

    it('lets a scope binding win over a config key of the same name', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      // No config key is named `pkg` today, so nothing collides - but one added later must not
      // silently take the namespace over, which is what binding config keys bare risks.
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ '[*]': { pkg: { basename: 'WRONG' }, run: { x: '${{ pkg.basename }}' } } }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-a')?.config.run?.x).toBe('a');
    });

    it('binds bare `version` to the options block - the package version is `pkg.version`', async () => {
      // One word, two things, and the plain one belongs to the config because every other config
      // key is reachable that way. Worth pinning: it reads like it should be the version string.
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,
       *  since it runs before the plugins that would know what a package is. */
      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({
          '[*]': {
            version: { commitMessage: 'release me' },
            run: { a: '${{ version.commitMessage }}', b: '${{ pkg.version }}' },
          },
        }),
      );
      writeJson(dir, 'packages/a/package.json', { name: 'pkg-a', version: '1.0.0' });

      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-a')?.config.run?.a).toBe('release me');
      expect(repo.getPackage('pkg-a')?.config.run?.b).toBe('1.0.0');
    });
  });

  /**
   * A config value written as a **function** - the JS spelling of a `${{ }}` expression, answering
   * the same question at the same moment, with the same scope plus `value`.
   *
   * Every case goes through a real `.rmanrc.cjs`, because that is the only form able to carry one
   * and because the point is that it survives loading, merging and resolution.
   */
  describe('value functions', () => {
    /** Writes a repository whose root config is JS source, plus N packages. */
    function jsFixture(source: string, packages: string[] = ['pkg-a']): string {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc.cjs'), `module.exports = ${source};\n`);
      for (const name of packages) writeJson(dir, `packages/${name}/package.json`, { name, version: '1.0.0' });
      return dir;
    }

    it('is called with the same scope an expression gets, per package', async () => {
      const dir = jsFixture(`{ '[ws:*]': { group: ({ pkg, repository }) => pkg.name + '@' + repository.basename } }`, [
        'pkg-a',
        'pkg-b',
      ]);
      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-a')?.config.group).toBe(`pkg-a@${path.basename(dir)}`);
      expect(repo.getPackage('pkg-b')?.config.group).toBe(`pkg-b@${path.basename(dir)}`);
    });

    it("reads the config's own top-level keys bare, as an expression does", async () => {
      const dir = jsFixture(
        `{ vars: { buildDir: 'out' }, '[*]': { publish: { directory: ({ vars }) => vars.buildDir } } }`,
      );
      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-a')?.config.publish?.directory).toBe('out');
    });

    it('resolves a function inside vars, which other keys then read', async () => {
      const dir = jsFixture(
        `{ vars: { coverage: ({ repository }) => require('node:path').join(repository.dirname, 'coverage') },
           '[*]': { publish: { directory: ({ vars }) => vars.coverage } } }`,
      );
      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-a')?.config.publish?.directory).toBe(path.join(dir, 'coverage'));
    });

    /**
     * `value` is what the key resolved to in the layers **underneath** - the general form of `+key`,
     * and the reason the chain is built during the merge rather than after it: by the time the
     * config is resolved the layers have collapsed, and a closer layer's value has already taken
     * the place of what it was derived from.
     */
    it('hands a layer what the layers below it resolved to, as `value`', async () => {
      const dir = jsFixture(
        `{ '[*]':    { clean: { include: () => ['build'] } },
           '[ws:*]': { clean: { include: ({ value, pkg }) => [...value, pkg.name + '.log'] } } }`,
      );
      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-a')?.config.clean?.include).toEqual(['build', 'pkg-a.log']);
      /** The root is not in `"[ws:*]"`, so it stops at the first layer - which is also the case
       *  that proves the chain is per-package rather than computed once. */
      expect(repo.config.clean?.include).toEqual(['build']);
    });

    it('resolves the inherited value before handing it over, expressions included', async () => {
      const dir = jsFixture(
        `{ '[*]':    { clean: { include: ['\${{ pkg.name }}-base'] } },
           '[ws:*]': { clean: { include: ({ value }) => [...value, 'extra'] } } }`,
      );
      const repo = await Repository.create(dir);
      expect(repo.getPackage('pkg-a')?.config.clean?.include).toEqual(['pkg-a-base', 'extra']);
    });

    it('gives `value` as undefined when nothing below sets the key, and says so when that throws', async () => {
      // Undefined rather than `[]`: defaulting would be a guess about the key's type, and wrong for
      // every key that is not a list. So the error has to name the cause instead - V8's own
      // "value is not iterable" names neither the key nor the reason.
      const dir = jsFixture(`{ '[*]': { clean: { include: ({ value }) => [...value] } } }`);
      await expect(Repository.create(dir)).rejects.toThrow(/`value` is undefined here/);
      await expect(Repository.create(dir)).rejects.toThrow(/nothing below this layer sets "clean.include"/);
    });

    it('names the config path when a function throws', async () => {
      const dir = jsFixture(`{ '[*]': { group: () => { throw new Error('nope'); } } }`);
      await expect(Repository.create(dir)).rejects.toThrow(/Config function in "group" failed: nope/);
    });

    /**
     * **The two contexts must expose the same names**, and this enumerates both rather than
     * checking a list someone has to remember to extend.
     *
     * They cannot drift by accident today - the function's argument is `Object.create(context)`, so
     * it *is* the expression context with one property added - but a member defined straight onto
     * the argument would split them silently, and a config author would find a name that works in
     * one spelling and not the other.
     */
    it('exposes exactly what an expression does, plus `value`', async () => {
      const dir = jsFixture(
        `{ '[*]': {
             vars: { sample: 'x' },
             publish: { directory: 'build' },
             inExpr: '\${{ Object.keys(globalThis).sort().join(",") }}',
             inFn: s => {
               const names = new Set();
               for (let o = s; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
                 for (const k of Object.keys(o)) names.add(k);
               return [...names].sort().join(',');
             },
           } }`,
      );
      const cfg = (await Repository.create(dir)).getPackage('pkg-a')!.config as Record<string, string>;
      const inExpression = new Set(cfg.inExpr.split(','));
      const inFunction = new Set(cfg.inFn.split(','));

      /** Every scope binding, and the config's own top-level keys, in both. */
      for (const name of ['pkg', 'repository', 'file', 'read', 'env', 'semver', 'path', 'git', 'vars', 'publish']) {
        expect([name, inExpression.has(name)]).toEqual([name, true]);
        expect([name, inFunction.has(name)]).toEqual([name, true]);
      }

      expect([...inExpression].filter(n => !inFunction.has(n))).toEqual([]);
      /** `value` is the one deliberate asymmetry: an expression is a string, so it could not carry
       *  an inherited array back anyway - measured, `${{ value }}` is `value is not defined`. */
      expect([...inFunction].filter(n => !inExpression.has(n))).toEqual(['value']);
    });

    it('keeps the `value` hint off a failure that never read `value`', async () => {
      // The hint used to go out with every failure of a first-layer function, so an unrelated
      // `TypeError` arrived wearing advice about spreading an inherited list - the exact
      // send-the-reader-to-the-wrong-place mistake the hint exists to prevent. Whether `value` was
      // read is *recorded*, not guessed from the message: matching on V8's wording is the other way
      // to get this wrong.
      const dir = jsFixture(`{ '[*]': { group: () => { throw new Error('unrelated'); } } }`);
      await expect(Repository.create(dir)).rejects.toThrow(/failed: unrelated/);
      await expect(Repository.create(dir)).rejects.not.toThrow(/`value` is undefined here/);
    });

    /**
     * The other half of the rule, and the one that makes both halves usable: **the key decides**
     * whether a function is a value to compute now or code to run later. A step is left alone.
     */
    it('leaves a step function alone - run.<script> slots, the shorthand, and `if`', async () => {
      const dir = jsFixture(
        `{ '[*]': { run: {
             build: { before: () => {}, exec: () => {}, after: () => {}, if: () => true },
             test: function shorthand() {},
           } } }`,
      );
      const repo = await Repository.create(dir);
      const cfg = repo.getPackage('pkg-a')!.config;
      for (const slot of ['before', 'exec', 'after', 'if'] as const) {
        expect(typeof (cfg.run as any).build[slot]).toBe('function');
      }
      /** The bare-value shorthand too: `run: { test: fn }` is `{ exec: fn }`, so calling it here
       *  would make the short spelling run at a different time than the long one. */
      expect(typeof (cfg.run as any).test).toBe('function');
    });

    it("leaves a plugin's own functions alone - they are code, not config", async () => {
      // Measured: with `plugins` walked like any other key, resolving the config called the
      // plugin's yargs builder with the config scope ("cmd.option is not a function").
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(
        path.join(dir, '.rmanrc.cjs'),
        `module.exports = { plugins: [{ name: 'p', commands: [
           { command: 'x', describe: 'a command', builder: cmd => cmd.option('y'), handler() {} },
         ] }] };\n`,
      );
      writeJson(dir, 'packages/pkg-a/package.json', { name: 'pkg-a', version: '1.0.0' });

      const repo = await Repository.create(dir);
      expect(typeof (repo.config.plugins as any)[0].commands[0].builder).toBe('function');
    });
  });

  /**
   * `git` is bound at the **top level** of the expression scope, beside `env` - not on
   * `repository`, where it used to be. `repository` shares its shape with `pkg` because the root
   * *is* a package, and its other members describe the repository as a container of packages; a
   * branch name describes none of that, only the working tree they all sit in.
   */
  /**
   * `read(path)` - a structured file's **contents**, where `file` answers only where one is.
   * Resolved against `pkg.dirname` like `file`, so one `"[*]"` declaration reads each package's own.
   */
  /**
   * `vars` declared at any level of the config tree, scoping its own subtree - a fresh copy per
   * level, the level's own block merged over what the level above resolved to.
   */
  describe('scoped vars', () => {
    function varsFixture(config: unknown): string {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify(config));
      writeJson(dir, 'packages/pkg-a/package.json', { name: 'pkg-a', version: '1.0.0' });
      return dir;
    }

    it('shadows per level, so each node reads the nearest declaration', async () => {
      const dir = varsFixture({
        vars: { x: 1 },
        '[*]': {
          top: '${{ vars.x }}',
          run: {
            vars: { x: 2 },
            clean: { probe: '${{ vars.x }}' },
            build: { vars: { x: 3 }, probe: '${{ vars.x }}' },
          },
        },
      });
      const cfg = (await Repository.create(dir)).getPackage('pkg-a')!.config as any;
      expect(cfg.top).toBe(1);
      expect(cfg.run.clean.probe).toBe(2);
      expect(cfg.run.build.probe).toBe(3);
    });

    it('merges per key, so redeclaring one var keeps the rest', async () => {
      const dir = varsFixture({
        vars: { x: 1, keep: 'top' },
        '[*]': { run: { vars: { x: 2 }, clean: { probe: '${{ vars.keep + ":" + vars.x }}' } } },
      });
      const cfg = (await Repository.create(dir)).getPackage('pkg-a')!.config as any;
      expect(cfg.run.clean.probe).toBe('top:2');
    });

    it("resolves a level's own block against the level above it, not against itself", async () => {
      // `vars: { out: '${{ vars.x }}/dist' }` refines the `x` it is inheriting - reading its own
      // half-built scope instead would make the answer depend on key order inside the block.
      const dir = varsFixture({
        vars: { x: 'outer' },
        '[*]': {
          run: { vars: { x: 'inner', derived: '${{ vars.x }}-seen' }, clean: { probe: '${{ vars.derived }}' } },
        },
      });
      const cfg = (await Repository.create(dir)).getPackage('pkg-a')!.config as any;
      expect(cfg.run.clean.probe).toBe('outer-seen');
    });

    /**
     * **The reason a copy is made at every node rather than only where a block appears.** A value
     * function is handed this object, so one that writes to it must be writing into its own level -
     * without a copy per node a write inside `run.build` would land in `run`'s object, and a sibling
     * would read it.
     */
    it('keeps a write inside the level that made it', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(
        path.join(dir, '.rmanrc.cjs'),
        `module.exports = {
           vars: { x: 1 },
           '[*]': {
             run: {
               vars: { x: 2 },
               build: {
                 vars: ({ value }) => ({ ...(value ?? {}), x: 3 }),
                 probe: ({ vars }) => { vars.addedHere = true; return JSON.stringify(vars); },
               },
               clean: { probe: '\${{ JSON.stringify(vars) }}' },
             },
             outer: '\${{ JSON.stringify(vars) }}',
           },
         };
`,
      );
      writeJson(dir, 'packages/pkg-a/package.json', { name: 'pkg-a', version: '1.0.0' });

      const cfg = (await Repository.create(dir)).getPackage('pkg-a')!.config as any;
      expect(JSON.parse(cfg.run.build.probe)).toEqual({ x: 3, addedHere: true });
      /** Neither the shadowed `x` nor the added key reaches a sibling, the level above, or the top. */
      expect(JSON.parse(cfg.run.clean.probe)).toEqual({ x: 2 });
      expect(JSON.parse(cfg.outer)).toEqual({ x: 1 });
      expect(cfg.vars).toEqual({ x: 1 });
    });

    it('leaves the declaration in the resolved config, where `rman config` can show it', async () => {
      // `run.vars` is a scope rather than a script, which costs a script that would have been
      // called `vars` - nothing enumerates `run`'s keys as script names, so the cost stops there.
      const dir = varsFixture({ '[*]': { run: { vars: { x: 2 }, clean: { probe: '${{ vars.x }}' } } } });
      const cfg = (await Repository.create(dir)).getPackage('pkg-a')!.config as any;
      expect(cfg.run.vars).toEqual({ x: 2 });
    });
  });

  describe('${{ read() }}', () => {
    function readFixture(config: unknown, files: Record<string, string> = {}, packages = ['pkg-a']): string {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify(config));
      for (const name of packages) writeJson(dir, `packages/${name}/package.json`, { name, version: '1.0.0' });
      for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
      }
      return dir;
    }

    it('parses json, yaml and ini, choosing by extension', async () => {
      const dir = readFixture(
        {
          /** `"[ws:*]"`, not `"[*]"`: these files live in the package, and the root has none of
           *  them - the documented hazard of `"[*]"` now reaching the root as well. */
          '[ws:*]': {
            j: '${{ read("t.json").compilerOptions.outDir }}',
            y: '${{ read("c.yml").services.db.image }}',
            i: '${{ read(".npmrc", "ini").registry }}',
          },
        },
        {
          'packages/pkg-a/t.json': '{"compilerOptions":{"outDir":"lib"}}',
          'packages/pkg-a/c.yml': 'services:\n  db:\n    image: postgres:16\n',
          /** No extension to go on, so the caller names the format - the same shape
           *  `version.stamp`'s `{ file, constant }` uses: infer, but let an entry say. */
          'packages/pkg-a/.npmrc': 'registry=https://example.test\n',
        },
      );
      const cfg = (await Repository.create(dir)).getPackage('pkg-a')!.config as Record<string, unknown>;
      expect(cfg.j).toBe('lib');
      expect(cfg.y).toBe('postgres:16');
      expect(cfg.i).toBe('https://example.test');
    });

    /**
     * XML comes back as a **DOM**, not an object, and that asymmetry is the honest shape rather
     * than an omission: an element can repeat, carry attributes and hold text at once, so any
     * flattening picks a convention and is wrong for somebody.
     */
    it('parses xml to a DOM, by extension and by the project-file names', async () => {
      const dir = readFixture(
        {
          '[ws:*]': {
            pom: '${{ read("pom.xml").getElementsByTagName("version")[0].textContent }}',
            /** A .NET project file is XML whatever its extension calls itself. */
            csproj: '${{ read("app.csproj").getElementsByTagName("Version")[0].textContent }}',
            ns: '${{ read("pom.xml").getElementsByTagNameNS("http://maven.apache.org/POM/4.0.0","artifactId")[0].textContent }}',
          },
        },
        {
          'packages/pkg-a/pom.xml':
            '<project xmlns="http://maven.apache.org/POM/4.0.0"><artifactId>demo</artifactId>' +
            '<version>2.4.1</version></project>',
          'packages/pkg-a/app.csproj': '<Project><PropertyGroup><Version>9.0.2</Version></PropertyGroup></Project>',
        },
      );
      const cfg = (await Repository.create(dir)).getPackage('pkg-a')!.config as Record<string, unknown>;
      expect(cfg.pom).toBe('2.4.1');
      expect(cfg.csproj).toBe('9.0.2');
      expect(cfg.ns).toBe('demo');
    });

    it('survives being frozen, including a tag first queried after the freeze', async () => {
      // The case that would have broken it: `getElementsByTagName` returns a *live* collection, so
      // a DOM frozen on the way into the cache has to still answer a tag nobody asked about yet.
      const dir = readFixture({}, { 'p.xml': '<a><b id="1">x</b><b id="2">y</b></a>' });
      const repo = await Repository.create(dir);
      const doc = repo.configScope(repo.getPackages()[0]).read(path.join(dir, 'p.xml')) as Document;

      expect(Object.isFrozen(doc)).toBe(true);
      const found = doc.getElementsByTagName('b');
      expect(found.length).toBe(2);
      expect(found[1].getAttribute('id')).toBe('2');
      expect(found[0].textContent).toBe('x');
    });

    it('refuses a malformed xml file instead of handing back what it salvaged', async () => {
      // xmldom reports problems through a handler and otherwise carries on, so without the guard a
      // truncated file came back as a half-parsed DOM and the expression reading it found nothing.
      const dir = readFixture(
        { '[ws:*]': { v: '${{ read("broken.xml").documentElement.nodeName }}' } },
        { 'packages/pkg-a/broken.xml': '<project><version>1.0</version>' },
      );
      await expect(Repository.create(dir)).rejects.toThrow(/could not parse .*broken\.xml as xml: unclosed xml tag/);
    });

    it('reads the same file once for the whole repository, not once per package', async () => {
      // `interpolateConfig` runs once *per package*, so a cache living in one pass would not have
      // helped across them at all - which is why it lives on the `Repository`.
      const dir = readFixture(
        { '[ws:*]': { v: '${{ read(path.join(repository.dirname, "shared.json")).shared }}' } },
        { 'shared.json': '{"shared":"once"}' },
        ['pkg-a', 'pkg-b', 'pkg-c'],
      );
      const real = fs.readFileSync;
      let reads = 0;
      (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = function (file: never, ...rest: never[]) {
        if (String(file).endsWith('shared.json')) reads++;
        return (real as (...a: never[]) => string).call(fs, file, ...rest);
      } as typeof fs.readFileSync;
      try {
        const repo = await Repository.create(dir);
        expect(repo.getPackages().map(p => p.config.v)).toEqual(['once', 'once', 'once']);
        expect(reads).toBe(1);
      } finally {
        (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = real;
      }
    });

    /**
     * Keyed on `mtimeNs:size`, not on the path - because **rman writes JSON files while it runs**.
     * `version` rewrites every bumped manifest and then re-interpolates its own deferred hooks; a
     * cache that only remembered the path would hand those back as they were before the write.
     */
    it('re-reads a file that changed under it', async () => {
      const dir = readFixture({}, { 'shared.json': '{"v":"before"}' });
      const repo = await Repository.create(dir);
      const file = path.join(dir, 'shared.json');
      const scope = repo.configScope(repo.getPackages()[0]);

      expect((scope.read(file) as { v: string }).v).toBe('before');
      fs.writeFileSync(file, '{"v":"after"}');
      expect((scope.read(file) as { v: string }).v).toBe('after');
    });

    /**
     * Every package is handed the **same** object, so one config mutating it would quietly change
     * what the next package sees - the reason `pkg.manifest` has always been a copy. Frozen once on
     * the way into the cache rather than copied on every call: copying costs 5.6µs per call against
     * ~1µs once, and freezing turns the mistake into a `TypeError` instead of an effect at a
     * distance.
     */
    it('hands every package the same frozen object', async () => {
      const dir = readFixture({}, { 'shared.json': '{"list":[1]}' }, ['pkg-a', 'pkg-b']);
      const repo = await Repository.create(dir);
      const file = path.join(dir, 'shared.json');
      const a = repo.configScope(repo.getPackages()[0]).read(file) as { list: number[] };
      const b = repo.configScope(repo.getPackages()[1]).read(file);

      expect(a).toBe(b);
      expect(Object.isFrozen(a)).toBe(true);
      /** Deeply - a nested array is the half a shallow freeze would leave writable. */
      expect(Object.isFrozen(a.list)).toBe(true);
      expect(() => a.list.push(2)).toThrow(TypeError);
    });

    it('throws with the file named, for every way it can fail', async () => {
      const missing = readFixture({ '[ws:*]': { a: '${{ read("nope.json").x }}' } });
      await expect(Repository.create(missing)).rejects.toThrow(/read\("nope\.json"\) found nothing at/);
      /** And points at the composition that handles an absent file, rather than leaving the reader
       *  to find `file.exists` on their own. */
      await expect(Repository.create(missing)).rejects.toThrow(/Use file\.exists\(\) first/);

      const unknown = readFixture({ '[ws:*]': { a: '${{ read("x.conf").y }}' } }, { 'packages/pkg-a/x.conf': 'x' });
      await expect(Repository.create(unknown)).rejects.toThrow(/cannot tell what "x\.conf" is from its name/);

      const broken = readFixture(
        { '[ws:*]': { a: '${{ read("b.json").y }}' } },
        { 'packages/pkg-a/b.json': 'not json {' },
      );
      /** The parser says what is wrong with the syntax but never which file it was reading - and one
       *  expression can name several. */
      await expect(Repository.create(broken)).rejects.toThrow(/read\("b\.json"\) could not parse .*b\.json as json/);
    });

    it('composes with file.exists for a file that may not be there', async () => {
      const dir = readFixture({
        '[ws:*]': { a: '${{ file.exists("maybe.json") ? read("maybe.json").x : "absent" }}' },
      });
      expect((await Repository.create(dir)).getPackage('pkg-a')!.config.a).toBe('absent');
    });
  });

  describe('${{ git }}', () => {
    function gitFixture(config: unknown, packages = ['pkg-a']): string {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify(config));
      for (const name of packages) writeJson(dir, `packages/${name}/package.json`, { name, version: '1.0.0' });
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      git('init', '-q');
      git('config', 'user.email', 't@t.com');
      git('config', 'user.name', 't');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      return dir;
    }

    it('reads the checkout from the top level', async () => {
      const dir = gitFixture({ '[*]': { a: '${{ git.shortSha }}', b: '${{ git.dirty }}' } });
      const cfg = (await Repository.create(dir)).getPackage('pkg-a')!.config as Record<string, unknown>;
      expect(cfg.a).toMatch(/^[0-9a-f]{7}$/);
      expect(cfg.b).toBe(false);
    });

    it('is no longer reachable as repository.git', async () => {
      const dir = gitFixture({ '[*]': { a: '${{ repository.git }}' } });
      /** A nullish result standing alone is "unset", so the move shows up as `undefined` here
       *  rather than an error - which is why the positive case above is the one that matters. */
      expect((await Repository.create(dir)).getPackage('pkg-a')!.config.a).toBeUndefined();
    });

    /**
     * **The cost of moving it up, and the reason `interpolateConfig` builds its context from
     * property descriptors instead of `{ ...scope }`.** A spread reads every property, so a lazy
     * getter one level down (where `git` used to live) is untouched by it, while one at the top
     * level is not: measured, the spread version ran `git rev-parse` on a repository whose config
     * never mentions git.
     */
    it('shells out only when an expression asks, and then once for the whole repository', async () => {
      const proto = Repository.prototype as unknown as Record<string, (dir: string) => unknown>;
      const original = proto._readGitScope;
      let calls = 0;
      proto._readGitScope = function (this: unknown, dirname: string) {
        calls++;
        return original.call(this, dirname);
      };
      try {
        const quiet = gitFixture({ '[*]': { a: 'nothing about git' } }, ['pkg-a', 'pkg-b']);
        await Repository.create(quiet);
        expect(calls).toBe(0);

        /** Once, not once per package - the cache is on the `Repository`, and `configScope` is
         *  called per package. */
        const asking = gitFixture({ '[*]': { a: '${{ git.sha }}' } }, ['pkg-a', 'pkg-b']);
        await Repository.create(asking);
        expect(calls).toBe(1);
      } finally {
        proto._readGitScope = original;
      }
    });

    it('reports every field as undefined outside a checkout, which is a state and not an error', async () => {
      const dir = tmp();
      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });
      fs.writeFileSync(
        path.join(dir, '.rmanrc'),
        JSON.stringify({ '[*]': { a: "${{ git.branch ?? 'no-git' }}", b: '${{ git.sha }}' } }),
      );
      writeJson(dir, 'packages/pkg-a/package.json', { name: 'pkg-a', version: '1.0.0' });

      const cfg = (await Repository.create(dir)).getPackage('pkg-a')!.config as Record<string, unknown>;
      expect(cfg.a).toBe('no-git');
      expect(cfg.b).toBeUndefined();
    });
  });

  describe('listStatus()', () => {
    let dir: string;
    let originDir: string;
    let repo: Repository;
    let baseHash: string;

    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString().trim();

    before(async () => {
      dir = tmp();
      originDir = tmp();
      fs.rmSync(originDir, { recursive: true, force: true });
      execFileSync('git', ['init', '-q', '--bare', originDir]);

      writeJson(dir, 'package.json', { name: 'root', private: true, workspaces: ['packages/*'] });

      /** Marks the repository root: `Workspace.findRoot` looks for an `.rmanrc*` or a `.git`,

       *  since it runs before the plugins that would know what a package is. */

      fs.writeFileSync(path.join(dir, '.rmanrc'), '{}');
      writeJson(dir, 'packages/untouched/package.json', { name: 'untouched', version: '1.0.0' });
      writeJson(dir, 'packages/committed/package.json', { name: 'committed', version: '1.0.0' });
      writeJson(dir, 'packages/dirty/package.json', { name: 'dirty', version: '1.0.0' });

      git('init', '-q');
      git('config', 'user.email', 't@t.com');
      git('config', 'user.name', 't');
      git('add', '-A');
      git('commit', '-q', '-m', 'init');
      baseHash = git('rev-parse', 'HEAD');

      git('remote', 'add', 'origin', originDir);
      git('branch', '-M', 'main');
      git('push', '-u', 'origin', 'main', '-q');

      fs.writeFileSync(path.join(dir, 'packages/committed/file.txt'), 'v2');
      git('add', '-A');
      git('commit', '-q', '-m', 'change committed pkg');

      fs.writeFileSync(path.join(dir, 'packages/dirty/file.txt'), 'uncommitted');

      repo = await Repository.create(dir);
    });

    it('reports dirty/committed/clean relative to upstream when no hash is given', async () => {
      const status = await repo.listStatus();
      expect(status.dirty).toBe('dirty');
      expect(status.committed).toBe('committed');
      expect(status.untouched).toBe('clean');
    });

    it('dirty always takes priority over committed', async () => {
      // the "committed" package has no working-tree changes, so it should never show as dirty.
      const status = await repo.listStatus();
      expect(status.committed).not.toBe('dirty');
    });

    it('with a hash, resolves to changed/clean instead of dirty/committed - except dirty still wins', async () => {
      const status = await repo.listStatus({ hash: baseHash });
      expect(status.committed).toBe('changed');
      expect(status.untouched).toBe('clean');
      expect(status.dirty).toBe('dirty');
    });
  });
});
