import path from 'node:path';
import colors from 'ansi-colors';
import * as yaml from 'js-yaml';
import type { Argv } from 'yargs';
import { DEFERRED_PATHS } from '../core/config.js';
import type { Package } from '../core/package.js';
import type { Repository } from '../core/repository.js';
import { applyRootOption, readRootOption } from '../utils/package-filter.js';

export function initCli(repository: Repository, program: Argv) {
  program.command({
    command: 'config',
    describe: 'Prints the effective .rmanrc config for the package of the current directory',
    builder: cmd =>
      applyRootOption(cmd, 'Print the config for')
        .example('$0 config', '# The config of the package you are standing in')
        .example('$0 config --root', "# The repository root's own config instead")
        .example('$0 config --json | jq .version', '# Machine-readable')
        .option('json', {
          describe: 'Print as JSON instead of YAML - nothing else on stdout, so it can be piped.',
          type: 'boolean',
          default: false,
        }),
    handler: args => {
      const target = (!readRootOption(args) && repository.currentPackage) || repository.rootPackage;

      if (args.json) {
        console.log(JSON.stringify(target.config, undefined, 2));
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
      const comment = (text: string) => (process.stdout.isTTY ? colors.gray(text) : text);
      const relativeDir = path.relative(repository.dirname, target.dirname) || '.';
      console.log(comment(`# ${target.name} (${relativeDir})`));
      for (const note of deferredNotes(target)) console.log(comment(`# ${note}`));
      /** `noRefs`: a value appearing twice in the config is the *same object* after merging, and
       *  js-yaml would otherwise emit the second as an `*anchor` reference - valid YAML that reads
       *  as a mistake in something meant to be looked at. */
      console.log(yaml.dump(target.config, { noRefs: true, lineWidth: 100 }).trimEnd());
    },
  });
}

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

function valueAt(config: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<any>((node, key) => (node == null ? undefined : node[key]), config);
}
