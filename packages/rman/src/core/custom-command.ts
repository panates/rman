import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fastGlob from 'fast-glob';
import type { ArgumentsCamelCase, Argv } from 'yargs';
import type { RmanConfig as CommandDeclaration } from '../interfaces/rman-config.interface.js';
import type { Logger } from '../utils/logger.js';
import type { RunBinOptions, RunBinResult } from '../utils/run-bin.js';
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
  /**
   * Runs one of the repository's locally installed binaries - `runBin` (see
   * `../utils/run-bin.ts`), already carrying **this run's** settings: `cwd` defaults to the
   * repository root, and `logLevel` to the level resolved from `--log-level` and `.rmanrc
   * logLevel`. Either can still be overridden per call.
   *
   * Handed over here rather than left to be imported, because those settings are the whole point:
   * importing `runBin` straight from `'rman'` gets a helper that knows neither, so
   * `--log-level silent` would quietly not apply to the one part of the command that produces
   * output. Anything else a run turns out to carry is added here the same way, and no command
   * written against this breaks.
   */
  runBin: (bin: string, argv: string[], options?: RunBinOptions) => Promise<RunBinResult>;
  /** Logger at this run's resolved level, for a command's own narration. */
  logger: Logger;
}

/**
 * Which `.rmanrc` keys a command reads, for `--config` to print instead of running it - a dotted
 * path each (`'run.build'`, `'publish.docker'`), or a function of the parsed argv when the answer
 * depends on it (`run <script>` reads `run.<script>`).
 *
 * **Declared beside the command rather than in a list somewhere central**, so it cannot drift out
 * of step with the code that does the reading, and so a plugin's command or a `.rman/*.mjs` one can
 * say it too. Omitted, `--config` prints the whole effective config - the honest answer when
 * nothing has said which part matters.
 */
export type ConfigKeys = string[] | ((args: ArgumentsCamelCase) => string[]);

export interface CustomCommand {
  /** yargs command string, for a command taking positionals (`'deploy <stage>'`). Defaults to the
   *  module's own file name, which is the whole point of the directory. */
  command?: string;
  /** Required: without it `rman --help` has nothing to list the command by. */
  describe: string;
  builder?: (argv: Argv) => Argv;
  handler: (context: CommandContext, args: ArgumentsCamelCase) => void | Promise<void>;
  /** See `ConfigKeys` - what `rman <this command> --config` narrows its output to. */
  configKeys?: ConfigKeys;
}

/**
 * The same field on **yargs's own** command object, which is what the built-in commands pass.
 *
 * By augmentation rather than a wrapper type of ours: `program.command({ ... })` takes a literal,
 * and TypeScript's excess-property check fires on a literal however the parameter is typed - so a
 * field yargs does not know about is a compile error even though it is ignored at runtime
 * (measured, on nine commands at once). One block, here, beside `ConfigKeys` itself.
 */
