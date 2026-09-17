import fs from 'node:fs';
import path from 'node:path';
import glob from 'fast-glob';
import { Workspace } from 'rman';

/**
 * Finds an npm workspace's packages: the `workspaces` globs in the root `package.json`, keeping
 * every matched directory that holds a `package.json` of its own.
 *
 * This is the deepest thing that moved out of the core, and the one that most needed to. "A package
 * is a directory with a `package.json`" and "the repository lists its members in `workspaces`" are
 * npm's ideas - a Cargo workspace, a `go.work` and a `pyproject.toml` each say the same thing
 * differently, and a core that hardcoded one of them could never read the others.
 *
 * Returns `undefined` for a root with no `workspaces` array, which is how a single-package
 * repository still works: the core treats "no provider recognized this" as "the repository is the
 * package". Note that this makes no upward walk of its own - the root was already decided, without
 * any ecosystem's help, before this is called.
 */
export const npmWorkspace: Workspace.Provider = (root: string): Workspace.Layout | undefined => {
  const manifest = path.join(root, 'package.json');
  if (!fs.existsSync(manifest)) return undefined;

  let patterns: unknown;
  try {
    patterns = JSON.parse(fs.readFileSync(manifest, 'utf-8'))?.workspaces;
  } catch {
    /** A malformed root `package.json` is not this provider's error to report - `Package` will do
     *  it with the file in hand when something actually reads the manifest. */
    return undefined;
  }
  if (!Array.isArray(patterns)) return undefined;

  const packageDirs: string[] = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    const dirs = glob.sync(pattern, { cwd: root, absolute: true, deep: 0, onlyDirectories: true });
    for (const dir of dirs) {
      if (fs.existsSync(path.join(dir, 'package.json'))) packageDirs.push(dir);
    }
  }
  return { root, packageDirs };
};

/** Registers the provider with rman. Called by the plugin entry point, once. */
export function augmentWorkspace(): void {
  Workspace.addProvider(npmWorkspace);
}
