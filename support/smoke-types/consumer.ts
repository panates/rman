/**
 * **What a consumer's compiler sees**, checked against the *built* package rather than against
 * `src`.
 *
 * rman's own `npm run typecheck` cannot answer this. `packages/rman/test/tsconfig.json` includes
 * `../src/**` /*'*'/ `*.ts`, so every source file is in the program - the node plugin's
 * `declare module` augmentation among them, whether or not anything imports it. A spec asserting
 * that `clean` is typed therefore passes either way: measured, deleting the import that makes it
 * reach a consumer left `npm run typecheck` completely clean.
 *
 * So this file resolves `rman` to `packages/rman/build/index.d.ts` and to nothing else. It is the
 * only place that can tell whether a key exists *for someone outside this repository*.
 *
 * Measured on the real consumer it was written for, `@panates/rman-node`: ten errors across its
 * config and its own suite - `'clean' does not exist in type 'RmanConfig'` and
 * `Property 'npm' does not exist` among them - against a build whose own typecheck was green.
 */
import type { RmanConfig, RmanNodeConfig } from 'rman';
import { Repository, Workspace } from 'rman';

/** **The core's own keys**, contributed by the commands that read them (`commands.ts`). */
const core: RmanConfig = {
  plugins: ['node'],
  platform: 'node',
  name: 'web',
  version: { commitMessage: 'chore: release' },
  publish: { target: ['npm'] },
};

/** **The `node` built-in's keys**, which arrive by augmentation - the half that was missing. */
const node: RmanConfig = {
  clean: { include: ['build'], exclude: '*.log' },
  publish: { npm: { directory: 'build' } },
};

/** The authoring alias a config package annotates with, still exported under its own name. */
const authored: RmanNodeConfig = { ...core, ...node };

/** And the two values a consumer reaches for by name, so a missing *runtime* export fails here too
 *  rather than at someone's first import. */
export const surface = [typeof Repository.create, typeof Workspace.walk, core, node, authored];
