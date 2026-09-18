import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'expect';
import { resolveBesideRman, resolveConfigTarget } from '../../src/core/resolve-target.js';

/** `realpath` because macOS's `/var` is a symlink to `/private/var`, and Node's resolver returns
 *  the real path - so a raw `mkdtemp` result never equals what `resolveConfigTarget` hands back. */
const require = createRequire(import.meta.url);

function mkTmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rman-resolve-target-')));
}

function write(dir: string, rel: string, content: string): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A package a `plugins` or `extends` entry could name, written into `dir/node_modules`. */
function installPackage(modulesDir: string, name: string, marker: string): void {
  write(modulesDir, `${name}/package.json`, JSON.stringify({ name, version: '1.0.0', main: './index.js' }));
  write(modulesDir, `${name}/index.js`, `module.exports = ${JSON.stringify(marker)};\n`);
}

describe('core/resolveConfigTarget', () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = mkTmp();
    dirs.push(d);
    return d;
  }

  it("resolves a bare name through the config file's own node_modules", () => {
    const dir = tmp();
    installPackage(path.join(dir, 'node_modules'), 'some-plugin', 'from-the-repository');
    const resolved = resolveConfigTarget('some-plugin', path.join(dir, '.rmanrc'), 'plugins');
    expect(resolved).toBe(path.join(dir, 'node_modules/some-plugin/index.js'));
  });

  it('resolves a path-like target against the config file, trying the config extensions', () => {
    const dir = tmp();
    write(dir, 'shared/base.yml', 'group: true\n');
    expect(resolveConfigTarget('./shared/base', path.join(dir, '.rmanrc'), 'extends')).toBe(
      path.join(dir, 'shared/base.yml'),
    );
  });

  it('names the config key and the file when nothing resolves', () => {
    const dir = tmp();
    expect(() => resolveConfigTarget('nowhere-at-all', path.join(dir, '.rmanrc'), 'plugins')).toThrow(
      /"plugins" target "nowhere-at-all" could not be resolved from .*\.rmanrc/,
    );
  });

  /**
   * **The bootstrap case.** `rman ci` exists to create `node_modules`, and `ci` is `rman-node`'s
   * command - so on a fresh clone the plugin cannot be found in the directory the command was going
   * to make. A globally installed rman's siblings *are* the globally installed packages, which is
   * what makes this work.
   *
   * `resolveBesideRman` takes the module URL to resolve from, and that parameter is the test seam:
   * the answer depends on where rman's own module sits, so a spec running inside this repository
   * could otherwise only prove that this repository can see its own `node_modules`.
   */
  describe('falling back to what is installed beside rman', () => {
    /** `<root>/node_modules/{rman,a-plugin}`, and the URL of a file inside that `rman`. */
    function siblingLayout(): string {
      const root = tmp();
      const modules = path.join(root, 'node_modules');
      write(modules, 'rman/package.json', JSON.stringify({ name: 'rman', version: '1.0.0' }));
      write(modules, 'rman/core/resolve-target.js', '');
      installPackage(modules, 'a-plugin', 'beside-rman');
      return pathToFileURL(path.join(modules, 'rman/core/resolve-target.js')).href;
    }

    it('finds a plugin installed beside rman', () => {
      const found = resolveBesideRman('a-plugin', siblingLayout());
      expect(found).toBeDefined();
      expect(require(found!)).toBe('beside-rman');
    });

    it('answers undefined rather than throwing when there is nothing beside it either', () => {
      expect(resolveBesideRman('nothing-anywhere', siblingLayout())).toBeUndefined();
    });

    /**
     * **A fallback, never a search order.** `createRequire` is based on the config file precisely so
     * a repository's config resolves against the repository; a copy there has to win, or a global
     * install could silently override a pinned one. `resolveConfigTarget` is what orders the two,
     * so this goes through it rather than through the fallback alone.
     */
    it('is not reached at all when the repository has its own copy', () => {
      const repo = tmp();
      installPackage(path.join(repo, 'node_modules'), 'a-plugin', 'in-the-repository');
      const resolved = resolveConfigTarget('a-plugin', path.join(repo, '.rmanrc'), 'plugins');
      expect(require(resolved)).toBe('in-the-repository');
    });
  });
});
