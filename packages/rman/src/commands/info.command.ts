import colors from 'ansi-colors';
import semver from 'semver';
import { registerCommand, type RmanConfig } from '../interfaces/rman-config.interface.js';
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
    /** Prints a report, which is the whole output. */
    printsDocument: true,
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
  const rows: [string, ...string[]][] = [
    ['Type', colors.yellowBright(info.type === 'monorepo' ? 'Monorepo' : 'Single package')],
    ['Name', colors.yellowBright(info.name || '(none)')],
    ['Version', colors.yellowBright(info.version || '(none)')],
    ['Root', colors.yellowBright(info.root)],
    ['Platforms', colors.yellowBright(info.platforms.join(', ') || '(none)')],
  ];
  if (info.type === 'monorepo') {
    rows.push(['Packages', colors.yellowBright(String(info.packageCount)), colors.gray('(run "list" to see them)')]);
  }
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, ...values] of rows) console.log('    ' + colors.reset(label.padEnd(width)) + ' :', ...values);
}

/**
 * `rman info` - environment and repository, and back in the core because most of what it reports
 * (OS, CPU, shell, git, the repository's own shape) is true of any repository.
 *
 * The Node half is not written here: registering the `node` built-in augments `SystemInfo` in
 * place, and the package manager and `npmPackages` start appearing. A repository that never names
 * it - or that detection reads as something else - asks for and prints nothing npm-shaped, which is
 * the right answer in any other language. **Bundled is not the same as on**: the built-in ships
 * inside rman, and this is one of the places that difference is visible.
 */
