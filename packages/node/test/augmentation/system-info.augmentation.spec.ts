import { expect } from 'expect';
import { type Repository, SystemInfo } from 'rman';
import { augmentSystemInfo } from '../../src/augmentation/system-info.augmentation.js';
import { useNodeEcosystem } from '../_fixture.js';

/**
 * The augmentation wraps a core service in place, so these run against the real `SystemInfo` and
 * would leak into every later test in the process - `getSystemInfo` is restored afterwards.
 * `envinfo` itself is never called: what is under test is which options reach it.
 *
 * Each test re-stubs and re-augments, which only works because idempotency is marked on the
 * function rather than held in a module flag - with a flag, whether the wrapper got installed here
 * would depend on whether some earlier test had already imported the plugin.
 */
describe('augmentation/system-info', () => {
  useNodeEcosystem();

  /**
   * Captured when the **first test starts**, not when this module loads.
   *
   * At module load, whether `getSystemInfo` is already augmented depends on whether the plugin's
   * entry point happened to be imported first - which is a function of file order, and therefore of
   * `--parallel`. Restoring a module-scope capture put the *un-augmented* core function back for
   * the rest of the process, and `commands/info` two files later reported `Binaries: [Node]` with
   * no npm (measured serially; the parallel run never saw it, because each worker loads its own
   * files).
   */
  let original: SystemInfo.GetSystemInfo | undefined;
  let seen: SystemInfo.Options | undefined;

  beforeEach(() => {
    original ??= SystemInfo.getSystemInfo;
    seen = undefined;
    // Stand in for the core implementation, then augment *that* - so the assertions are about what
    // the wrapper passes down rather than about envinfo's output.
    (SystemInfo as { getSystemInfo: SystemInfo.GetSystemInfo }).getSystemInfo = async options => {
      seen = options;
      return {};
    };
    augmentSystemInfo();
  });

  after(() => {
    if (original) (SystemInfo as { getSystemInfo: SystemInfo.GetSystemInfo }).getSystemInfo = original;
  });

  it('makes npm the default, so a Node repository needs no configuration to be reported', async () => {
    await SystemInfo.getSystemInfo();
    expect(seen?.envinfo?.Binaries).toEqual(['Node', 'npm']);
    expect(seen?.envinfo?.npmGlobalPackages).toEqual(['typescript']);
  });

  it("adds the type to rman's own namespace, so the union has one home", () => {
    // `SystemInfo.PackageManager` exists only because this package declares it - and it is
    // `CiService.PackageManager`, not a second copy of the same four names.
    const pm: SystemInfo.PackageManager = 'yarn';
    expect(pm).toBe('yarn');
  });

  it('takes the package manager from the repository config when no argument names one', async () => {
    // The core `info` command passes only `{ repository }` - it cannot name a package manager, so
    // without this step a pnpm repository would silently be reported as an npm one.
    const repository = { config: { packageManager: 'pnpm' } } as unknown as Repository;
    await SystemInfo.getSystemInfo({ repository });
    expect(seen?.envinfo?.Binaries).toEqual(['Node', 'pnpm']);
  });

  it('prefers an explicit argument over the config', async () => {
    const repository = { config: { packageManager: 'pnpm' } } as unknown as Repository;
    await SystemInfo.getSystemInfo({ repository, packageManager: 'bun' });
    expect(seen?.envinfo?.Binaries).toEqual(['Node', 'bun']);
  });

  it('ignores an unrecognized config value rather than reporting an undefined binary', async () => {
    // A config value is whatever the file said; indexing the binary map with it would produce
    // `Binaries: ['Node', undefined]`.
    const repository = { config: { packageManager: 'rush' } } as unknown as Repository;
    await SystemInfo.getSystemInfo({ repository });
    expect(seen?.envinfo?.Binaries).toEqual(['Node', 'npm']);
  });

  it("reports this package's own version alongside rman's", async () => {
    await SystemInfo.getSystemInfo();
    expect(seen?.envinfo?.npmPackages).toEqual(['rman', 'rman-node', 'typescript']);
  });

  it('lets a caller override the categories it adds', async () => {
    await SystemInfo.getSystemInfo({ envinfo: { npmPackages: ['just-this'] } });
    expect(seen?.envinfo?.npmPackages).toEqual(['just-this']);
  });

  it('is idempotent - applying it twice does not wrap the wrapper', async () => {
    // A consumer importing the augmentation directly would otherwise stack layers, each adding
    // another `npmPackages` list on the way down.
    augmentSystemInfo();
    augmentSystemInfo();
    await SystemInfo.getSystemInfo();
    expect(seen?.envinfo?.npmPackages).toEqual(['rman', 'rman-node', 'typescript']);
  });
});
