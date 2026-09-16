import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ArgumentsCamelCase, Argv } from 'yargs';
import type { Package } from './package.js';
import type { Repository } from './repository.js';

/** Where a repository keeps its own commands - one module per command, named after it. */
export const CUSTOM_COMMAND_DIR = '.rman';

/** Loadable module forms, matching what a `.rmanrc.cjs`/`.mjs`/`.js` config already accepts. A
 *  `.ts` command would need a loader registered in rman's own process, which is a separate
 *  question from this one. */
const EXTENSIONS = ['.js', '.mjs', '.cjs'];

/**
 * What a repository's own command is handed. An object rather than loose parameters so later
 * additions don't break every command already written against it.
 */
export interface CommandContext {
  repository: Repository;
  /**
   * The package whose directory rman was invoked from, or `undefined` at the repository root (and
   * in a single-package repository, which is always "at the root") - the same
   * `Repository.currentPackage` the built-in commands scope themselves by. A command that only
   * makes sense inside a package should say so itself rather than assume.
   */
  package: Package | undefined;
}

export interface CustomCommand {
  /** yargs command string, for a command taking positionals (`'deploy <stage>'`). Defaults to the
   *  module's own file name, which is the whole point of the directory. */
  command?: string;
  /** Required: without it `rman --help` has nothing to list the command by. */
  describe: string;
  builder?: (argv: Argv) => Argv;
  handler: (context: CommandContext, args: ArgumentsCamelCase) => void | Promise<void>;
}

/**
 * Identity helper for authoring a `.rman/<name>.mjs` command with full type-checking and
 * autocomplete - the same `defineConfig` pattern, for the same reason. Returns `command`
 * unchanged.
 *
 * ```js
 * // .rman/deploy.mjs
 * import { defineCommand, PublishService } from 'rman';
 *
 * export default defineCommand({
 *   describe: 'Ships what was just published to the staging cluster',
 *   builder: y => y.option('stage', { choices: ['dev', 'prod'], demandOption: true }),
 *   async handler({ repository }, args) {
 *     const plan = await PublishService.getPlan(repository);
 *     for (const entry of plan.filter(e => e.status === 'publish')) {
 *       console.log(`${entry.package.name} -> ${args.stage}`);
 *     }
 *   },
 * });
 * ```
 *
 * This is for **one repository-level operation with logic of its own** - branching, its own CLI
 * options, rman's services. Running a shell step across every package is what `.rmanrc
 * "run.<script>"` already does, with the scheduling, topological order, `bail` and progress panel
 * that come with it; reimplementing that loop here would only lose them.
 */
export function defineCommand(command: CustomCommand): CustomCommand {
  return command;
}

export interface LoadedCommand extends CustomCommand {
  /** The command's name - its file's basename, or the first word of an explicit `command`. */
  name: string;
  file: string;
}

/** A module that couldn't be loaded or doesn't look like a command. Reported, never thrown: one
 *  unparseable file must not take `rman publish` down with it. */
export interface CommandLoadError {
  file: string;
  reason: string;
}

/**
 * Loads every command module in `<root>/.rman`. A repository without that directory pays nothing -
 * no scan, no imports - which matters because this runs on *every* rman invocation, `info`
 * included.
 *
 * Each failure is collected rather than thrown, so the rest of the CLI keeps working; the caller
 * warns about them. What is *not* tolerated is a module that would shadow a built-in - see
 * `assertNoBuiltinShadowing`.
 */
export async function loadCustomCommands(
  rootDir: string,
): Promise<{ commands: LoadedCommand[]; errors: CommandLoadError[] }> {
  const dir = path.join(rootDir, CUSTOM_COMMAND_DIR);
  const commands: LoadedCommand[] = [];
  const errors: CommandLoadError[] = [];
  if (!fs.existsSync(dir)) return { commands, errors };

  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !EXTENSIONS.includes(path.extname(entry.name))) continue;
    const file = path.join(dir, entry.name);
    try {
      const mod: any = await import(pathToFileURL(file).href);
      const command: CustomCommand | undefined = mod?.default ?? mod?.command;
      if (!command || typeof command !== 'object') {
        throw new Error('no default export - end the module with `export default defineCommand({ ... })`');
      }
      if (typeof command.handler !== 'function') throw new Error('"handler" is missing, or is not a function');
      if (typeof command.describe !== 'string' || !command.describe) {
        throw new Error('"describe" is missing - `rman --help` has nothing to list the command by without it');
      }
      const declared = command.command?.trim();
      commands.push({
        ...command,
        command: declared || path.basename(entry.name, path.extname(entry.name)),
        name: (declared || path.basename(entry.name, path.extname(entry.name))).split(/\s+/)[0],
        file,
      });
    } catch (e: any) {
      errors.push({ file, reason: e?.message ?? String(e) });
    }
  }
  return { commands, errors };
}

/**
 * Refuses a command that would take a built-in's name. Unlike a module that simply fails to load,
 * this one is thrown: the file is fine, the *name* is the mistake, and there is no reading of
 * `rman publish` that is safe to guess at. Silently preferring either one would leave whoever typed
 * it unable to tell which ran.
 */
export function assertNoBuiltinShadowing(commands: LoadedCommand[], builtins: readonly string[]): void {
  const clash = commands.find(c => builtins.includes(c.name));
  if (!clash) return;
  throw new Error(
    `"${path.relative(process.cwd(), clash.file)}" would shadow rman's built-in "${clash.name}" command.\n` +
      `  Rename the file, or give it its own name with \`command: '<name>'\`.`,
  );
}
