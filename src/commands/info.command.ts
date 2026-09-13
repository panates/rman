import colors from 'ansi-colors';
import semver from 'semver';
import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { CiService } from '../services/ci.service.js';
import { SystemInfo } from '../services/system-info.js';

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

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'info',
    describe: 'Prints local environment and repository information',
    builder: cmd =>
      cmd
        .example('$0 info', '# Prints information')
        .example('$0 info --json', '# Prints information in JSON format')
        .option('json', {
          alias: 'j',
          describe: 'Print output as JSON',
          type: 'boolean',
        }),
    handler: async args => {
      const systemInfo = await SystemInfo.getSystemInfo(CiService.resolvePackageManager(repository));
      const repositoryInfo = SystemInfo.getRepositoryInfo(repository);
      if (args.json) {
        console.log(JSON.stringify({ ...systemInfo, repository: repositoryInfo }, undefined, 2));
        return;
      }
      printSystemInfo(systemInfo);
      printRepositoryInfo(repositoryInfo);
    },
  });
}
