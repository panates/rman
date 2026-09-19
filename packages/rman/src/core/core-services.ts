import { ChangelogService } from '../services/changelog.service.js';
import { ExecService } from '../services/exec.service.js';
import { ImportService } from '../services/import.service.js';
import { ListService } from '../services/list.service.js';
import type { RmanApplication } from './application.js';

/**
 * Every service the core brings, registered as an application is built.
 *
 * **Factories rather than instances**, so nothing is constructed until something asks: `rman info`
 * has no business building the changelog or release services, and services reach each other through
 * the application, so resolving at call time is also what keeps that from being a construction
 * cycle.
 *
 * Here rather than inside `RmanApplication` so the composition list is one readable file, and so
 * the application itself imports no service - only this does. A plugin adds its own the same way,
 * from its own package, with `app.setService`.
 */
export function registerCoreServices(app: RmanApplication): void {
  app.setService('changelog', a => new ChangelogService(a));
  app.setService('exec', a => new ExecService(a));
  app.setService('import', a => new ImportService(a));
  app.setService('list', a => new ListService(a));
}
