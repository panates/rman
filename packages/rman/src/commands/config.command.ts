import path from 'node:path';
import colors from 'ansi-colors';
import * as yaml from 'js-yaml';
import type { Package } from '../core/classes/package.js';
import { DEFERRED_PATHS } from '../core/config/config-paths.js';
import { ConfigReader } from '../core/config/config-reader.js';
import { registerCommand, type RmanConfig } from '../interfaces/rman-config.interface.js';
import { colorYaml } from '../utils/color-yaml.js';
import { fromRootOption, readFromRootOption } from '../utils/package-filter.js';
import { printableConfig, withoutContributions } from '../utils/printable-config.js';

const COMMAND = 'config' as const;

const config = {
  ...fromRootOption('Print the config for'),
  json: {
    target: 'cli',
    describe: 'Print as JSON instead of YAML - nothing else on stdout, so it can be piped.',
    type: 'boolean',
    default: false,
  },
} satisfies Record<string, RmanConfig.CommandOption>;

type Args = RmanConfig.ArgsOf<typeof config, typeof COMMAND>;

/** Prints config; declares none of its own, so it contributes nothing to `RmanConfig`. */
const configCommand = registerCommand(app => {
  const repository = app.repository;
  return {
    command: COMMAND,
    /** Prints a loadable YAML document - a line above it is what makes it unparseable. */
    printsDocument: true,
    describe: 'Prints the effective .rmanrc config for the package of the current directory',
    config,
    examples: [
      { command: '$0 config', description: '# The config of the package you are standing in' },
      { command: '$0 config --from-root', description: "# The repository root's own config instead" },
      { command: '$0 config --json | jq .version', description: '# Machine-readable' },
    ],
    handler: (args: Args) => {
      const target = (!readFromRootOption(args) && repository.currentPackage) || repository.rootPackage;

      const settings = withoutContributions(target.config);

      if (args.json) {
        console.log(JSON.stringify(printableConfig(settings), undefined, 2));
        return;
      }

      /**
       * **Colour only on a terminal, and here that is correctness rather than taste.** The header
       * and notes are YAML `#` comments so the whole output stays loadable - and an escape sequence
       * inside one makes it *unloadable*: `rman config > rmanrc.yml` wrote a file js-yaml rejects
       * with "the stream contains non-printable characters" (measured; `ansi-colors` does not turn
       * itself off for a pipe here). The repository's own convention for this is
       * `process.stdout.isTTY`, as `run`/`exec`'s progress panel uses.
       */
      const tty = !!process.stdout.isTTY;
      const comment = (text: string) => (tty ? colors.gray(text) : text);
      const relativeDir = path.relative(repository.dirname, target.dirname) || '.';

      /**
       * **The file you would open to change this**, headed first because that is the next thing a
       * reader wants. Omitted for a directory that declares none - naming a file that is not there
       * would send them to create one when the answer is a level above.
       *
       * It is the package's **own** file and the printed config is more than it: the directory
       * chain above, every `extends` base and each `"[selector]"` block are all in there. The
       * per-key answer is `ORIGINS`, which is what a failing expression's message already names -
       * this line is the starting point, not the whole provenance.
       */
      const source = new ConfigReader().findConfigSource(target.dirname);
      if (source) console.log(comment(`# ${path.basename(source)}`));
      console.log(comment(`# ${target.name} (${relativeDir})`));
      for (const note of deferredNotes(target)) console.log(comment(`# ${note}`));
      /** `noRefs`: a value appearing twice in the config is the *same object* after merging, and
       *  js-yaml would otherwise emit the second as an `*anchor` reference - valid YAML that reads
       *  as a mistake in something meant to be looked at. */
      const body = yaml.dump(printableConfig(settings), { noRefs: true, lineWidth: 100 }).trimEnd();
      console.log(tty ? colorYaml(body) : body);
    },
  };
});

export default configCommand;

/**
 * The one honest caveat about this output: **`version.before`/`.exec`/`.after` are printed raw**,
 * expressions and all, because they are the paths in `DEFERRED_PATHS` - `${{ pkg.targetVersion }}`
 * cannot be evaluated until `version` has computed a plan, so the repository deliberately leaves
 * them unevaluated at load. Without saying so, a reader sees an uninterpolated `${{ ... }}` sitting
 * among interpolated values and concludes interpolation is broken.
 */
function deferredNotes(pkg: Package): string[] {
  const raw = DEFERRED_PATHS.filter(p => valueAt(pkg.config, p) !== undefined);
  if (!raw.length) return [];
  return [`${raw.join(', ')}: printed raw - evaluated by "version" itself, once it knows the target version`];
}

function valueAt(node: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<any>((current, key) => (current == null ? undefined : current[key]), node);
}
