import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * **Where the presets are.** `ConfigReader` resolves `extends: "rman:<name>"` against this.
 */
/* **The directory says where it is, rather than the reader computing a path to it.** It was
 * `path.resolve(dirname(config-reader), '..', 'presets')` - two relative hops between two files
 * that nothing keeps in step, and moving either one breaks it silently at *runtime*: measured, the
 * `core/config/` + `builtins/presets/` reorganization left every repository answering
 * `"presets" has no preset "node". rman ships: node.` - a message that named the preset it had
 * just failed to find, because the list behind it was a hardcoded `['node']` somewhere else again.
 * `tsc` cannot see a path built with `path.resolve`, so only a run says. */
export const PRESETS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Every preset rman ships, read off the directory rather than written down again. */
/* One `readdirSync`, on an error path only - `_resolvePreset` asks after a lookup already failed.
 * Reading the directory is what keeps the message true: the hardcoded list it replaces could say
 * `node` while `node.js` was not where the resolver looked. `index` is this file. */
export function presetNames(): string[] {
  try {
    return [
      ...new Set(
        fs
          .readdirSync(PRESETS_DIR)
          .filter(f => /\.(js|ts)$/.test(f) && !/\.d\.ts$/.test(f))
          .map(f => f.replace(/\.(js|ts)$/, ''))
          .filter(n => n !== 'index'),
      ),
    ].sort();
  } catch {
    return [];
  }
}

/**
 * **The presets rman ships, laid underneath every repository's own config.**
 *
 * A repository writing nothing at all still gets these, exactly as if its `.rmanrc` had opened with
 * `extends: ['rman:node']` - so `rman list` finds the workspace and `rman clean` exists without a
 * config file having to say so. A repository naming one itself changes nothing: the key appends, and
 * a technology already present by name is skipped.
 */
/* **Names, not imports, and that is load-bearing rather than tidy.** A preset's module pulls in a
 * platform, its commands and its services, and one of those services extends a core service - so a
 * static import from `core/` closes the cycle that stopped the *built* CLI dead on every command
 * (`Cannot access 'VersionPlanService' before initialization`, invisible to the suite, which is why
 * `npm run smoke` exists). `ConfigReader` resolves these through the same dynamic `import()` an
 * `extends: "rman:node"` goes through, so this file stays a list of strings and imports nothing.
 *
 * **This replaced detection**, which asked each built-in "is this directory yours?" before turning
 * anything on, and merged the matching preset underneath. What that bought was a repository not
 * growing a technology's commands unasked; what it cost was a catalogue module, a `Builtin` type, a
 * per-directory memo and a gate that had to decide what counts as having "said something". The
 * platform answers the same question now - `manifestProvider.read` is what detection asked - and it
 * answers it from the ordinary registry, once loaded. The cost, stated rather than hidden: a
 * repository of some other technology carries node's `clean` and `ci` in `rman --help`, and
 * `rman info` reports npm's tooling. Split this list's presets in two - the platform apart from the
 * commands - if that ever stops being acceptable. */
export const DEFAULT_PRESETS: readonly string[] = ['node'];
