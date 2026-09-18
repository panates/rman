import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** File forms a path-like target may take when it names no extension of its own. */
const TARGET_EXTENSIONS = ['', '.yml', '.yaml', '.json', '.cjs', '.mjs', '.js'];

/**
 * Resolves a config-supplied module reference - an `extends` base, a `plugins` entry - **relative
 * to the file that named it**, not to rman's own location.
 *
 * That distinction is the whole reason this is a function: resolving from rman would look in rman's
 * own dependencies, where a repository's shared config or plugin has no reason to be. A bare
 * specifier therefore goes through `from`'s own `node_modules` (a package's `exports` subpaths
 * included); anything path-like resolves against `from`'s directory.
 *
 * `label` names the config key in the error, so a failure says which setting to go and look at.
 */
export function resolveConfigTarget(target: string, from: string, label: string): string {
  const dir = path.dirname(path.resolve(from));
  if (target.startsWith('.') || path.isAbsolute(target)) {
    const candidate = path.resolve(dir, target);
    const found = TARGET_EXTENSIONS.map(ext => candidate + ext).find(f => fs.existsSync(f) && fs.statSync(f).isFile());
    if (!found) throw new Error(`"${label}" target "${target}" was not found, resolved from "${from}"`);
    return found;
  }
  try {
    return createRequire(pathToFileURL(path.join(dir, 'noop.js'))).resolve(target);
  } catch {
    const beside = resolveBesideRman(target);
    if (beside) return beside;
    throw new Error(
      `"${label}" target "${target}" could not be resolved from "${from}" - is it installed in this repository?`,
    );
  }
}

/**
 * The fallback: a plugin or shared config installed **beside rman itself**, tried when the
 * repository cannot resolve it.
 *
 * A globally installed rman's siblings *are* the globally installed packages, so this is what makes
 * `rman ci` work on a fresh clone - the command comes from `rman-node`, and `ci` exists to create
 * the very `node_modules` the plugin would otherwise have to be found in. Measured: with both
 * installed globally, a clone answered `"plugins" target "rman-node" could not be resolved ... is
 * it installed in this repository?`, which was true and useless.
 *
 * **The repository is always tried first**, so a repository carrying its own copy is unaffected and
 * its version always wins. This is a fallback, never a search order: `createRequire` is based on the
 * config file precisely so a repository's config resolves against the repository.
 *
 * It is deliberately *not* gated on whether the repository looks installed. That was tried - fall
 * back only when there is no `node_modules` anywhere above the config file - on the reasoning that
 * an installed repository merely *missing* a dependency should keep the honest error. It reads well
 * and behaves unpredictably: the walk reaches the filesystem root, so a checkout under any directory
 * that happens to have a `node_modules` (a home directory, a nested clone) silently lost the
 * fallback. A rule whose answer depends on where the repository was cloned is worse than the
 * looser one.
 *
 * `from` exists for the specs, and is the whole test seam: the answer depends on where **this
 * module** sits, so a spec running inside this repository could otherwise only ever prove that this
 * repository can see its own `node_modules`. Given a throwaway layout's URL it exercises the real
 * resolution - no subprocess, and nothing to keep in step with the source.
 */
export function resolveBesideRman(target: string, from: string = import.meta.url): string | undefined {
  try {
    return createRequire(from).resolve(target);
  } catch {
    return undefined;
  }
}
