import colors from 'ansi-colors';
import semver from 'semver';
import { registerCommand, type RmanConfig } from '../interfaces/rman-cfg.interface.js';
import { SystemInfo } from '../services/system-info.js';

const COMMAND = 'info' as const;

const config = {
  json: { target: 'cli', alias: 'j', describe: 'Print output as JSON', type: 'boolean' },
} satisfies Record<string, RmanConfig.CommandOption>;

type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

/** Reports; declares no config key of its own. */
const infoCommand = registerCommand(app => {
  const repository = app.repository;
  return {
    command: COMMAND,
    describe: 'Prints local environment and repository information',
    config,
    examples: [
      { command: '$0 info', description: '# Prints information' },
      { command: '$0 info --json', description: '# Prints information in JSON format' },
    ],
    handler: async (args: Args) => {
      /** Only the repository - which package manager to report, if any, is a question the core
       *  cannot ask. `rman-node`'s augmentation reads `.rmanrc "packageManager"` off this. */
      const systemInfo = await SystemInfo.getSystemInfo({ repository });
      const repositoryInfo = SystemInfo.getRepositoryInfo(repository);
      if (args.json) {
        console.log(JSON.stringify({ ...systemInfo, repository: repositoryInfo }, undefined, 2));
        return;
      }
      printSystemInfo(systemInfo);
      printRepositoryInfo(repositoryInfo);
    },
  };
});

export default infoCommand;

function printSystemInfo(systemInfo: SystemInfo.SystemInfo): void {
  const maxName = Object.keys(systemInfo).reduce(
    (l, p) => Object.keys(systemInfo[p]).reduce((i, x) => Math.max(i, x.length), l),
    0,
  );
  for (const [categoryName, category] of Object.entries<any>(systemInfo)) {
    console.log('', colors.whiteBright(categoryName) + ':');
    for (const [n, v] of Object.entries<any>(category)) {
      const label = '    ' + colors.reset(n) + ' '.repeat(maxName - n.length) + ' :';
      if (typeof v === 'string') {
        console.log(label, colors.yellowBright(v));
        continue;
      }
      if (v.version) {
        console.log(label, colors.yellowBright(v.version), v.path ? ' ' + colors.yellow(v.path) : '');
      }
      if (v.installed) {
        if (v.wanted === 'latest' || semver.intersects(v.installed, v.wanted)) {
          console.log(label, colors.yellowBright(v.installed));
        } else {
          console.log(label, colors.red(v.installed), ' => ', colors.yellowBright(v.wanted));
        }
      }
    }
  }
}

function printRepositoryInfo(info: SystemInfo.RepositoryInfo): void {
  console.log('', colors.whiteBright('Repository') + ':');
  console.log(
    '    ' + colors.reset('Type') + '     :',
    colors.yellowBright(info.type === 'monorepo' ? 'Monorepo' : 'Single package'),
  );
  console.log('    ' + colors.reset('Name') + '     :', colors.yellowBright(info.name || '(none)'));
  console.log('    ' + colors.reset('Version') + '  :', colors.yellowBright(info.version || '(none)'));
  console.log('    ' + colors.reset('Root') + '     :', colors.yellowBright(info.root));
  if (info.type === 'monorepo') {
    console.log(
      '    ' + colors.reset('Packages') + ' :',
      colors.yellowBright(String(info.packageCount)),
      colors.gray('(run "list" to see them)'),
    );
  }
}

/**
 * `rman info` - environment and repository, and back in the core because most of what it reports
 * (OS, CPU, shell, git, the repository's own shape) is true of any repository.
 *
 * The Node half is not here at all: installing `rman-node` augments `SystemInfo` and the package
 * manager, `npmPackages` and this plugin's own version start appearing. Without it nothing
 * npm-shaped is asked for or printed, which is the right answer for a repository in any other
 * language.
 */
