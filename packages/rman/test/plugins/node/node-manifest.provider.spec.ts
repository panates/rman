import { expect } from 'expect';
import { NodeManifestProvider } from '../../../src/builtins/platforms/node/node-manifest.provider.js';
import type { Package } from '../../../src/core/classes/package.js';
import type { Manifest } from '../../../src/core/interfaces/manifest.js';

const provider = new NodeManifestProvider();

/** Only `name` is read, so a bare object stands in for a `Package` - building real ones would need
 *  a repository, an application and four directories to say nothing more than this. */
const candidates = ['pkg-a', 'pkg-b', 'pkg-c'].map(name => ({ name }) as Package);

function manifest(raw: Record<string, unknown>): Manifest {
  return { name: 'pkg-under-test', version: '1.0.0', private: false, raw: raw as any };
}

const edgesOf = (raw: Record<string, unknown>): string[] =>
  provider.dependencies(manifest(raw), candidates).map(p => p.name);

/**
 * Which declarations in a `package.json` are edges in rman's graph - the answer `run`'s ordering,
 * `publish`'s ordering and `version`'s cascade are all built on.
 */
describe('builtins/platforms/node/NodeManifestProvider.dependencies', () => {
  it('reads all four dependency fields, and only names belonging to the repository', () => {
    expect(
      edgesOf({
        dependencies: { 'pkg-a': '1.0.0', lodash: '^4.0.0' },
        devDependencies: { 'pkg-b': '1.0.0' },
        peerDependencies: { 'pkg-c': '1.0.0' },
      }),
    ).toEqual(['pkg-a', 'pkg-b', 'pkg-c']);
  });

  /**
   * An optional peer is one the package works without, so it states no order - and left in, it
   * invents cycles out of pairs that merely know about each other.
   */
  it('leaves out a peer marked optional in peerDependenciesMeta', () => {
    expect(
      edgesOf({
        peerDependencies: { 'pkg-a': '1.0.0', 'pkg-b': '1.0.0' },
        peerDependenciesMeta: { 'pkg-a': { optional: true } },
      }),
    ).toEqual(['pkg-b']);
  });

  /**
   * **The half that stops this being a one-line rule, and the half `panates/opra` turned on.** All
   * seven of that repository's optional peers are `devDependencies` too, so reading the peer block
   * alone removed no edge at all - and the cycle destroying its build order survived a change that
   * looked like the fix for it.
   */
  it('keeps an optional peer that another field declares as well', () => {
    expect(
      edgesOf({
        devDependencies: { 'pkg-a': '1.0.0' },
        peerDependencies: { 'pkg-a': '1.0.0' },
        peerDependenciesMeta: { 'pkg-a': { optional: true } },
      }),
    ).toEqual(['pkg-a']);
  });

  /** `optionalDependencies` is a different statement: the package means to use it and the install
   *  may fail, where an optional *peer* says it works without it. Not read as optional here. */
  it('treats an optionalDependencies entry as an ordinary edge', () => {
    expect(edgesOf({ optionalDependencies: { 'pkg-a': '1.0.0' } })).toEqual(['pkg-a']);
  });

  it('ignores a meta entry that does not say optional, and one for a package that is not a peer', () => {
    expect(
      edgesOf({
        peerDependencies: { 'pkg-a': '1.0.0' },
        peerDependenciesMeta: { 'pkg-a': {}, 'pkg-b': { optional: true } },
      }),
    ).toEqual(['pkg-a']);
  });
});
