#!/usr/bin/env node
/** Every built-in command, registered by importing them - see `commands.ts` for why the list lives
 *  there rather than here. */
import './commands.js';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import colors from 'ansi-colors';
import * as yaml from 'js-yaml';
import yargs, { type ArgumentsCamelCase, type Argv, type CommandModule } from 'yargs';
import { hideBin } from 'yargs/helpers';
import { version } from './constants.js';
import { RmanApplication } from './core/application.js';
import { commandName, toYargsCommand } from './core/command-builder.js';
import {
  assertNoBuiltinShadowing,
  type CommandContext,
  type CustomCommand,
  defaultCommandGlobs,
  loadCustomCommands,
  type LoadedCommand,
} from './core/custom-command.js';
import type { Package } from './core/package.js';
import { checkCustomCommand } from './core/plugin-loader.js';
import { Repository } from './core/repository.js';
import { commandRegistry, type RmanConfig } from './interfaces/rman-cfg.interface.js';
import { LOG_LEVELS, Logger, type LogLevel, resolveRootLogLevel } from './utils/logger.js';
import { filterPackages, readFromRootOption, readPackageFilterOptions } from './utils/package-filter.js';
import { printableConfig } from './utils/printable-config.js';
import { runBin } from './utils/run-bin.js';

export async function runCli(options?: { argv?: string[]; cwd?: string; app?: RmanApplication }) {
  const _argv = options?.argv || hideBin(process.argv);

  /**
   * **Answered before the repository is touched**, because neither question is about a repository.
   *
   * `rman -v` is what you reach for when something is wrong - to find out which rman is even
   * installed - and it was the one thing a broken repository took away: resolution happens during
   * `Repository.create`, long before yargs sees the flag, so `rman -v` in a repository whose
   * `.rmanrc` named a plugin it could not resolve answered with that error and exit 1. Measured.
   */
  if (_argv.some(arg => arg === '-v' || arg === '--version')) {
    console.log(version);
    return;
  }

  try {
    /** One application per run, made here so `--log-level` reaches its logger, and handed to
     *  `Repository.create` rather than found through a global. */
    const app = options?.app ?? new RmanApplication();
    const repository = await Repository.create(options?.cwd, { app });

    const program = yargs(_argv)
      .scriptName('rman')
      .version(version)
      .alias('version', 'v')
      .usage('$0 <cmd> [options...]')
      .help('help')
      .alias('help', 'h')
      .option('log-level', {
        describe:
          'Default verbosity of the per-step log for run/build/ci (default: info, or .rmanrc "logLevel"; ' +
          'overridable per-package via .rmanrc run.<script>.logLevel)',
        choices: LOG_LEVELS,
      })
      .option('config', {
        describe:
          'Show what this command would run with - its resolved options, the packages it would act ' +
          'on, and the .rmanrc keys it reads - and run nothing',
        type: 'boolean',
        default: false,
      })
      .showHelpOnFail(false, 'Run with --help for available options')
      .fail((msg: any, err: any) => {
        if (!err?.logged) {
          const text = msg
            ? msg + '\n\n' + colors.whiteBright('Run with --help for available options')
            : err
              ? err.message
              : '';
          console.log('\n' + colors.red(text));
          /** A real `Error`, marked `logged` since the text above just went out: yargs hands the
           *  reason over as a bare string, and rethrowing that raw made bad argv indistinguishable
           *  from success to anything holding the promise - or the shell. */
          const failure: any = new Error(
            typeof msg === 'string' && msg ? msg : typeof err?.message === 'string' ? err.message : 'invalid arguments',
          );
          failure.logged = true;
          throw failure;
        }
        /**
         * Already printed by whoever threw it (the `logged` convention), so there is nothing to say
         * - but it still has to **throw**, not exit.
         *
         * This branch called `process.exit(1)`, and `runCli` is a library entry point: rman's own
         * bin calls it, so do `rman-node`'s fixtures and every spec. Exiting from in here took the
         * whole process down before any caller could see the rejection - which in mocha meant the
         * first command that failed killed the run and the suite could not report a single result.
         * The exit belongs to the bin entry alone (see `isMain()` at the bottom), which already does
         * it; the shell sees the same code either way.
         */
        const failure: any = new Error(err?.message || 'command failed');
        failure.logged = true;
        throw failure;
      });

    /**
     * **`--config` is applied here, once, rather than in every command.** Every command - built-in,
     * a plugin's, a `.rman/*.mjs` one - reaches yargs through `program.command`, so wrapping that
     * one method is what makes the flag genuinely global. Adding an option to each command instead
     * would have meant twelve edits plus a rule for plugin authors to remember, and a flag that
     * quietly does nothing on whichever command forgot it is worse than no flag.
     */
    interceptConfigFlag(repository, program);

    /**
     * **Built-ins come from `commandRegistry`, in the order their modules were imported.** Each
     * entry is a register function that has not run yet - it runs here, with the repository, and
     * returns the command's declaration; `toYargsCommand` is the only thing that knows how a
     * declaration becomes a yargs registration.
     *
     * The thirteen hand-written `initCli(repository, program)` calls this replaces were the second
     * place a command had to be listed, and the list the shadow check guards with was a third.
     */
    const builtIns = commandRegistry.map(register => register(app));
    for (const meta of builtIns) program.command(toYargsCommand(meta));

    /**
     * Commands that are not built in, all from **one** key: `.rmanrc "commands"`, whose default
     * value is `.rman/*.{js,mjs,cjs}`.
     *
     * An entry is a command or a glob naming modules that export one, so a package contributing
     * commands (`rman-node`) and a repository writing its own reach yargs by the same path - there
     * is one source of non-built-in commands and one precedence slot. A plugin used to hand them
     * over separately through `addCommand`, which is the step this replaces.
     *
     * Registered after the built-ins so the shadow check below has the full list to compare
     * against. A command taking a *built-in's* name is refused outright.
     */
    const { globs, direct } = commandEntries(repository);
    const { commands: loaded, errors } = await loadCustomCommands(globs);

    /**
     * The two authoring forms, resolved the same way - a declarative one's factory runs here,
     * where `app.repository` exists, rather than when the config was read.
     *
     * **The file name is the fallback for `command`**, which is the convention a command loaded
     * from a *file* has and one written straight into the config has not: `checkCustomCommand`
     * refuses nameless metadata, and an inline command has nothing to fall back on, so it must say
     * its own name. Spread *under* the factory's result, so metadata that does declare one -
     * `deploy <stage>`, with its positionals - wins.
     *
     * The name comes from what the factory *returned*, not from the file: those differ exactly
     * when the metadata declared one, and using the file name would leave the clash check
     * comparing something yargs never registered.
     */
    const localModules = [...direct, ...loaded].map(c => {
      if (!c.register) return { name: c.name, file: c.file, module: toCustomModule(c.custom!, repository, app) };
      const declared = c.register(app);
      const meta = checkCustomCommand({ ...declared, command: declared.command?.trim() || c.name }, c.file);
      return { name: commandName(meta.command), file: c.file, module: toYargsCommand(meta) };
    });
    /**
     * **One command per name, keeping the last** - which is the precedence that already applied,
     * made visible instead of left to yargs.
     *
     * A repository's own `.rman/check.mjs` overriding a command its config contributed is the
     * intended escape hatch, and it is deliberately not an error: the same precedence a package's
     * own `.rmanrc` has over an `extends` base. But both were being *registered*, and what that
     * cost was the help output - measured, `rman --help` listed `deploy` twice, once with each
     * description, and nothing said which of the two would run.
     *
     * Only the listing was wrong; the override itself was already clean (`rman deploy --help`
     * showed the winner's options alone, and the loser's flag was rejected), which is why this is
     * a registration fix and not a change to how a clash resolves. Registered later wins because
     * `loaded` follows `direct` - a `.rman/` file after a contributed command - and yargs took the
     * last, so keeping the last keeps today's behaviour exactly.
     *
     * The survivor takes the *loser's* position in the list, since that is where the name was
     * first seen. Help ordering only.
     */
    const byName = new Map<string, (typeof localModules)[number]>();
    for (const command of localModules) byName.set(command.name, command);
    const commands = [...byName.values()];
    /**
     * Said out loud, at `verbose`, because deduplicating silently is what would make this the
     * trap it is warned about elsewhere: before, two rows at least hinted that something was
     * doubled - after, the overridden command is simply absent, and "my plugin's command does
     * nothing" has no thread to pull. Not a warning: an override is a correct thing to do, and a
     * repository that does it on purpose should not be nagged on every invocation.
     */
    if (commands.length < localModules.length) {
      const logger = new Logger(argvLogLevel(_argv) ?? resolveRootLogLevel(repository));
      const survivors = new Set(commands);
      for (const lost of localModules.filter(c => !survivors.has(c))) {
        const winner = byName.get(lost.name)!;
        logger.verbose(`"${lost.name}" from ${lost.file} is overridden by ${winner.file}.`);
      }
    }
    assertNoBuiltinShadowing(commands, builtInNames(builtIns));
    for (const { module } of commands) program.command(module);
    /** Warned about, not thrown: one unparseable file must not take the other commands with it.
     *  Loud enough not to be mistaken for success, and it names the file and the reason - "my
     *  command isn't there" is otherwise a long afternoon. */
    for (const { file, reason } of errors) {
      console.error(colors.yellow(`Skipped "${path.relative(process.cwd(), file)}": ${reason}`));
    }

    program.demandCommand(1).strict().recommendCommands().completion();

    if (!_argv.length) program.showHelp();
    /** Rejects rather than exiting, for the reason the `fail` handler above does - the bin entry
     *  turns the rejection into an exit code. */
    else await program.parseAsync();
  } catch (e: any) {
    /**
     * **`--help` still answers**, because a broken repository is the moment you most want it. The
     * command list is the part that genuinely needs the repository - every built-in's `initCli`
     * closes over it, and a plugin's commands *are* the repository's - so help degrades to the
     * global options and says plainly why the rest is missing, rather than failing outright.
     *
     * The reason goes to stderr, so `rman --help | less` is still just help.
     */
    if (_argv.some(arg => arg === '-h' || arg === '--help')) {
      console.error(colors.yellow(`Repository could not be read: ${e.message}`));
      console.error(colors.yellow('Commands are not listed - they come from this repository and its plugins.\n'));
      await yargs(_argv)
        .scriptName('rman')
        .version(version)
        .alias('version', 'v')
        .usage('$0 <cmd> [options...]')
        .help('help')
        .alias('help', 'h')
        .showHelp(text => console.log(text));
      return;
    }
    /** Setup failures - no `package.json` to be found, a `.rman` command shadowing a built-in -
     *  used to be printed and then swallowed, so the shell saw success: `rman info` in the wrong
     *  directory reported failure on stdout and 0 to whatever called it. Printed once (unless the
     *  thrower already did, per the `logged` convention) and rethrown, so the exit code agrees
     *  with the message. */
    if (!e?.logged) console.error(colors.red(e.message));
    throw e;
  }
}

