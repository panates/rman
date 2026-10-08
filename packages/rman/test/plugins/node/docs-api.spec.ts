import { expect } from 'expect';
import { nodePreset } from '../../../src/builtins/presets/node.js';
import type { NodeConfigKeys, ParsedWorkspaceRange, RmanNodeConfig } from '../../../src/index.js';
import {
  CiService,
  CleanService,
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
    const config: RmanNodeConfig = { packageManager: { node: 'npm' } };
    const keys: NodeConfigKeys = {};
    const range: ParsedWorkspaceRange = { selector: 'explicit', range: '^1.0.0' };
    expect([config.packageManager?.node, keys, range.selector]).toEqual(['npm', {}, 'explicit']);
  });

  /**
   * **The preset is a config, and that is what makes it a preset rather than a bare platform.**
   *
   * It carries the three kinds of contribution the page's opening table lists, which is what
   * `extends: "rman:node"` - and the default layer that names it - has to deliver: a technology
   * alone would bring the manifest reader and leave `rman clean` an unknown argument.
   *
   * Asserted on the shape rather than the instances, since the instances are deliberately not
   * exported.
   */
  it('contributes a technology, commands and a publish target, as one config', () => {
    const config = nodePreset();
    expect(Object.keys(config).sort()).toEqual(['commands', 'platforms', 'publishTargets']);
    expect(config.platforms).toHaveLength(1);
    expect(config.publishTargets).toHaveLength(1);
    /** `ci` and `clean` - the two commands the node preset brings, `publish` being the core's.
     *  Declarative factories, so their names come from calling them, which needs an application;
     *  the count is what this case can see. */
    expect(config.commands).toHaveLength(2);
  });

  /**
   * **A function, not a value, and that is the line between shipped and always on.** Building the
   * preset augments the core's `SystemInfo` in place; were that to happen at import, `rman info`
   * would report npm's tooling in a repository whose own technology is something else.
   *
   * **And its contributions are identical across calls**, which a preset that is laid down by
   * default *and* nameable in `extends` needs: the contribution keys de-duplicate by identity, so
   * two `NpmPublishTarget` instances reached `publish` and tripped its own collision guard.
   */
  it('builds the same contributions however often it is asked', () => {
    const a = nodePreset();
    const b = nodePreset();
    expect((a.publishTargets as unknown[])[0]).toBe((b.publishTargets as unknown[])[0]);
    expect((a.platforms as unknown[])[0]).toBe((b.platforms as unknown[])[0]);
    expect((a.commands as unknown[])[0]).toBe((b.commands as unknown[])[0]);
  });
});
