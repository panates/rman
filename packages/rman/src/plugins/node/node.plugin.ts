import fs from 'node:fs';
import path from 'node:path';
import parseNpmScript from '@netlify/parse-npm-script';
import glob from 'fast-glob';
import type { Package } from '../../core/package.js';
import type { Plugin } from '../../core/plugin.js';
import type { Workspace } from '../../core/workspace.js';
import type { RunService } from '../../services/run.service.js';
import { NodeManifestProvider } from './node-manifest.provider.js';
import { NodeVersionPlanService } from './services/version-plan.service.js';

/** Stands in for a script the package does not declare. `#` is a shell comment, so were it ever to
 *  reach a shell it would do nothing - but it is filtered out above instead. */
const PLACEHOLDER = '#';

export class NodePlugin implements Plugin {
  /** The ecosystem, not the file - this is what every package it reads reports as
   *  `pkg.provider === 'node'`. `manifestProvider.fileName` already says `package.json`. */
  name = 'node';
  manifestProvider = new NodeManifestProvider();
  versionPlanner = new NodeVersionPlanService();

  getWorkspace(root: string): Workspace.Layout | undefined {
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
   * **The running `node`'s own directory goes last**, after the walk, and its position is
   * load-bearing. It is there so a script calling `node` gets the interpreter rman itself runs on
   * rather than whatever the shell would pick. It also puts rman's own bin directory ahead of the
   * inherited PATH, which is a measured trap: a nested `rman` invocation inside a `run` script
   * resolves to the globally installed one, not to the repository's. Shim it in
   * `<root>/node_modules/.bin` when that has to be overridden - the walk above reaches there first.
   */
  getBinPaths(cwd: string): string[] {
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
  }
}

/** npm's lifecycle names, mapped onto rman's three slots. */
function slotOf(stepName: string, script: string): keyof RunService.ScriptSlots | undefined {
  if (stepName === 'pre' + script) return 'before';
  if (stepName === script) return 'exec';
  if (stepName === 'post' + script) return 'after';
  return undefined;
}