/**
 * Everything `.rmanrc "commands"` declares across the repository, split into the globs to load and
 * the commands written straight into the config.
 *
 * **Collected from the root and from every package**, because `commands` is not a root-level key -
 * a package's own `.rmanrc` may contribute one, and a glob was anchored to that file when it was
 * read. The commands themselves are repository-wide; there is one command list, so a package
 * declaring one is contributing it to the repository. (`plugins` and `publishTargets` cannot work
 * this way: they are read before the packages exist, because a plugin is what finds them.)
 *
 * The cascade means a root-declared entry also appears in each package's resolved config, so the
 * same one arrives many times over. Globs are de-duplicated here and by resolved *file* again in
 * the loader - the second pass is the one that matters, since two different globs can name one
 * file. Inline commands are de-duplicated by identity, which is what the cascade produces.
 *
 * The `.rman/` default is used only when nothing was declared anywhere. Declaring `commands` and
 * still wanting `.rman/` scanned means naming it: the key appends to other layers, not to a
 * built-in fallback, and a default that could never be turned off is not a default.
 */
function commandEntries(repository: Repository): { globs: string[]; direct: LoadedCommand[] } {
  const globs = new Set<string>();
  const seen = new Set<unknown>();
  const direct: LoadedCommand[] = [];

  for (const config of [repository.rootPackage.config, ...repository.getPackages().map(p => p.config)]) {
    const value = config?.commands;
    for (const entry of Array.isArray(value) ? value : value ? [value] : []) {
      if (typeof entry === 'string') {
        if (entry.trim()) globs.add(entry);
        continue;
      }
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      /** No file to fall back on, so the metadata has to name itself - `checkCustomCommand` says
       *  so when it does not. `"commands"` stands in for the file in that message. */
      if (typeof entry === 'function') {
        direct.push({ name: '', file: '"commands"', register: entry });
      } else {
        /** `checkCustomCommand` is what refuses a nameless one, with the message that names the
         *  omission - reached here rather than at registration so an inline command is checked
         *  the same way a plugin's used to be. */
        const custom = checkCustomCommand(entry, '"commands"');
        direct.push({ name: commandName(custom.command), file: '"commands"', custom });
      }
    }
  }
  return { globs: globs.size ? [...globs] : defaultCommandGlobs(repository.dirname), direct };
}

