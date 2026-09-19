import path from 'node:path';
import process from 'node:process';
import { RmanApplication } from '../core/application.js';

/**
 * Where a repository's **locally installed executables** live, so a command an author wrote
 * (`eslint .`, `cargo build`) is found the way it would be in their own shell.
 *
 * Two halves, split by who actually owns them:
 *
 * - **Which directories** is the *ecosystem's* answer, and the core has none - `node_modules/.bin`
 *   walked up the directory chain is npm's layout and nothing else's (a Python venv says
 *   `.venv/bin`, a Ruby project `bin`). `rman-node` contributes it; see `RmanPlugin.binPaths`.
 * - **How a PATH is spelled** is the *operating system's*, and that stays here: the variable is
 *   `PATH` everywhere except Windows, where its case is whatever the environment happens to use.
 *   That has nothing to do with any ecosystem, and every provider would otherwise get it wrong
 *   separately.
 *
 * **Every provider contributes, in `plugins` declaration order** - unlike `Manifest`/`Workspace`,
 * which take the first that recognizes a repository. A PATH is a list, and a repository holding two
 * ecosystems wants both sets of binaries reachable; "first wins" would silently hide one.
 */
export namespace BinPath {
  export type ProcessEnv = Record<string, string | undefined>;

  /** Absolute directories to put **ahead of** the inherited PATH, for a command run in `cwd`.
   *  Return them most-specific-first; the core concatenates providers without reordering. */
  export type Provider = (cwd: string) => string[];

  export interface EnvOptions {
    /** The directory the command will run in. Default `process.cwd()`. */
    readonly cwd?: string;
    /** The environment to derive from, like `process.env`. Default `process.env`. */
    readonly env?: ProcessEnv;
  }

  /** For tests, which would otherwise leak a provider into every later case in the process. */
  export function clearProviders(): void {
    RmanApplication.reset();
  }

  /** Every provider's directories for `cwd`, concatenated in declaration order. Empty for a
   *  repository that names no plugin - the inherited PATH then stands on its own, which is the
   *  honest answer rather than a guess at some ecosystem's layout. */
  export function resolve(cwd: string): string[] {
    const dir = path.resolve(cwd);
    return [...RmanApplication.current().techStacks].flatMap(stack => stack.binPathsProvider?.(dir) ?? []);
  }

  /**
   * `env` with the contributed directories prepended to its PATH - what `exec` and `runBin` hand to
   * a child process.
   *
   * Prepended, not appended: a repository's own pinned `eslint` has to win over one that happens to
   * be installed globally, which is the whole point of a local install.
   */
  export function env(options: EnvOptions = {}): ProcessEnv {
    const cwd = options.cwd || process.cwd();
    const result = { ...(options.env || process.env) };
    const key = pathKey({ env: result });
    const entries = resolve(cwd);
    if (!entries.length) return result;
    const inherited = result[key];
    result[key] = [...entries, ...(inherited ? [inherited] : [])].join(path.delimiter);
    return result;
  }

  /**
   * The name of the PATH variable in `env` - `PATH` everywhere but Windows, where the environment
   * is case-insensitive and the key can genuinely arrive as `Path`.
   *
   * The OS's business, so it lives here rather than in any provider: read the *existing* key rather
   * than writing a second one, or a child process inherits two PATHs and the one it reads is up to
   * the platform.
   */
  export function pathKey(options?: { env?: ProcessEnv; platform?: string }): string {
    const source = options?.env || process.env;
    const platform = options?.platform || process.platform;
    if (platform !== 'win32') return 'PATH';
    return (
      Object.keys(source)
        .reverse()
        .find(key => key.toUpperCase() === 'PATH') || 'Path'
    );
  }
}
