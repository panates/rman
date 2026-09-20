import path from 'node:path';
import colors from 'ansi-colors';
import { registerCommand, type RmanConfig } from '../interfaces/rman-cfg.interface.js';
import { ChangeHashService } from '../services/change-hash.service.js';
import { GitHelper } from '../utils/git.js';
import { fromRootOption, readFromRootOption } from '../utils/package-filter.js';

const COMMAND = 'diff [package]' as const;
const config = fromRootOption('Diff');
type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

const diffCommand = registerCommand(app => {
  const repository = app.repository;
  return {
    command: COMMAND,
    describe: "Shows the git diff since a package's (or the whole repository's) last release tag",
    config,
    positionals: {
      package: {
        describe:
          'Package name - diffs just that package, since its own last tag. Omit to diff the whole ' +
          "repository since its own last tag (or the current directory's package, if standing inside one).",
        type: 'string',
      },
    },
    examples: [
      { command: '$0 diff', description: "# Since the repository's own last tag" },
      { command: '$0 diff pkg-a', description: "# Since pkg-a's own last tag, scoped to its directory" },
      { command: '$0 diff --from-root', description: '# The whole repository, from inside a package' },
    ],
    handler: async (args: Args) => {
      const git = new GitHelper({ cwd: repository.dirname });
      const packageName = args.package;

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
      } else if (!readFromRootOption(args) && repository.currentPackage) {
        /** The measured gap this closes: `diff` narrowed to the current package like `run` and
         *  `changelog` do, but offered no way to say "the whole repository" without naming a
         *  package - and no package name means the repository, so there was nothing to type. */
        target = repository.currentPackage;
        pathspec = path.relative(repository.dirname, target.dirname);
      }

      const tag = await ChangeHashService.findLatestTag(git, target);
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
  };
});

export default diffCommand;