/**
 * Replaces `program.command` with a version that wraps every handler: with `--config` it prints
 * what the command would run with and returns, instead of running it.
 *
 * One interception point rather than an option per command - see the call site. It has to go in
 * **before** any command is registered, since it only affects registrations that pass through it.
 */
function interceptConfigFlag(repository: Repository, program: Argv): void {
  const register = program.command.bind(program) as (spec: any) => Argv;
  (program as any).command = (spec: any) => {
    if (!spec || typeof spec !== 'object' || typeof spec.handler !== 'function') return register(spec);
    const run = spec.handler;
    return register({
      ...spec,
      handler: (args: any) => (args.config ? printCommandConfig(repository, spec, args) : run(args)),
    });
  };
}

/**
 * What a command would run with: its resolved options, the packages it would act on, and the
 * `.rmanrc` those packages carry.
 *
 * The three parts answer the three ways a run surprises someone. **Options** is the parsed argv -
 * what *this invocation* asked for, plus any default yargs itself declares. Most of rman's own
 * defaults are not yargs defaults (`run`'s `bail`/`topo`/`progress` are resolved per package inside
 * `RunService`, from `.rmanrc run.<script>.*`), so an option missing here means "not stated on the
 * command line", and the `.rmanrc` section below is where its value comes from. **Packages** is the
 * set after `--scope`/`--ignore`/
 * `--deps`/`skip`, computed the way the command itself computes it, because a config that is
 * perfect for a package the command never reaches explains nothing. **Config** is narrowed to the
 * keys the command declares it reads (`configKeys` on the command object, which yargs ignores) and
 * is the whole effective config otherwise - the honest answer when nobody has said which half
 * matters.
 */
