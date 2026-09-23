import { expect } from 'expect';
import type { NodeConfigKeys, ParsedWorkspaceRange, RmanNodeConfig } from '../../../src/index.js';
import {
  BUILTIN_PLUGINS,
  CiService,
  CleanService,
  isBuiltinPlugin,
  NodeVersionPlanService,
  NPM_TARGET,
  NpmPublishTarget,
  PublishService,
} from '../../../src/index.js';

/**
 * **What `docs/node.md` claims this package exports, checked against what it does.**
 *
 * rman's own [`docs-api.spec.ts`](../../rman/test/docs-api.spec.ts) does this for `docs/rman.md`,
 * and the absence of a counterpart here is exactly what it cost: that page's Installation block
 * advertised **fourteen** names the package had stopped exporting - `nodePlugin`, `nodeTechStack`,
 * `augmentTechStack`, `npmPublishTarget`, `packageJsonManifest`, `npmWorkspace`,
 * `packageJsonSteps`, `npmBinPaths`, `nodeVersionPlanner`, `DEPENDENCY_KEYS`,
 * `parseWorkspaceRange`, `resolveWorkspaceRange`, `augmentSystemInfo`, `defineConfig` - and
 * nothing noticed, because nothing looked. mocha transpiles without type-checking, and no spec
 * imported the names the page names.
 *
 * Checked by `npm run typecheck`; the assertion only keeps mocha from reporting an empty file.
 *
 * **A floor, not a contract.** A name removed from the package fails here at compile time, which is
 * the point. A name *added* does not - so keep this in step with the page's import block by hand,
 * and prefer keeping both short: the entry point exports what a *user* needs, and this package's
 * own specs reach everything else by file path rather than through `index.ts`.
 */
describe('docs/node.md: the documented API surface', () => {
  it('exports every value its Installation block imports', () => {
    for (const exported of [CiService, CleanService, NodeVersionPlanService, NpmPublishTarget, PublishService]) {
      expect(exported).toBeDefined();
    }
    /** A const rather than a class, and the name `publish --target` matches against. */
    expect(NPM_TARGET).toBe('npm');
  });

  /**
   * The types the page names, used rather than merely imported - an unused type import is elided
   * before the compiler can disagree with it.
   */
  it('exports the types its Installation block imports', () => {
    const config: RmanNodeConfig = { packageManager: 'npm' };
    const keys: NodeConfigKeys = { packageManager: 'pnpm' };
    const range: ParsedWorkspaceRange = { selector: 'explicit', range: '^1.0.0' };
    expect([config.packageManager, keys.packageManager, range.selector]).toEqual(['npm', 'pnpm', 'explicit']);
  });

  /**
   * **The central claim, and what the fold changed about it: the built-in is a *config*, not a
   * bare plugin.**
   *
   * It carries the three kinds of contribution the page's opening table lists, which is what
   * `plugins: ['node']` has to deliver for it to replace the `extends: 'rman-node'` a Node
   * repository used to be required to write - a technology alone would bring the manifest reader
   * and leave `rman clean` an unknown argument.
   *
   * Asserted on the shape rather than the instances, since the instances are deliberately not
   * exported.
   */
  it('contributes a plugin, commands and a publish target, as one config', () => {
    const config = BUILTIN_PLUGINS.node!();
    expect(Object.keys(config).sort()).toEqual(['commands', 'plugins', 'publishTargets']);
    expect(config.plugins).toHaveLength(1);
    expect(config.publishTargets).toHaveLength(1);
    /** `ci` and `clean` - the two commands the node built-in brings, `publish` being the core's.
     *  Declarative factories, so their names come from calling them, which needs an application;
     *  the count is what this case can see. */
    expect(config.commands).toHaveLength(2);
  });

  /**
   * **A function, not a value, and that is the line between bundled and always on.** Registering
   * the built-in augments the core's `SystemInfo` in place; were that to happen at import, `rman
   * info` would report npm's tooling in a repository that never named the built-in.
   */
  it('does nothing until it is asked for', () => {
    expect(typeof BUILTIN_PLUGINS.node).toBe('function');
    expect(isBuiltinPlugin('node')).toBe(true);
    /** A published package name is not a built-in - it reaches a repository through `extends`. */
    expect(isBuiltinPlugin('rman-node')).toBe(false);
  });
});
