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
    throw new Error(
      `"${label}" target "${target}" could not be resolved from "${from}" - is it installed in this repository?`,
    );
  }
}