function printCommandConfig(repository: Repository, spec: any, args: any): void {
  const name = String(spec.command).split(/\s+/)[0];
  const comment = (text: string) => (process.stdout.isTTY ? colors.gray(text) : text);

  console.log(comment(`# ${name} --config: nothing was run.`));
  console.log(`command: ${name}`);
  const options = readOptions(args);
  console.log(
    Object.keys(options).length
      ? `options:\n${indent(yaml.dump(printableConfig(options), { noRefs: true }).trimEnd())}`
      : `options: {}${comment('   # nothing but defaults')}`,
  );

  const targets = commandTargets(repository, args);
  console.log(`packages: ${targets.length ? `[${targets.map(p => p.name).join(', ')}]` : '[]'}`);

  const keys: string[] | undefined = typeof spec.configKeys === 'function' ? spec.configKeys(args) : spec.configKeys;
  console.log(comment(`# .rmanrc${keys?.length ? `, the keys ${name} reads: ${keys.join(', ')}` : ', in full'}`));
  /**
   * **The root package is always listed, even when it is not a target.** A repo-wide setting is
   * read off the root - `packageManager`, `allowBranch`, `version.*`, `githubRelease.*` - so
   * showing only the targets answered `rman ci --config` with `pkg-a: {}`, which reads as "nothing
   * is configured" about the one key `ci` actually reads (measured).
   */
  const shown = [...targets];
  if (!shown.some(p => p === repository.rootPackage)) shown.push(repository.rootPackage);
  const config: Record<string, unknown> = {};
  for (const pkg of shown) config[pkg.name] = keys?.length ? pick(pkg.config, keys) : pkg.config;
  console.log(indent(yaml.dump(printableConfig(config), { noRefs: true, lineWidth: 100 }).trimEnd()));
  if (!targets.includes(repository.rootPackage)) {
    console.log(
      comment(`# "${repository.rootPackage.name}" is the root - listed because repo-wide keys are read there.`),
    );
  }
}

