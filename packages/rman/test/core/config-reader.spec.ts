import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { ConfigReader } from '../../src/core/config/config-reader.js';
import { ORIGINS } from '../../src/core/config/merge-config.js';
import { definePlatform, definePlugin, type Plugin } from '../../src/core/interfaces/plugin.js';

/**
 * **Self-contained: no repository, no application, no fixture ecosystem.** `ConfigReader` answers
 * what the files say, which needs nothing but a directory - and a spec that had to build a
 * repository first could not tell a reading mistake from a discovery one.
 */
describe('core/ConfigReader', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-config-reader-'));
    dirs.push(d);
    return d;
  }

  function reader(): ConfigReader {
    return new ConfigReader();
  }

  /** A platform that claims a directory by one file name, so a spec can say which directories a
   *  technology recognizes without bringing an ecosystem along. */
  function platformClaiming(name: string, fileName: string) {
    return definePlatform({
      name,
      manifestProvider: {
        name,
        fileName,
        read: (dir: string) =>
          fs.existsSync(path.join(dir, fileName))
            ? { name: 'x', version: '0.0.0', private: false, raw: {} }
            : undefined,
        write: () => undefined,
      },
    });
  }

  /** A plugin, which is now a name and whatever it does at a stage - it carries no technology, so
   *  a case about *loading* one needs nothing more than this. A case about which technology claims
   *  a directory hands a `Platform` instead, through `platforms`. */
  function barePlugin(name: string): Plugin {
    return definePlugin({ name });
  }

  /** The file recorded for `key`, which is what an error message names. */
  function originOf(cfg: object, key: string): string | undefined {
    return (cfg as Record<symbol, Record<string, string>>)[ORIGINS]?.[key];
  }

  /** Static, because parsing a `"[...]"` key is about the `.rmanrc` format rather than about any
   *  one read - it needs no directory, no plugins and no instance. */
  describe('selector keys', () => {
    it('tells a selector key from a setting', () => {
      expect(ConfigReader.isSelectorKey('[*]')).toBe(true);
      expect(ConfigReader.isSelectorKey('[/]')).toBe(true);
      expect(ConfigReader.isSelectorKey('[pkg-a]')).toBe(true);
      expect(ConfigReader.isSelectorKey('logLevel')).toBe(false);
      // `"[]"` names nothing, so it is a key like any other.
      expect(ConfigReader.isSelectorKey('[]')).toBe(false);
    });

    /** The root is matched by *being* the root, never by name - which is what keeps `"[my-*]"` from
     *  picking up a repository whose root package is called `my-repo`. */
    it('reads "[/]" as the root, structurally', () => {
      const parsed = ConfigReader.parseSelector('[/]');
      expect(parsed.scope).toBe('root');
      expect(parsed.test('anything')).toBe(true);
    });

    it('anchors a glob at both ends', () => {
      const { scope, test } = ConfigReader.parseSelector('[*-dialect]');
      expect(scope).toBe('package');
      expect(test('mysql-dialect')).toBe(true);
      expect(test('my-dialect-helper')).toBe(false);
    });

    it('matches an exact name', () => {
      const { test } = ConfigReader.parseSelector('[pkg-a]');
      expect(test('pkg-a')).toBe(true);
      expect(test('pkg-ab')).toBe(false);
    });

    it('treats a regex metacharacter as a literal', () => {
      const { test } = ConfigReader.parseSelector('[a.b]');
      expect(test('a.b')).toBe(true);
      expect(test('axb')).toBe(false);
    });

    it('reads "[platform:node]" as a technology', () => {
      const { scope, test } = ConfigReader.parseSelector('[platform:node]');
      expect(scope).toBe('platform');
      expect(test('node')).toBe(true);
      expect(test('cargo')).toBe(false);
    });

    it('takes a list, and trims it', () => {
      const { test } = ConfigReader.parseSelector('[platform: node , cargo ]');
      expect(test('node')).toBe(true);
      expect(test('cargo')).toBe(true);
      expect(test('maven')).toBe(false);
    });

    /** A package no technology claimed carries `basePlatform`, whose name is `''` - it belongs to no
     *  platform block rather than to every one with an empty entry. */
    it('matches no platform for a package nothing claimed', () => {
      expect(ConfigReader.parseSelector('[platform:node]').test('')).toBe(false);
      expect(ConfigReader.parseSelector('[platform:,node]').test('')).toBe(false);
    });

    /** A platform name is a name, not a glob - `platformFor` matches it exactly. */
    it('does not treat a platform name as a glob', () => {
      const { test } = ConfigReader.parseSelector('[platform:node]');
      expect(test('node-next')).toBe(false);
    });

    /** The qualifier said "not the root" back when a bare glob included it; the shape of the set
     *  says that now, so both spellings resolve to the same packages. */
    it('accepts the retired ws:/workspace: qualifier as plain "[*]"', () => {
      for (const key of ['[*]', '[ws:*]', '[workspace:*]']) {
        const { scope, test } = ConfigReader.parseSelector(key);
        expect(scope).toBe('package');
        expect(test('pkg-a')).toBe(true);
      }
    });
  });

  describe('one directory, one config', () => {
    it('returns {} for a directory declaring none', async () => {
      expect((await reader().resolve(tmp())).config).toEqual({});
    });

    it('reads .rmanrc as JSON', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ packageManager: 'pnpm' }));
      expect((await reader().resolve(dir)).config).toEqual({ packageManager: 'pnpm' });
    });

    it('reads .rmanrc.yml as YAML', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc.yml'), 'packageManager: yarn\n');
      expect((await reader().resolve(dir)).config).toEqual({ packageManager: 'yarn' });
    });

    it('reads a JS module form', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc.cjs'), 'module.exports = { packageManager: "npm" };');
      expect((await reader().resolve(dir)).config).toEqual({ packageManager: 'npm' });
    });

    it('reads package.json#rman', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', rman: { packageManager: 'npm' } }));
      expect((await reader().resolve(dir)).config).toEqual({ packageManager: 'npm' });
    });

    /** Every Node package has a `package.json`; only the `rman` key makes it a config source. */
    it('does not count a package.json without an "rman" key', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
      fs.writeFileSync(path.join(dir, '.rmanrc.yml'), 'packageManager: yarn\n');
      expect((await reader().resolve(dir)).config).toEqual({ packageManager: 'yarn' });
    });

    /**
     * **The reason this reads the directory rather than probing the names in a fixed order.** A
     * probe cannot tell "this one" from "this one, and three others I am quietly folding in
     * underneath", and what the old merge produced when two existed was a config in neither file.
     */
    it('refuses two file forms, naming both', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ packageManager: 'npm' }));
      fs.writeFileSync(path.join(dir, '.rmanrc.yml'), 'packageManager: yarn\n');
      await expect(reader().resolve(dir)).rejects.toThrow(/declares 2 rman configs - \.rmanrc, \.rmanrc\.yml/);
    });

    it('refuses a file form beside package.json#rman', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', rman: { packageManager: 'npm' } }));
      fs.writeFileSync(path.join(dir, '.rmanrc.yml'), 'packageManager: yarn\n');
      await expect(reader().resolve(dir)).rejects.toThrow(/\.rmanrc\.yml, package\.json \("rman"\)/);
    });

    it('refuses a config file that does not hold an object', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc'), '["a"]');
      await expect(reader().resolve(dir)).rejects.toThrow(/does not hold an rman config object/);
    });

    it('refuses "extends" inside a selector block', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[*]': { extends: './base.yml' } }));
      await expect(reader().resolve(dir)).rejects.toThrow(/cannot use "extends"/);
    });

    /** A glob matches a package's selector, and `platform`/`name` are what the selector is derived
     *  from - so a block setting either could never be matched in order to apply it. */
    it('refuses "platform" inside a glob block, and allows it under "[/]"', async () => {
      const a = tmp();
      fs.writeFileSync(path.join(a, '.rmanrc'), JSON.stringify({ '[*]': { platform: 'node' } }));
      await expect(reader().resolve(a)).rejects.toThrow(/cannot set "platform"/);

      const b = tmp();
      fs.writeFileSync(path.join(b, '.rmanrc'), JSON.stringify({ '[/]': { platform: 'node' } }));
      await expect(reader().resolve(b)).resolves.toBeDefined();
    });
  });

  describe('extends: the base first, the file on top', () => {
    /** A directory whose config extends `base.yml` one level up. */
    function withBase(base: string, own: Record<string, unknown>): string {
      const root = tmp();
      const dir = path.join(root, 'repo');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(root, 'base.yml'), base);
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ extends: '../base.yml', ...own }));
      return dir;
    }

    it("keeps the base's keys and lets the file's own win", async () => {
      const dir = withBase('packageManager: npm\nlogLevel: info\n', { packageManager: 'pnpm' });
      expect((await reader().resolve(dir)).config).toEqual({ packageManager: 'pnpm', logLevel: 'info' });
    });

    it('leaves no "extends" in the result', async () => {
      const dir = withBase('logLevel: info\n', {});
      expect('extends' in (await reader().resolve(dir)).config).toBe(false);
    });

    /**
     * **The ordering fix.** Reading the file first and merging its own keys onto the resolved base
     * **with that file as the origin** is what keeps an error pointing at the right file. Building
     * the merged object first and handing it to a resolver that spreads its argument dropped the
     * non-enumerable top-level `ORIGINS`, so an overwritten key kept *the base's* file.
     */
    it('attributes an overwritten top-level key to the file that overwrote it', async () => {
      const dir = withBase('packageManager: npm\n', { packageManager: 'pnpm' });
      expect(originOf((await reader().resolve(dir)).config, 'packageManager')).toBe(path.join(dir, '.rmanrc'));
    });

    /**
     * **How a preset stays inert until a repository names it.** `presets/node` runs
     * `augmentSystemInfo()` before handing its config over, and that mutates the core's own
     * `SystemInfo` in place - at import time it would have `rman info` report npm's tooling in a
     * Cargo repository that never named the preset.
     */
    it('calls a factory a config module exports', async () => {
      const root = tmp();
      const dir = path.join(root, 'repo');
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(root, 'preset.mjs'),
        `export let calls = 0;\nexport default () => { calls++; return { logLevel: 'verbose' }; };\n`,
      );
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ extends: '../preset.mjs' }));
      expect((await reader().resolve(dir)).config.logLevel).toBe('verbose');
    });

    it('refuses a factory that does not return a config object', async () => {
      const root = tmp();
      const dir = path.join(root, 'repo');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(root, 'preset.mjs'), `export default () => 42;\n`);
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ extends: '../preset.mjs' }));
      await expect(reader().resolve(dir)).rejects.toThrow(/does not hold an rman config object/);
    });

    /**
     * **A preset is an ordinary config that ships with rman**, reached the same way any other is.
     * `extends: "rman:node"` contributes the technology, the two commands that are npm's alone, and
     * the npm publish target.
     */
    it("resolves one of rman's own presets", async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc.yml'), `extends: 'rman:node'\n`);
      const { config, platforms } = await reader().resolve(dir);
      expect(platforms.map(p => p.name)).toEqual(['node']);
      expect(Array.isArray(config.commands)).toBe(true);
      expect(Array.isArray(config.publishTargets)).toBe(true);
    });

    /** A prefixed namespace is closed: nothing rman adds later can shadow a package a repository
     *  already names. */
    it('names the presets it ships when the name is not one', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc.yml'), `extends: 'rman:nope'\n`);
      await expect(reader().resolve(dir)).rejects.toThrow(/has no preset "nope". rman ships: node/);
    });

    it('refuses a preset name that is not a name', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc.yml'), `extends: 'rman:../escape'\n`);
      await expect(reader().resolve(dir)).rejects.toThrow(/is not a name/);
    });

    it('reports a cycle rather than recursing', async () => {
      const root = tmp();
      fs.writeFileSync(path.join(root, 'a.yml'), 'extends: "./b.yml"\n');
      fs.writeFileSync(path.join(root, 'b.yml'), 'extends: "./a.yml"\n');
      fs.writeFileSync(path.join(root, '.rmanrc'), JSON.stringify({ extends: './a.yml' }));
      await expect(reader().resolve(root)).rejects.toThrow(/forms a cycle/);
    });

    it('refuses an extends target that resolves to nothing', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ extends: './nowhere' }));
      await expect(reader().resolve(dir)).rejects.toThrow(/was not found/);
    });
  });

  describe('loading platforms', () => {
    it('carries an instance written into the config through to the result', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc.cjs'), 'module.exports = {};');
      const cargo = platformClaiming('cargo', 'Cargo.toml');
      const { platforms } = await reader().resolve(dir, { plugins: [], platforms: [cargo] });
      expect(platforms).toEqual([cargo]);
    });

    it('takes a platform written straight into the key', async () => {
      const dir = tmp();
      fs.writeFileSync(
        path.join(dir, 'p.mjs'),
        `import { definePlatform } from ${JSON.stringify(pluginModuleUrl())};\n` +
          `export default definePlatform({ name: 'cargo', manifestProvider: ` +
          `{ name: 'cargo', fileName: 'Cargo.toml', read: () => undefined, write: () => undefined } });\n`,
      );
      fs.writeFileSync(path.join(dir, '.rmanrc.yml'), `platforms: './p.mjs'\n`);
      const { platforms } = await reader().resolve(dir);
      expect(platforms.map(p => p.name)).toEqual(['cargo']);
    });

    /** Two layers naming one technology is ordinary - a preset and the repository that inherits it -
     *  and the one already in play wins, so a config cannot displace what the caller brought. */
    it('skips a technology whose name is already in play', async () => {
      const dir = tmp();
      fs.writeFileSync(
        path.join(dir, 'p.mjs'),
        `import { definePlatform } from ${JSON.stringify(pluginModuleUrl())};\n` +
          `export default definePlatform({ name: 'cargo', manifestProvider: ` +
          `{ name: 'cargo', fileName: 'other.toml', read: () => undefined, write: () => undefined } });\n`,
      );
      fs.writeFileSync(path.join(dir, '.rmanrc.yml'), `platforms: './p.mjs'\n`);
      const brought = platformClaiming('cargo', 'Cargo.toml');
      const { platforms } = await reader().resolve(dir, { plugins: [], platforms: [brought] });
      expect(platforms).toHaveLength(1);
      expect(platforms[0]).toBe(brought);
    });

    /** A plugin is broader than a technology, and the two keys are separate precisely so neither
     *  has to guess which it is holding. */
    it('refuses a plugin written into "platforms"', async () => {
      const dir = tmp();
      fs.writeFileSync(
        path.join(dir, 'p.mjs'),
        `import { definePlugin } from ${JSON.stringify(pluginModuleUrl())};\n` +
          `export default definePlugin({ name: 'broad' });\n`,
      );
      fs.writeFileSync(path.join(dir, '.rmanrc.yml'), `platforms: './p.mjs'\n`);
      await expect(reader().resolve(dir)).rejects.toThrow(/is a plugin, not a platform/);
    });

    it('refuses an entry that is neither a platform nor a glob', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ platforms: [42] }));
      await expect(reader().resolve(dir)).rejects.toThrow(/"platforms" takes a platform.*got a number/s);
    });

    /** It appends like every other contribution key, so a preset's technology is not lost when the
     *  repository names one of its own. */
    it('appends across layers rather than replacing', async () => {
      const root = tmp();
      const dir = path.join(root, 'repo');
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(root, 'p.mjs'),
        `import { definePlatform } from ${JSON.stringify(pluginModuleUrl())};\n` +
          `export default definePlatform({ name: 'from-base', manifestProvider: ` +
          `{ name: 'from-base', fileName: 'b.toml', read: () => undefined, write: () => undefined } });\n`,
      );
      fs.writeFileSync(path.join(root, 'base.yml'), `platforms: './p.mjs'\n`);
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ extends: '../base.yml' }));
      const { platforms } = await reader().resolve(dir, {
        plugins: [],
        platforms: [platformClaiming('own', 'o.json')],
      });
      expect(platforms.map(p => p.name)).toEqual(['own', 'from-base']);
    });
  });

  describe('loading plugins', () => {
    it('carries an instance written into the config through to the result', async () => {
      const dir = tmp();
      const plugin = barePlugin('cargo');
      fs.writeFileSync(path.join(dir, '.rmanrc.cjs'), 'module.exports = {};');
      const { plugins } = await reader().resolve(dir, { plugins: [plugin] });
      expect(plugins.map(p => p.name)).toEqual(['cargo']);
    });

    it('loads a plugin a glob names, and keeps what was passed in', async () => {
      const dir = tmp();
      fs.mkdirSync(path.join(dir, 'p'));
      fs.writeFileSync(
        path.join(dir, 'p', 'own.mjs'),
        `import { definePlugin } from ${JSON.stringify(pluginModuleUrl())};\n` +
          `export default definePlugin({ name: 'own' });\n`,
      );
      fs.writeFileSync(path.join(dir, '.rmanrc.yml'), `plugins: './p/*.mjs'\n`);
      const { plugins } = await reader().resolve(dir, { plugins: [barePlugin('cargo')] });
      expect(plugins.map(p => p.name).sort()).toEqual(['cargo', 'own']);
    });

    /**
     * **De-duplicated by *name*, not by identity.** Two entries resolving to the same plugin is
     * ordinary rather than a mistake - a shared config and the repository that inherits it name one
     * between them - and registering it twice defines its commands twice, which yargs does not
     * survive. Identity alone would not catch it: two globs matching one file produce two distinct
     * objects.
     */
    it('de-duplicates by name across entries', async () => {
      const dir = tmp();
      fs.mkdirSync(path.join(dir, 'p'));
      fs.writeFileSync(
        path.join(dir, 'p', 'own.mjs'),
        `import { definePlugin } from ${JSON.stringify(pluginModuleUrl())};\n` +
          `export default definePlugin({ name: 'own' });\n`,
      );
      // Two different globs, one file - so two entries, and each import is its own object.
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ plugins: ['./p/*.mjs', './p/own.mjs'] }));
      const { plugins } = await reader().resolve(dir);
      expect(plugins.map(p => p.name)).toEqual(['own']);
    });

    /** The plugins the caller brought are kept as they are - `resolve` adds to that list rather
     *  than deciding it. */
    it('skips a loaded plugin whose name the caller already brought', async () => {
      const dir = tmp();
      fs.mkdirSync(path.join(dir, 'p'));
      fs.writeFileSync(
        path.join(dir, 'p', 'own.mjs'),
        `import { definePlugin } from ${JSON.stringify(pluginModuleUrl())};\n` +
          `export default definePlugin({ name: 'cargo' });\n`,
      );
      fs.writeFileSync(path.join(dir, '.rmanrc.yml'), `plugins: './p/*.mjs'\n`);
      const brought = barePlugin('cargo');
      const { plugins } = await reader().resolve(dir, { plugins: [brought] });
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toBe(brought);
    });

    /**
     * **An undeclared plugin is refused.** An rman 1.x plugin is `{ name, init }` and so is a 2.x
     * plugin that contributes nothing but an `init`, so no shape test can separate them - without
     * the brand it registers cleanly and dies inside its own `init` naming neither itself nor the
     * version it was written against.
     */
    it('refuses a plugin that was not declared', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc.cjs'), 'module.exports = { plugins: [{ name: "legacy", init() {} }] };');
      await expect(reader().resolve(dir)).rejects.toThrow(/was not declared with definePlatform\(\) or definePlugin/);
    });

    it('refuses an entry that is neither a plugin nor a glob', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ plugins: [42] }));
      await expect(reader().resolve(dir)).rejects.toThrow(/got a number/);
    });

    it('refuses a nameless object rather than skipping it', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ plugins: [{ platforms: [] }] }));
      await expect(reader().resolve(dir)).rejects.toThrow(/an object with no "name"/);
    });

    it('refuses null with a message rather than a TypeError', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ plugins: [null] }));
      await expect(reader().resolve(dir)).rejects.toThrow(/got null/);
    });

    /** A package name is not one of the forms: that package exports a *config*, whose way into a
     *  repository is `extends`. */
    it('tells a package name to use extends', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc.yml'), `plugins: 'rman-node'\n`);
      await expect(reader().resolve(dir)).rejects.toThrow(/Write `extends: "rman-node"` instead/);
    });

    it('refuses a glob that matches no file', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.rmanrc.yml'), `plugins: './nothing/*.js'\n`);
      await expect(reader().resolve(dir)).rejects.toThrow(/matched no file/);
    });
  });

  describe('deciding the platform', () => {
    it('leaves a declared platform alone', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'Cargo.toml'), '');
      fs.writeFileSync(path.join(dir, '.rmanrc.yml'), `platform: 'declared'\n`);
      const { config } = await reader().resolve(dir, { platforms: [platformClaiming('cargo', 'Cargo.toml')] });
      expect(config.platform).toBe('declared');
    });

    /** `"[/]"` is the root speaking too, so a platform written there counts as declared and
     *  detection does not run over it. */
    it('counts a platform declared under "[/]" as declared', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'Cargo.toml'), '');
      fs.writeFileSync(path.join(dir, '.rmanrc'), JSON.stringify({ '[/]': { platform: 'declared' } }));
      const { config } = await reader().resolve(dir, { platforms: [platformClaiming('cargo', 'Cargo.toml')] });
      expect(config.platform).toBeUndefined();
    });

    it('asks the loaded plugins which one recognizes the directory', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'Cargo.toml'), '');
      const { config } = await reader().resolve(dir, {
        platforms: [platformClaiming('node', 'package.json'), platformClaiming('cargo', 'Cargo.toml')],
      });
      expect(config.platform).toBe('cargo');
    });

    /** First match in declaration order - the same rule `Manifest.read` and `Workspace.resolve`
     *  follow, so the answer here cannot disagree with the one after the plugins are registered. */
    it('takes the first plugin that recognizes it, in declaration order', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'both.toml'), '');
      const { config } = await reader().resolve(dir, {
        platforms: [platformClaiming('first', 'both.toml'), platformClaiming('second', 'both.toml')],
      });
      expect(config.platform).toBe('first');
    });

    /** The control for the loop: a plugin that does not recognize the directory must not stop the
     *  search, and must not overwrite what a later one found. */
    it('keeps looking past a plugin that does not recognize it', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'Cargo.toml'), '');
      const { config } = await reader().resolve(dir, {
        platforms: [platformClaiming('node', 'package.json'), platformClaiming('cargo', 'Cargo.toml')],
      });
      expect(config.platform).toBe('cargo');
    });

    it('takes the platform name, not the plugin name, when a plugin provides several', async () => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, 'build.gradle'), '');
      const { config } = await reader().resolve(dir, {
        platforms: [platformClaiming('maven', 'pom.xml'), platformClaiming('gradle', 'build.gradle')],
      });
      expect(config.platform).toBe('gradle');
    });

    it('leaves the platform unset when nothing recognizes the directory', async () => {
      const dir = tmp();
      const { config } = await reader().resolve(dir, { platforms: [platformClaiming('cargo', 'Cargo.toml')] });
      expect(config.platform).toBeUndefined();
    });
  });
});

/** The `rman` source a fixture module imports `definePlugin` from - the spec tree resolves `rman`
 *  through `tsconfig-test.json`'s `paths`, but a file written to a temp directory and imported by
 *  the loader under test cannot, so it names the source file outright. */
function pluginModuleUrl(): string {
  return new URL('../../src/core/interfaces/plugin.ts', import.meta.url).href;
}
