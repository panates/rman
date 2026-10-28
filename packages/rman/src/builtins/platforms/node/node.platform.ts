import fs from 'node:fs';
import path from 'node:path';
import parseNpmScript from '@netlify/parse-npm-script';
import glob from 'fast-glob';
import * as yaml from 'js-yaml';
import type { Package } from '../../../core/classes/package.js';
import type { Platform } from '../../../core/interfaces/plugin.js';
import type { RunService } from '../../../services/run.service.js';
import { BinPath } from '../../../utils/bin-path.js';
import { NodeDependencyUpdater } from './node-dependency-updater.js';
import { NodeManifestProvider } from './node-manifest.provider.js';
import { NodeVersionPlanService } from './services/version-plan.service.js';

/** Stands in for a script the package does not declare. `#` is a shell comment, so were it ever to
 *  reach a shell it would do nothing - but it is filtered out above instead. */
const PLACEHOLDER = '#';

export class NodePlatform implements Platform {
  /** The ecosystem, not the file - this is what every package it reads reports as
   *  `pkg.provider === 'node'`. `manifestProvider.fileName` already says `package.json`. */
  name = 'node';
  manifestProvider = new NodeManifestProvider();
  versionPlanner = new NodeVersionPlanService();
  dependencyUpdater = new NodeDependencyUpdater();

  /** The file pnpm keeps a workspace's member list in - see `getWorkspace`. */
  protected readonly pnpmWorkspaceFile: string = 'pnpm-workspace.yaml';

  /**
   * The workspace members of `dir`: the directories its `pnpm-workspace.yaml` `packages` globs
   * match when it has that list, else its `package.json` `workspaces` globs - each one holding a
   * `package.json`. Throws for a `pnpm-workspace.yaml` that is not valid YAML.
   */
  /* **pnpm's list first, when there is one** - pnpm reads `pnpm-workspace.yaml` and ignores
   * `package.json#workspaces`, so in a pnpm repository that file is the one the installed tree
   * follows. Reported from `syncbridge-io/public-modules`: with only `pnpm-workspace.yaml`, rman
   * found no packages at all, and the repository had to keep both lists in step.
   *
   * **A `pnpm-workspace.yaml` with no `packages` falls back to `workspaces`**, which is not what pnpm
   * does: measured on pnpm 12.10.1, a settings-only file (`publicHoistPattern` alone) leaves pnpm
   * with the root and no members. pnpm 9 moved its settings into this file, so a settings-only one
   * is ordinary, and a file that says nothing about packages is read as saying nothing.
   *
   * **pnpm's globbing, as measured on the same pnpm**: `packages/**` takes members at any depth and
   * none under `node_modules`; `!packages/test-*` leaves those out. npm's `workspaces` keep the
   * one-level reading (`deep: 0`), which nothing has asked to change.
   *
   * **Asked of every directory the walk reaches, not only of the repository root**, which is what
   * the seam changing from a layout to a per-directory question bought: a `package.json` naming
   * `workspaces` is a workspace root wherever it sits, so a Node sub-workspace inside a larger
   * repository is found by the same code that finds the top one. */
  getWorkspace(dir: string): string[] | undefined {
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) return undefined;

    const pnpm = this.pnpmWorkspacePackages(dir);
    if (pnpm) {
      const dirs = glob.sync([...pnpm, '!**/node_modules/**'], { cwd: dir, absolute: true, onlyDirectories: true });
      return this.packageDirs(dirs);
    }

    let patterns: unknown;
    try {
      patterns = JSON.parse(fs.readFileSync(manifest, 'utf-8'))?.workspaces;
    } catch {
      /** A malformed `package.json` is not this provider's error to report - `Package` will do it
       *  with the file in hand when something actually reads the manifest. */
      return undefined;
    }
    if (!Array.isArray(patterns)) return undefined;

