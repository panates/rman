import { SystemInfo as OrgSystemInfo } from 'rman';

/**
 * Adds the npm half of `SystemInfo` to rman's own types.
 *
 * The core's `Options` carries nothing language-specific on purpose, so `packageManager` is not a
 * setting it hid behind a flag - it is a setting it does not have. Declaration merging is what lets
 * this package add it as if it had always been there, `SystemInfo.PackageManager` included, without
 * the core naming npm anywhere.
 *
 * The union itself is `CiService.PackageManager`, not a second copy: `ci` and `publish` already
 * shell out to one of these, and two lists of the same four names drift the moment a fifth appears.
 */
/** The import above is aliased precisely so this block can use the real name: declaration merging
 *  keys off the module specifier, not off any local binding, so `namespace SystemInfo` here *is*
 *  rman's - and nothing shadows anything. */
/** The `SystemInfo` types this file's wrapper relies on are declared in
 *  [`rman.augmentation.ts`](rman.augmentation.ts), with the rest of this plugin's - one
 *  `declare module` block per package, or the others stop applying. */

/**
 * Turns the npm half on at runtime.
 *
 * Applied by wrapping rather than by a flag on the core service: "is this a Node repository" is not
 * a question rman's core should be able to ask, and a `nodejs: true` option there would be exactly
 * that question wearing a different hat. The wrapper translates `packageManager` into the `envinfo`
 * categories the core knows nothing about.
 */
export function augmentSystemInfo(): void {
  const base = OrgSystemInfo.getSystemInfo;
  /**
   * Idempotent, and marked on **the function** rather than in a module-level flag: the flag made
   * re-application impossible once anything had replaced `getSystemInfo` - a test substituting a
   * stub, or a second augmentation layering on - so whether the wrapper was actually installed came
   * down to import order. Asking the current implementation whether it is already wrapped cannot go
   * stale that way.
   */
  if ((base as Augmented)[AUGMENTED]) return;

  /** A namespace's exported function is a property of a plain object at runtime, so this is an
   *  ordinary assignment - the ESM *binding* is immutable, the object it points at is not. */
  const wrapped: OrgSystemInfo.GetSystemInfo = options => {
    /** An explicit argument first, then the repository's own config, then npm. The config step is
     *  why the core declares `Options.repository`: `rman info` passes only that, so without it a
     *  pnpm repository would silently be reported as an npm one. */
    const packageManager: OrgSystemInfo.PackageManager =
      options?.packageManager ?? asPackageManager(options?.repository?.config?.packageManager) ?? 'npm';

    return base({
      ...options,
      envinfo: {
        /** Replaces the core's `Binaries: ['Node']` - `envinfo` categories merge by key, not by
         *  concatenation, so the whole list has to be restated. */
        Binaries: ['Node', PACKAGE_MANAGER_BINARY[packageManager]],
        /** This package's own version alongside rman's - when `info` is being read to work out why
         *  a command behaved oddly, which plugin version is installed is half the answer. */
        npmPackages: ['rman', '@rman/node', 'typescript'],
        npmGlobalPackages: ['typescript'],
        ...options?.envinfo,
      },
    });
  };

  (wrapped as Augmented)[AUGMENTED] = true;
  (OrgSystemInfo as { getSystemInfo: OrgSystemInfo.GetSystemInfo }).getSystemInfo = wrapped;
}

/** `.rmanrc "packageManager"` value -> the `Binaries` key `envinfo` recognizes for it (`npm`/
 *  `pnpm`/`bun` are lowercase, `Yarn` isn't - envinfo's own naming, not ours). */
const PACKAGE_MANAGER_BINARY: Record<OrgSystemInfo.PackageManager, string> = {
  npm: 'npm',
  yarn: 'Yarn',
  pnpm: 'pnpm',
  bun: 'bun',
};

/** A config value is whatever the file said, so an unrecognized one is ignored rather than used to
 *  index `PACKAGE_MANAGER_BINARY` and produce `Binaries: ['Node', undefined]`. */
function asPackageManager(value: unknown): OrgSystemInfo.PackageManager | undefined {
  return typeof value === 'string' && value in PACKAGE_MANAGER_BINARY
    ? (value as OrgSystemInfo.PackageManager)
    : undefined;
}

/** Marks an implementation as already wrapped. A symbol rather than a property name so it cannot
 *  collide with anything `envinfo` or a future core option carries. */
const AUGMENTED = Symbol.for('@rman/node.systemInfo.augmented');

type Augmented = OrgSystemInfo.GetSystemInfo & { [AUGMENTED]?: boolean };
