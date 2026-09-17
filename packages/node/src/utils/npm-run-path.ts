import path from 'node:path';
import process from 'node:process';
import { BinPath } from 'rman';

/**
 * Where npm puts a repository's locally installed executables: `node_modules/.bin`, at **every**
 * level from `cwd` up to the filesystem root - which is how npm itself resolves a binary, so a
 * package's `eslint` is found whether it was installed in that package or hoisted to the workspace
 * root.
 *
 * Adapted from [npm-run-path](https://github.com/sindresorhus/npm-run-path), and it used to sit in
 * rman's core. It is npm's directory layout from end to end: a Cargo or Go repository has no
 * `node_modules` to walk, and nothing here would ever fire for it.
 *
 * **The running `node`'s own directory goes last**, after the walk, and its position is
 * load-bearing. It is there so a script calling `node` gets the interpreter rman itself runs on
 * rather than whatever the shell would pick. It also puts rman's own bin directory ahead of the
 * inherited PATH, which is a measured trap: a nested `rman` invocation inside a `run` script
 * resolves to the globally installed one, not to the repository's. Shim it in
 * `<root>/node_modules/.bin` when that has to be overridden - the walk above reaches there first.
 */
export const npmBinPaths: BinPath.Provider = (cwd: string): string[] => {
  const result: string[] = [];
  let previous: string | undefined;
  let dir = path.resolve(cwd);
  while (previous !== dir) {
    result.push(path.join(dir, 'node_modules/.bin'));
    previous = dir;
    dir = path.resolve(dir, '..');
  }
  result.push(path.resolve(cwd, process.execPath, '..'));
  return result;
};

/** Registers the provider with rman. Called by the plugin entry point, once. */
export function augmentBinPath(): void {
  BinPath.addProvider(npmBinPaths);
}