    const dirs: string[] = [];
    for (const pattern of patterns) {
      if (typeof pattern !== 'string') continue;
      dirs.push(...glob.sync(pattern, { cwd: dir, absolute: true, deep: 0, onlyDirectories: true }));
    }
    return this.packageDirs(dirs);
  }

  /**
   * Teaches `run` about `package.json#scripts`.
   *
   * rman's core resolves a script from `.rmanrc` alone - `before`/`exec`/`after`. That a script might
   * *also* live in `package.json`, that `prebuild` and `postbuild` run around `build`, and that
   * `a && b` is two steps rather than one, are all facts about npm, so they are here.
   *
   * Registered as a `RunService` step source rather than by wrapping anything: the npm part of `run`
   * is inside step resolution, not at its entry point, so there is nothing a wrapper could reach.
   * The core decides what to do with what this returns - see `getScriptSteps` for the precedence.
   */
  getRunSteps(pkg: Package, script: string) {
    const scripts = pkg.manifest.raw?.scripts;
    if (!scripts || typeof scripts !== 'object') return undefined;

    const declared = (name: string): boolean => typeof scripts[name] === 'string' && !!scripts[name];
    if (!declared(script) && !declared('pre' + script) && !declared('post' + script)) return undefined;

    /**
     * `parseNpmScript` expands npm's own lifecycle - `pre<script>`, the script, `post<script>` - and
     * splits each on `&&` into the commands npm would run in sequence. The placeholder matters: it
     * asks for a script the package may not declare itself (it may have only a `prebuild`), and
     * without something there the parser reports the whole chain as absent.
     */
    const json = { ...pkg.manifest.raw, scripts: { ...scripts } };
    json.scripts[script] = json.scripts[script] || PLACEHOLDER;

    const info = parseNpmScript(json, 'npm run ' + script);
    if (!info?.raw?.length) return undefined;

    const slots: RunService.ScriptSlots = { before: [], exec: [], after: [] };
    for (const step of info.steps) {
      const slot = slotOf(step.name, script);
      if (!slot) continue;
      for (const command of Array.isArray(step.parsed) ? step.parsed : [step.parsed]) {
        if (command === PLACEHOLDER) continue;
        slots[slot]!.push(command);
      }
    }
    return slots;
  }

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
   * **The running `node`'s own directory goes last**, after the walk - and only when the inherited
   * PATH would find a different `node`. It is there so a script calling `node` gets the interpreter
   * rman itself runs on rather than whatever the shell would pick; where the shell already picks
   * that one, the inherited PATH keeps its own order.
   */
  /* **Unconditional, it put every global npm binary ahead of the user's PATH**, since the
   * interpreter's directory is also where `npm install -g` writes. Measured on this machine: the
   * shell's `pnpm` was 12.10.1 from `~/Library/pnpm/bin`, rman's children got 9.9.0 from the nvm
   * directory, so `deps -u` reported `Not verified: pnpm 9.9.0` and read no `minimumReleaseAge` -
   * while the shell's `node` was the very interpreter rman ran on, so the prepend bought nothing.
   * A nested `rman` inside a `run` script reached the global one the same way.
   *
   * **When the two `node`s differ the directory still goes ahead**, and its neighbours with it:
   * someone ran rman on another interpreter (an `nvm exec`, an absolute path), and the guarantee
   * that a step's `node` is that one outranks the shell's choice of tools. A directory holding only
   * `node` would separate the two and needs a shim on disk; nothing has asked for it yet.
   *
   * Compared by real path, so a Homebrew `bin/node` symlink is the Cellar file `execPath` names. */
  getBinPaths(cwd: string): string[] {
    const result: string[] = [];
    let previous: string | undefined;
    let dir = path.resolve(cwd);
    while (previous !== dir) {
      result.push(path.join(dir, 'node_modules/.bin'));
      previous = dir;
      dir = path.resolve(dir, '..');
    }
    if (!this.inheritsNode()) result.push(path.resolve(cwd, process.execPath, '..'));
    return result;
  }

  /** Whether the inherited PATH's first `node` is the interpreter rman is running on. */
  protected inheritsNode(): boolean {
    const names = process.platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node'];
    const running = this.realPath(process.execPath);
    for (const dir of this.inheritedPath().split(path.delimiter)) {
      if (!dir || !path.isAbsolute(dir)) continue;
      for (const name of names) {
        const found = this.realPath(path.join(dir, name));
        if (found) return found === running;
      }
    }
    return false;
  }

  /** The PATH a child process inherits, before anything is put in front of it. */
  protected inheritedPath(): string {
    return process.env[BinPath.pathKey()] ?? '';
  }

  /** `file`'s real path, or `undefined` when it does not exist. */
  protected realPath(file: string): string | undefined {
    try {
      return fs.realpathSync(file);
    } catch {
      return undefined;
    }
  }

  /** The `packages` globs of `dir`'s `pnpm-workspace.yaml`, or `undefined` when there is no such
   *  file or it lists none. Throws when the file is not valid YAML. */
  /* Thrown rather than swallowed, unlike a malformed `package.json` above: nothing else in rman
   * reads this file, so a parse error left here would surface as a repository with no packages. */
  protected pnpmWorkspacePackages(dir: string): string[] | undefined {
    const file = path.join(dir, this.pnpmWorkspaceFile);
    if (!fs.existsSync(file)) return undefined;
    let parsed: unknown;
    try {
      parsed = yaml.load(fs.readFileSync(file, 'utf-8'));
    } catch (e: any) {
      throw new Error(`Cannot read ${file}: ${e.message}`, { cause: e });
    }
    const packages = (parsed as { packages?: unknown } | null)?.packages;
    if (!Array.isArray(packages)) return undefined;
    return packages.filter((p): p is string => typeof p === 'string');
  }

  /** The directories of `dirs` that hold a `package.json`, each once. */
  protected packageDirs(dirs: readonly string[]): string[] {
    return [...new Set(dirs)].filter(d => fs.existsSync(path.join(d, 'package.json')));
  }
}

/** npm's lifecycle names, mapped onto rman's three slots. */
function slotOf(stepName: string, script: string): keyof RunService.ScriptSlots | undefined {
  if (stepName === 'pre' + script) return 'before';
  if (stepName === script) return 'exec';
  if (stepName === 'post' + script) return 'after';
  return undefined;
}