declare module 'yargs' {
  /* The parameters have to be spelled exactly as yargs spells them (`T = {}, U = {}`) or TypeScript
     refuses the merge - "All declarations of 'CommandModule' must have identical type parameters" -
     so they are unused here by necessity rather than oversight. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface CommandModule<T = {}, U = {}> {
    configKeys?: ConfigKeys;
  }
}

/**
 * Identity helper for authoring a `.rman/<name>.mjs` command with full type-checking and
 * autocomplete - the same `defineConfig` pattern, for the same reason. Returns `command`
 * unchanged.
 *
 * ```js
 * // .rman/deploy.mjs
 * import { defineCommand, VersionService } from 'rman';
 *
 * export default defineCommand({
 *   describe: 'Ships what was just published to the staging cluster',
 *   builder: y => y.option('stage', { choices: ['dev', 'prod'], demandOption: true }),
 *   async handler({ repository, runBin, logger }, args) {
 *     const plan = await VersionService.getPlan(repository);
 *     for (const entry of plan.filter(e => e.status === 'bump')) {
 *       logger.info(`${entry.package.name} -> ${args.stage}`);
 *     }
 *     await runBin('helm', ['upgrade', '--install', args.stage, './chart']);
 *   },
 * });
 * ```
 *
 * Take `runBin` from the context rather than importing it: the one on the context already carries
 * this run's `cwd` (the repository root) and log level.
 *
 * This is for **one repository-level operation with logic of its own** - branching, its own CLI
 * options, rman's services. Running a shell step across every package is what `.rmanrc
 * "run.<script>"` already does, with the scheduling, topological order, `bail` and progress panel
 * that come with it; reimplementing that loop here would only lose them.
 */
export function defineCommand(command: CustomCommand): CustomCommand {
  return command;
}

/**
 * One command module that loaded, in whichever form it exported.
 *
 * Both forms are accepted, and the same pair is accepted for a command written straight into
 * `.rmanrc "commands"` - one key, one set of rules. The declarative factory is what rman asks a
 * command author to write; a repository's own command should not be stuck on the older object
 * shape just because it lives in a file rather than in a config.
 */
export interface LoadedCommand {
  /** The command's name - its file's basename, or the first word of an explicit `command`. */
  name: string;
  file: string;
  /** The declarative form (`app => ({ ... })`). `cli.ts` runs it where a plugin's and a built-in's
   *  own factories run, because it wants `app.repository` and loading happens before one exists. */
  register?: CommandDeclaration.CommandRegisterFunction;
  /** The `defineCommand({ ... })` object form, already checked and named. */
  custom?: CustomCommand & { command: string };
}

/** A module that couldn't be loaded or doesn't look like a command. Reported, never thrown: one
 *  unparseable file must not take `rman publish` down with it. */
export interface CommandLoadError {
  file: string;
  reason: string;
}

/**
 * The globs a repository's own commands are loaded from when it names none: `.rman/*.{js,mjs,cjs}`
 * under the repository root.
 *
 * **`.rman/` is this default, not a second mechanism.** It used to be a hardcoded directory scan
 * beside which `commands` would have been a third source of repository-level commands - and a
 * third precedence question. Making it the default value instead leaves one source, one slot, and
 * a zero-config path that behaves exactly as it did.
 */
export function defaultCommandGlobs(rootDir: string): string[] {
  return [path.join(rootDir, CUSTOM_COMMAND_DIR, `*{${EXTENSIONS.join(',')}}`)];
}

/**
 * Loads every command module matching `patterns` - absolute globs, already anchored to whichever
 * config file declared them (see `anchorContributions`).
 *
 * A repository matching nothing pays for one glob and no imports, which matters because this runs
 * on *every* rman invocation, `info` included.
 *
 * **Deduplicated by resolved path**, because `commands` appends at every level and cascades: the
 * root's glob reaches each package's resolved config too, so the same file is named more than once
 * as a matter of course rather than as a mistake. Loading it twice would register the command
 * twice, which yargs does not survive.
 *
 * Each failure is collected rather than thrown, so the rest of the CLI keeps working; the caller
 * warns about them. What is *not* tolerated is a module that would shadow a built-in - see
 * `assertNoBuiltinShadowing`.
 */
export async function loadCustomCommands(
  patterns: string[],
): Promise<{ commands: LoadedCommand[]; errors: CommandLoadError[] }> {
  const commands: LoadedCommand[] = [];
  const errors: CommandLoadError[] = [];
  if (!patterns.length) return { commands, errors };

  /** Sorted so the order a command is registered in does not depend on the filesystem, and
   *  `absolute` because a pattern may name a directory outside the repository entirely - which is
   *  exactly what a shared config shipping its own commands does. */
  const files = await fastGlob(
    patterns.map(p => p.split(path.sep).join('/')),
    { absolute: true, onlyFiles: true },
  );
  for (const file of [...new Set(files.map(f => path.resolve(f)))].sort()) {
    try {
      const mod: any = await import(pathToFileURL(file).href);
      const exported = mod?.default ?? mod?.command;
      const basename = path.basename(file, path.extname(file));

      /** The declarative form. Nothing to check here beyond its shape - the factory has not run,
       *  so there is no metadata to validate yet; `cli.ts` checks what it returns. */
      if (typeof exported === 'function') {
        commands.push({ name: basename, file, register: exported });
        continue;
      }
      if (!exported || typeof exported !== 'object') {
        throw new Error(
          'no command exported - end the module with `export default defineCommand({ ... })`, or with ' +
            'the declarative `export default app => ({ ... })`',
        );
      }
      const command = exported as CustomCommand;
      if (typeof command.handler !== 'function') throw new Error('"handler" is missing, or is not a function');
      if (typeof command.describe !== 'string' || !command.describe) {
        throw new Error('"describe" is missing - `rman --help` has nothing to list the command by without it');
      }
      const declared = command.command?.trim();
      commands.push({
        name: (declared || basename).split(/\s+/)[0],
        file,
        custom: { ...command, command: declared || basename },
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
export function assertNoBuiltinShadowing(
  commands: readonly { name: string; file: string }[],
  builtins: readonly string[],
): void {
  const clash = commands.find(c => builtins.includes(c.name));
  if (!clash) return;
  throw new Error(
    `"${path.relative(process.cwd(), clash.file)}" would shadow rman's built-in "${clash.name}" command.\n` +
      `  Rename the file, or give it its own name with \`command: '<name>'\`.`,
  );
}
