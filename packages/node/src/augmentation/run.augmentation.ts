import parseNpmScript from '@netlify/parse-npm-script';
import { type Package, RunService } from 'rman';

/**
 * Teaches `run` about `package.json#scripts`.
 *
 * rman's core resolves a script from `.rmanrc` alone - `before`/`exec`/`after`. That a script might
 * *also* live in `package.json`, that `prebuild` and `postbuild` run around `build`, and that
 * `a && b` is two steps rather than one, are all facts about npm, so they are here.
 *
 * Registered as a `RunService` step source rather than by wrapping anything: the npm part of `run`
 * is inside step resolution, not at its entry point, so there is nothing a wrapper could reach.
 * The core decides what to do with what this returns - see `getScriptSteps` for the precedence.
 */
export const packageJsonSteps: RunService.StepSource = (pkg: Package, script: string) => {
  const scripts = pkg.manifest.raw?.scripts;
  if (!scripts || typeof scripts !== 'object') return undefined;

  const declared = (name: string): boolean => typeof scripts[name] === 'string' && !!scripts[name];
  if (!declared(script) && !declared('pre' + script) && !declared('post' + script)) return undefined;

  /**
   * `parseNpmScript` expands npm's own lifecycle - `pre<script>`, the script, `post<script>` - and
   * splits each on `&&` into the commands npm would run in sequence. The placeholder matters: it
   * asks for a script the package may not declare itself (it may have only a `prebuild`), and
   * without something there the parser reports the whole chain as absent.
   */
  const json = { ...pkg.manifest.raw, scripts: { ...scripts } };
  json.scripts[script] = json.scripts[script] || PLACEHOLDER;

  const info = parseNpmScript(json, 'npm run ' + script);
  if (!info?.raw?.length) return undefined;

  const slots: RunService.ScriptSlots = { before: [], exec: [], after: [] };
  for (const step of info.steps) {
    const slot = slotOf(step.name, script);
    if (!slot) continue;
    for (const command of Array.isArray(step.parsed) ? step.parsed : [step.parsed]) {
      if (command === PLACEHOLDER) continue;
      slots[slot]!.push(command);
    }
  }
  return slots;
};

/** npm's lifecycle names, mapped onto rman's three slots. */
function slotOf(stepName: string, script: string): keyof RunService.ScriptSlots | undefined {
  if (stepName === 'pre' + script) return 'before';
  if (stepName === script) return 'exec';
  if (stepName === 'post' + script) return 'after';
  return undefined;
}

/** Stands in for a script the package does not declare. `#` is a shell comment, so were it ever to
 *  reach a shell it would do nothing - but it is filtered out above instead. */
const PLACEHOLDER = '#';
