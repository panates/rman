import type { Argv, CommandModule } from 'yargs';
import type { RmanConfig } from '../interfaces/rman-config.interface.js';

/**
 * Turns a command's **declaration** into the yargs registration it describes.
 *
 * This is the one place that knows how the two relate, which is the point of declaring commands
 * instead of building them: a command says what it has, and only this function says what yargs is
 * told. Everything a `builder` used to do by hand - options, positionals, examples, parser
 * switches - arrives as data now, so a typo in any of it is a compile error at the command rather
 * than a flag that silently never existed.
 */
export function toYargsCommand(meta: RmanConfig.CommandMetadata): CommandModule {
  return {
    command: meta.command,
    aliases: meta.aliases,
    describe: meta.describe,
    configKeys: configKeysOf(meta),
    builder: (cmd: Argv) => {
      if (meta.parserConfiguration) cmd.parserConfiguration(meta.parserConfiguration);
      for (const [name, spec] of Object.entries(meta.positionals ?? {})) cmd.positional(name, spec);
      for (const [key, option] of Object.entries(meta.config ?? {})) {
        /**
         * **`target: 'config'` means "a `.rmanrc` key, and not a flag"** - `githubRelease.draft` is
         * the first of those. Skipping it here is what makes the field mean something rather than
         * being documentation.
         */
        if (option.target === 'config') continue;
        /** `target` and `cliName` are rman's, not yargs' - dropped rather than passed through. */
        const { cliName, ...rest } = option;
        delete (rest as Record<string, unknown>).target;
        /**
         * Registered under `cliName` when the flag and the config key are spelled differently
         * (`--ignore-dirty` for `ignoreDirty`). yargs expands the hyphenated form back to camelCase
         * in argv, so the handler reads the key it declared either way.
         */
        cmd.option(cliName ?? key, rest);
      }
      for (const example of meta.examples ?? []) cmd.example(example.command, example.description ?? '');
      return cmd;
    },
    /**
     * Cast because the two descriptions of argv disagree on purpose: yargs types it as an index
     * signature of `unknown`, and a command annotates it with the options it actually declared. The
     * narrower one is the useful one, and this is the single place the widening is admitted -
     * previously it was an `as` per option read, in every handler.
     */
    handler: meta.handler as CommandModule['handler'],
  };
}

/** A command's own name - the first word of its `command` string, before any positional. */
export function commandName(command: string): string {
  return command.split(/\s+/)[0]!;
}

/**
 * Which `.rmanrc` keys `--config` shows for a command: the ones it declared reading, plus **its own
 * key when it has one**.
 *
 * `configKeys` is the read-only list on purpose - a command should not have to repeat the key it
 * already owns, and `version` listing `'version'` beside `'changelog'` said nothing about which of
 * the two it defines. Measured before this existed: `rman version --config` reported
 * `changelog, group, allowBranch, ignoreBranch` and left out `version` itself.
 *
 * **Own key only when the command actually declares a config option.** `build` and `test` own
 * nothing - their settings live in `run.build`/`run.test`, which they merely read - so prepending
 * their names would print an empty `build: {}` that reads as "nothing is configured" about a key
 * that does not exist. A `configKeys` given as a *function* is left alone entirely: `run` computes
 * `run.<script>` from argv, which is narrower than its own key and deliberately so.
 */
function configKeysOf(meta: RmanConfig.CommandMetadata): RmanConfig.CommandMetadata['configKeys'] {
  if (typeof meta.configKeys === 'function') return meta.configKeys;
  const ownsConfig = Object.values(meta.config ?? {}).some(o => o.target !== 'cli');
  const own = ownsConfig ? [meta.configKey ?? commandName(meta.command)] : [];
  const keys = [...own, ...(meta.configKeys ?? [])];
  return keys.length ? keys : undefined;
}
