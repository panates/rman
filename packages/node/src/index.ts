import './augmentation/rman.augmentation.js';
import { augmentSystemInfo } from './augmentation/system-info.augmentation.js';
import ciCommand from './commands/ci.command.js';
import cleanCommand from './commands/clean.command.js';
import { defineConfig } from './interfaces/rman-config.interface.js';
import { NodePlugin } from './node-plugin.js';
import { NpmPublishTarget } from './npm-publish-target.js';

export type { NodeConfigKeys, RmanNodeConfig } from './interfaces/rman-config.interface.js';
export { NPM_TARGET, NpmPublishTarget } from './npm-publish-target.js';
export { CiService } from './services/ci.service.js';
export { CleanService } from './services/clean.service.js';
export { PublishService } from './services/publish.service.js';
export { NodeVersionPlanService } from './services/version-plan.service.js';
export type { ParsedWorkspaceRange } from './utils/workspace-range.js';

/** The version this package reports. Rewritten into `build/index.js` by `support/postbuild.cjs`. */
export const version = '1';

augmentSystemInfo();

export default defineConfig({
  plugins: [new NodePlugin()],
  commands: [ciCommand, cleanCommand],
  publishTargets: [new NpmPublishTarget()],
});
