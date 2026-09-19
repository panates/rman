import path from 'node:path';
import { expect } from 'expect';
import { RmanApplication } from '../../src/core/application.js';
import { baseTechStack } from '../../src/core/tech-stack.js';
import type { BinPath as BinPathTypes } from '../../src/utils/bin-path.js';
import { BinPath } from '../../src/utils/bin-path.js';

/** A technology that contributes nothing but directories - which is a real shape (a PATH
 *  contributor recognizes no package), and how a provider reaches the application now that
 *  `addProvider` is gone and a technology is declared as a whole. */
function addBinPaths(provider: BinPathTypes.Provider, name = 'test'): void {
  RmanApplication.current().techStacks.add({
    name,
    manifestProvider: baseTechStack.manifestProvider,
    binPathsProvider: provider,
  });
}

/**
 * The core's half: composing whatever the providers offer into a PATH. **No npm anywhere** - the
 * provider below is a synthetic one, which is the point: the core must not know what a local install
 * looks like. `rman-node`'s own directories are covered by its `npm-run-path.spec.ts`.
 */
describe('utils/BinPath', () => {
  it('has no provider of its own, so the inherited PATH is left exactly as it was', () => {
    const env = BinPath.env({ cwd: '/anywhere', env: { PATH: '/usr/bin', FOO: 'bar' } });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.FOO).toBe('bar');
  });

  it("prepends a provider's directories, keeping the inherited PATH at the end", () => {
    addBinPaths(cwd => [path.join(cwd, 'vendor/bin')]);
    const env = BinPath.env({ cwd: '/repo', env: { PATH: '/usr/bin', FOO: 'bar' } });
    expect(env.PATH).toBe(['/repo/vendor/bin', '/usr/bin'].join(path.delimiter));
    /** Everything else is carried through untouched - `exec` hands this straight to a child. */
    expect(env.FOO).toBe('bar');
  });

  it('uses every provider, in registration order', () => {
    addBinPaths(() => ['/first'], 'first');
    addBinPaths(() => ['/second'], 'second');
    expect(BinPath.resolve('/repo')).toEqual(['/first', '/second']);
  });

  it('ignores a repeated registration of the same technology', () => {
    const stack = {
      name: 'twice',
      manifestProvider: baseTechStack.manifestProvider,
      binPathsProvider: () => ['/once'],
    };
    RmanApplication.current().techStacks.add(stack);
    RmanApplication.current().techStacks.add(stack);
    expect(BinPath.resolve('/repo')).toEqual(['/once']);
  });

  it('resolves cwd to an absolute path before asking a provider', () => {
    let seen = '';
    addBinPaths(cwd => {
      seen = cwd;
      return [];
    });
    BinPath.resolve('.');
    expect(path.isAbsolute(seen)).toBe(true);
  });

  it('omits PATH entirely when nothing inherited one', () => {
    addBinPaths(() => ['/only']);
    const env = BinPath.env({ cwd: '/repo', env: {} });
    expect(env.PATH).toBe('/only');
  });

  describe('pathKey()', () => {
    it('is PATH off Windows', () => {
      expect(BinPath.pathKey({ env: { Path: 'x' }, platform: 'darwin' })).toBe('PATH');
    });

    /** Windows' environment is case-insensitive, so the *existing* spelling has to be reused -
     *  writing a second key leaves the child with two PATHs and the platform picking one. */
    it("reuses the environment's own spelling on Windows", () => {
      expect(BinPath.pathKey({ env: { Path: 'x' }, platform: 'win32' })).toBe('Path');
      expect(BinPath.pathKey({ env: { PATH: 'x' }, platform: 'win32' })).toBe('PATH');
      expect(BinPath.pathKey({ env: {}, platform: 'win32' })).toBe('Path');
    });
  });
});
