import fs from 'node:fs';
import path from 'node:path';
import { RmanApplication } from './application.js';

/**
 * How a repository is laid out, and who decides.
 *
 * A namespace for the same reason `Manifest` is one: it is what a plugin can *augment*
 * (`declare module 'rman' { namespace Workspace { ... } }`), so whatever this seam grows later
 * arrives as a member here rather than as another top-level export.
 */
export namespace Workspace {
  /** What a repository looks like: where its root is, and which directories hold its packages. */
  export interface Layout {
    /** Absolute path to the repository root. */
    root: string;
    /**
     * Absolute paths to the package **directories**, outside the root. Empty for a repository that
     * is itself the one package.
     *
     * Directories rather than `Package` objects, and not for want of trying: a provider runs before
     * any package exists - `Repository.create` constructs them from these paths afterwards, through
     * the *manifest* provider. A discovery provider returning packages would have to construct them
     * itself, making discovery the owner of identity too.
     *
     * Unlike `Package.dependencies`, there is no identity question here: these are paths, and a
     * path is unique by construction where a name is only unique if the ecosystem says so.
     */
    packageDirs: string[];
  }

  /**
   * How a repository's packages are found.
   *
   * **The core has no provider**, and that is the point: "packages are the `workspaces` globs in
   * the root `package.json`, and a package is a directory with a `package.json` in it" is true of
   * npm and of nothing else. `rman-node` contributes that one; a plugin for another ecosystem
   * contributes its own (a Cargo workspace, a `go.work`, a `pyproject.toml`).
   *
   * Returns `undefined` for "this is not a repository I recognize", so the next provider gets a
   * turn and a repository nobody recognizes falls back to being a single package.
   */
  export type Provider = (root: string) => Layout | undefined;

  /** For tests, which would otherwise leak a provider into every later case in the process. */
  export function clearProviders(): void {
    RmanApplication.reset();
  }

  /** The first provider that recognizes `root`, in declaration order. */
  export function resolve(root: string): Layout | undefined {
    for (const stack of RmanApplication.current().techStacks) {
      const layout = stack.workspaceProvider?.(root);
      if (layout) return layout;
    }
    return undefined;
  }

  /**
   * Where the repository starts, decided **without knowing anything about any ecosystem** - it has
   * to be, because the plugins that do know are named in the config file this walk is looking for.
   *
   * Walking up from `from`, stopping after a directory holding `.git`, the root is:
   *
   * 1. the **outermost** directory in that chain holding an `.rmanrc*` - outermost, because a
   *    *package* may have its own `.rmanrc` (that is a supported thing), and from inside such a
   *    package the nearest one is the package's, not the repository's;
   * 2. otherwise the `.git` directory itself, the ordinary meaning of "repository root";
   * 3. otherwise `from`, which is all that is left to go on.
   *
   * **What "outermost" costs**, since the two cases genuinely conflict and only one can win: a
   * self-contained project nested inside a larger git repository *and sharing its `.git`* resolves
   * to the outer root, not to itself (measured). That is the same repository by any definition git
   * recognizes, so it is the defensible answer - and a nested project with a `.git` of its own is
   * found correctly, because the walk stops there before the outer `.rmanrc` is ever seen (also
   * measured). A per-package `.rmanrc` is the common case and it is the one served.
   */
  export function findRoot(from: string, deep = 10): string {
    const chain: string[] = [];
    let dir = path.resolve(from);
    let remaining = deep;
    while (remaining-- >= 0 && fs.existsSync(dir)) {
      chain.push(dir);
      if (fs.existsSync(path.join(dir, '.git'))) break;
      const parent = path.resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }

    const withConfig = chain.filter(hasRmanConfig);
    if (withConfig.length) return withConfig[withConfig.length - 1];

    const gitRoot = chain.find(d => fs.existsSync(path.join(d, '.git')));
    return gitRoot ?? path.resolve(from);
  }

  /** Every file form a `.rmanrc` comes in - `package.json#rman` is deliberately *not* one of them
   *  here: it would make the root question npm-shaped again. */
  const CONFIG_FILES = ['.rmanrc', '.rmanrc.yml', '.rmanrc.cjs', '.rmanrc.mjs', '.rmanrc.js'];

  function hasRmanConfig(dir: string): boolean {
    return CONFIG_FILES.some(name => fs.existsSync(path.join(dir, name)));
  }
}
