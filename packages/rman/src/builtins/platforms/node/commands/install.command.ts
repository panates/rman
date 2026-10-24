import type { ArgsOf, CommandOption } from '../../../../index.js';
import { declareCommand } from '../../../../interfaces/rman-config.interface.js';
import { CiService } from '../services/ci.service.js';

/** Hoisted for `ArgsOf`, as in `ci.command.ts`. */
const COMMAND = 'install' as const;

const config = {
  packageManager: {
    target: 'cli',
    cliName: 'package-manager',
    describe:
      'Package manager to install with (default: .rmanrc "packageManager.node", else the lockfile\'s, else npm)',
    choices: CiService.PACKAGE_MANAGERS,
  },
  frozenLockfile: {
    target: 'cli',
    cliName: 'frozen-lockfile',
    describe:
      'Install exactly what the lockfile says, failing rather than changing it. Under npm this is npm ci, which removes node_modules first',
    type: 'boolean',
  },
  prod: {
    target: 'cli',
    describe: 'Production dependencies only - no devDependencies',
    type: 'boolean',
  },
  ignoreScripts: {
    target: 'cli',
    cliName: 'ignore-scripts',
    describe: 'Run no lifecycle scripts',
    type: 'boolean',
  },
  lockfileOnly: {
    target: 'cli',
    cliName: 'lockfile-only',
    describe: 'Bring the lockfile up to date with the manifests, installing nothing',
    type: 'boolean',
  },
  offline: {
    target: 'cli',
    describe: 'Use only what is in the local cache, never the network',
    type: 'boolean',
  },
  preferOffline: {
    target: 'cli',
    cliName: 'prefer-offline',
    describe: 'Use the local cache where it has the answer, the network only for what is missing',
    type: 'boolean',
  },
  dryRun: {
    target: 'cli',
    cliName: 'dry-run',
    describe: 'Report what an install would change, writing nothing (pnpm 11.8+)',
    type: 'boolean',
  },
  registry: {
    target: 'cli',
    describe: 'Registry to install from, for this run',
    type: 'string',
  },
} satisfies Record<string, CommandOption>;

type Args = ArgsOf<typeof config, typeof COMMAND>;

/**
 * `rman install` / `rman i` - one install at the repository root with whichever package manager the
 * repository uses, so nobody has to know which one to type.
 */
/* **`ci` without the wipe**, which is the whole difference: `ci` deletes every `node_modules` and
 * lockfile and then installs, this installs into what is there. The package manager comes from the
 * same `resolvePackageManager` `ci` and `publish` use - flag, `packageManager.node`, the lockfile,
 * npm - so the two commands cannot disagree about whose install runs.
 *
 * **The options are the ones npm and pnpm share**, spelled once here and translated per tool by
 * `CiService.installArgv`; anything else goes after `--` (`populate--`, as `exec` and the preset's
 * `lint` do). A positional package (`rman i lodash`) is deliberately not taken: adding a dependency
 * is `npm install <pkg>` but `pnpm add <pkg>`, a second verb with its own flags, and a command that
 * half-supports it is worse than one that does not pretend to. */
export const installCommand = declareCommand(app => {
  const repository = app.repository;
  return {
    command: COMMAND,
    aliases: ['i'],
    platforms: ['node'],
    describe: "Installs the repository's dependencies with its own package manager, deleting nothing first",
    configKeys: ['packageManager'],
    parserConfiguration: { 'populate--': true },
    config,
    examples: [
      { command: '$0 install', description: "# The repository's package manager, whichever it is" },
      { command: '$0 i --frozen-lockfile', description: '# Exactly the lockfile - for CI' },
      { command: '$0 i --prod --ignore-scripts', description: '# Production dependencies, no lifecycle scripts' },
      { command: '$0 i -- --legacy-peer-deps', description: '# Anything else goes to the package manager after --' },
    ],
    handler: async (args: Args) => {
      await CiService.install(repository, {
        packageManager: args.packageManager,
        frozenLockfile: args.frozenLockfile,
        prod: args.prod,
        ignoreScripts: args.ignoreScripts,
        lockfileOnly: args.lockfileOnly,
        offline: args.offline,
        preferOffline: args.preferOffline,
        dryRun: args.dryRun,
        registry: args.registry,
        extra: (args['--'] ?? []).map(String),
        logLevel: args.logLevel,
      });
    },
  };
});
