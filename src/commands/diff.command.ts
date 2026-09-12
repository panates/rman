import path from 'node:path';
import colors from 'ansi-colors';
import type { Argv } from 'yargs';
import type { Repository } from '../core/repository.js';
import { findLatestTag } from '../utils/change-hash.js';
import { GitHelper } from '../utils/git.js';

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'diff [package]',
    describe: "Shows the git diff since a package's (or the whole repository's) last release tag",
    builder: cmd =>
      cmd
        .example('$0 diff', "# Since the repository's own last tag")
        .example('$0 diff pkg-a', "# Since pkg-a's own last tag, scoped to its directory")
        .positional('package', {
          describe:
            'Package name - diffs just that package, since its own last tag. Omit to diff the whole ' +
            "repository since its own last tag (or the current directory's package, if standing inside one).",
          type: 'string',
        }),
    handler: async args => {
      const git = new GitHelper({ cwd: repository.dirname });
      const packageName = args.package as string | undefined;

      let target = repository.rootPackage;
      let pathspec: string | undefined;
      if (packageName) {
        const pkg = repository.getPackage(packageName);
        if (!pkg) {
          const message = `No such package "${packageName}"`;
          console.log(colors.red(message));
          const err: any = new Error(message);
          err.logged = true;
          throw err;
        }
        target = pkg;
        pathspec = path.relative(repository.dirname, pkg.dirname);
      } else if (repository.currentPackage) {
        target = repository.currentPackage;
        pathspec = path.relative(repository.dirname, target.dirname);
      }

      const tag = await findLatestTag(git, target);
      if (!tag) {
        console.log(colors.gray(`No release tag found for "${target.name}" - nothing to diff against.`));
        return;
      }

      const text = await git.diff(tag, pathspec);
      if (!text.trim()) {
        console.log(colors.gray(`No changes since ${tag}.`));
        return;
      }
      console.log(text);
    },
  });
}