/** The parsed argv, minus what yargs adds and minus the camelCase twin of every dashed option -
 *  both spellings are the same option, and printing both reads as two settings. */
function readOptions(args: any): Record<string, unknown> {
  const dashed = new Set(Object.keys(args).filter(k => k.includes('-')));
  const camel = new Set([...dashed].map(k => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())));
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === '_' || key === '$0' || key === 'config' || camel.has(key)) continue;
    result[key] = value;
  }
  return result;
}

/** The packages the command would act on - `filterPackages` with the command's own options, so
 *  this is the same set the command will compute, `skip` included. Narrowed to the current package
 *  for a command that scopes by directory, unless `--from-root` says otherwise. */
function commandTargets(repository: Repository, args: any): Package[] {
  const current = repository.currentPackage;
  if (current && !readFromRootOption(args)) return [current];
  return filterPackages(repository.getPackages(), readPackageFilterOptions(args));
}

/** The named config paths only - `"run.build"` keeps just that subtree, under that path. */
function pick(config: any, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const value = key.split('.').reduce((node: any, part) => (node == null ? undefined : node[part]), config);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map(line => (line ? `  ${line}` : line))
    .join('\n');
}

function isMain(): boolean {
  try {
    return !!process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isMain()) runCli().catch(() => process.exit(1));

/**
 * Every name a repository's own command may not take - **derived from what was actually
 * registered**, not listed.
 *
 * It used to be a hand-maintained array, because yargs exposes no such list, and a spec had to pin
 * it against the command sources so that adding a command could not quietly leave a repository's
 * own able to shadow it. With the built-ins coming out of `commandRegistry` the list and the
 * registrations cannot disagree: they are the same walk.
 *
 * Aliases count - `ls` is `list`, and shadowing it would be the same mistake. `completion` is
 * yargs' own command rather than one of ours, so it is the one name still written here.
 */
function builtInNames(metas: RmanConfig.CommandMetadata[]): string[] {
  const names = metas.flatMap(meta => [commandName(meta.command), ...(meta.aliases ?? [])]);
  return [...names, 'completion'];
}

/**
 * A `CustomCommand` - a `.rman/*.mjs` command, or a plugin's written the older way - as the yargs
 * registration it describes. `toYargsCommand` is the same function for a *declarative* command;
 * this is the other authoring form, and both end at one `program.command`.
 *
 * **Every field has to be copied deliberately**, because this builds a new object: anything the
 * command declared and this forgets is silently lost. `--config` printed the whole config for every
 * plugin command until `configKeys` was on this list (measured, on `clean` and `ci`).
 */
function toCustomModule(custom: CustomCommand, repository: Repository, app: RmanApplication): CommandModule {
  return {
    command: custom.command!,
    describe: custom.describe,
    configKeys: custom.configKeys,
    builder: custom.builder ?? ((y: Argv) => y),
    handler: (args: ArgumentsCamelCase) => {
      /** Resolved per invocation, not once at registration: `--log-level` is only known now. */
      const logLevel = (args.logLevel as LogLevel | undefined) ?? resolveRootLogLevel(repository);
      const context: CommandContext = {
        repository,
        package: repository.currentPackage,
        runBin: (bin, argv, opts) => runBin(bin, argv, { cwd: repository.dirname, logLevel, app, ...opts }),
        logger: new Logger(logLevel),
      };
      return custom.handler(context, args);
    },
  };
}

/**
 * `--log-level` read straight off argv, for a message printed **before** yargs parses anything.
 *
 * Commands are registered before `parseAsync` runs - registering them is what makes parsing
 * possible - so a diagnostic emitted at registration time cannot come from `args.logLevel`.
 * Measured: the override note in `runCli` was silent for `--log-level verbose` and appeared only
 * when `.rmanrc` said so, which is the one spelling a reader would not reach for first.
 *
 * A peek, not a parser. Both spellings, first match wins, and a value that is not a level is left
 * alone for yargs to reject in its own words - this must not become a second place where an
 * invalid `--log-level` is diagnosed.
 */
function argvLogLevel(argv: string[]): LogLevel | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = arg === '--log-level' ? argv[i + 1] : arg.startsWith('--log-level=') ? arg.slice(12) : undefined;
    if (value && (LOG_LEVELS as string[]).includes(value)) return value as LogLevel;
  }
  return undefined;
}
