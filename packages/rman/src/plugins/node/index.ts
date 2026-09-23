import './augmentation/rman.augmentation.js';
import type { RmanConfig } from '../../interfaces/rman-config.interface.js';
import { augmentSystemInfo } from './augmentation/system-info.augmentation.js';
import ciCommand from './commands/ci.command.js';
import cleanCommand from './commands/clean.command.js';
import { NodePlugin } from './node.plugin.js';
import { NpmPublishTarget } from './npm-publish-target.js';

/**
 * **The `node` built-in, as the config it contributes** - its technology, its two commands and its
 * publish target, which is exactly what `extends: 'rman-node'` used to deliver.
 *
 * A *config* rather than a bare `Plugin`, and that distinction is the whole reason `plugins: ['node']`
 * can replace an `extends`: a technology alone would bring the manifest reader and leave `rman clean`
 * an unknown argument.
 *
 * **A function, so nothing here happens until a repository asks for it.** `augmentSystemInfo()`
 * mutates the core's own `SystemInfo` in place, so calling it at import time would have `rman info`
 * report npm's tooling in a Cargo repository that never named this built-in - which is the shape of
 * "bundled" quietly becoming "always on". The type-only augmentation above is imported eagerly
 * because a type costs nothing at runtime and a config author's editor wants it either way.
 */
export function nodeBuiltin(): RmanConfig {
  augmentSystemInfo();
  return {
    plugins: [new NodePlugin()],
    commands: [ciCommand, cleanCommand],
    publishTargets: [new NpmPublishTarget()],
  };
}
