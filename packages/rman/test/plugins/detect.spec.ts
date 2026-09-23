import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from 'expect';
import { readDirConfig } from '../../src/core/config.js';
import { clearDetectionCache, detectBuiltin, detectedBuiltinOf } from '../../src/plugins/detect.js';
import { createRepository, useTestEcosystem } from '../_fixture.js';

/**
 * **A repository that says nothing gets the technology its own files imply.**
 *
 * This is the other half of folding the node plugin into rman: shipping it in the box removes the
 * second install, and this removes the config file. Measured before either: a repository with a
 * `package.json` full of `workspaces` reported itself as one package called after its directory at
 * `0.0.0`, and `rman clean` was `Unknown argument`.
 *
 * The boundary is what keeps it safe, so it is what these pin. Registering a technology decides
 * **which directories are packages at all**, so detecting on top of an explicit statement could
 * quietly change what `rman list` reports - and `plugins: []` has to be a statement, or a repository
 * meaning "none" would have no way to say it.
 */
describe('plugins/detect', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function tmp(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rman-detect-test-'));
    dirs.push(dir);
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    /** The signal is read from disk and memoized per directory, so a fixture written after an
     *  earlier one was asked about must not see the earlier answer. */
    clearDetectionCache();
    return dir;
  }

  describe('detectBuiltin()', () => {
    it('reads a package.json as the node built-in, and says which file gave it away', () => {
      const dir = tmp({ 'package.json': '{"name":"x"}' });
      expect(detectBuiltin(dir)).toEqual({ name: 'node', because: 'package.json' });
    });

    it('answers nothing for a directory it cannot place, rather than guessing a default', () => {
      const dir = tmp({ 'Cargo.toml': '[package]\nname = "x"\n' });
      expect(detectBuiltin(dir)).toBeUndefined();
    });
  });

  describe('readDirConfig({ inject })', () => {
    it('gives an undeclared repository the built-in its files imply', async () => {
      const dir = tmp({ 'package.json': '{"name":"x"}' });
      const config = await readDirConfig(dir, { inject: detectBuiltin(dir) });
      /** Expanded, not left as the name: what a built-in contributes is a whole config. */
      expect(config.commands).toBeDefined();
      expect(config.publishTargets).toBeDefined();
      expect(detectedBuiltinOf(config)?.name).toBe('node');
    });

    /**
     * **The control that matters most.** Detection must not reach a repository that stated
     * something, because a technology decides which directories hold packages - so guessing over an
     * answer could change what `list` finds.
     */
    it('leaves a repository that declared its technology alone', async () => {
      const dir = tmp({ 'package.json': '{"name":"x"}', '.rmanrc': '{"plugins":["node"]}' });
      const config = await readDirConfig(dir, { inject: detectBuiltin(dir) });
      expect(detectedBuiltinOf(config)).toBeUndefined();
    });

    /** `plugins: []` is a repository saying **none**, and has to be heard as one - it is the only
     *  way to opt out of a guess that is wrong. */
    it('treats an empty plugins list as a statement, not as silence', async () => {
      const dir = tmp({ 'package.json': '{"name":"x"}', '.rmanrc': '{"plugins":[]}' });
      const config = await readDirConfig(dir, { inject: detectBuiltin(dir) });
      expect(detectedBuiltinOf(config)).toBeUndefined();
      expect(config.commands).toBeUndefined();
    });

    /** Only the repository root is asked - `plugins` is read nowhere else, and a package directory
     *  holding a `package.json` is every package in a Node repository. */
    it('detects nothing when the caller did not ask', async () => {
      const dir = tmp({ 'package.json': '{"name":"x"}' });
      const config = await readDirConfig(dir);
      expect(detectedBuiltinOf(config)).toBeUndefined();
      expect(config.commands).toBeUndefined();
    });

    /**
     * **Survives the expansion, which it did not at first.** `expandBuiltinPlugins` merges the
     * built-in's config underneath and returns a *new* object, so the mark set on the way in was
     * gone on the way out - detection worked and the "detected" line never printed. The same trap
     * `ORIGINS` and `PREVIOUS_VALUES` document from the other side.
     */
    it('carries the mark through the expansion that rebuilds the config', async () => {
      const dir = tmp({ 'package.json': '{"name":"x"}' });
      const config = await readDirConfig(dir, { inject: detectBuiltin(dir) });
      expect(detectedBuiltinOf(config)).toEqual({ name: 'node', because: 'package.json' });
    });

    /** Invisible to everything that walks a config - the reason it is a symbol rather than a key. */
    it('marks with a symbol, so no reader of the config can see it', async () => {
      const dir = tmp({ 'package.json': '{"name":"x"}' });
      const config = await readDirConfig(dir, { inject: detectBuiltin(dir) });
      expect(Object.keys(config)).not.toContain('detected');
      expect(JSON.parse(JSON.stringify({ ...config, plugins: [], commands: [], publishTargets: [] }))).toEqual({
        plugins: [],
        commands: [],
        publishTargets: [],
      });
    });
  });

  /**
   * **The condition that is easy to miss, and the one that costs the most when it is.**
   *
   * A config declaring no `plugins` is not the same as a repository having no technology: a
   * programmatic caller - and every spec in this suite - registers one straight onto the
   * application. Detecting on top of that adds a *second* technology, and the first provider that
   * recognizes a directory decides whether it holds a package at all.
   *
   * Measured with only the config condition: ten specs changed answer, seven about config cascading
   * and three about `publish`'s flags, because the node built-in arrived in repositories that had
   * already been given one.
   */
  describe('Repository.create()', () => {
    useTestEcosystem();

    it('detects nothing when the application already carries a technology', async () => {
      const dir = tmp({ 'package.json': '{"name":"root","version":"1.0.0"}', '.rmanrc': '{}' });
      const repository = await createRepository(dir);
      expect(repository.detectedBuiltin).toBeUndefined();
      /** And the config it resolved is the fixture's, with nothing a built-in would have added. */
      expect(repository.config.commands).toBeUndefined();
    });
  });
});
