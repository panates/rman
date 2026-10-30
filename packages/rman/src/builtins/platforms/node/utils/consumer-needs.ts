import type { Package } from '../../../../core/classes/package.js';

/** Whether a consumer installing `pkg` needs `name` to resolve: a `dependencies` entry, or a peer
 *  not marked optional. */
/* **Not every edge blocks a publish**, and blocking on all of them cost a release. A failed publish
 * stops its dependents because their published range would point at a version that is not there -
 * which is only true of what reaches the consumer:
 * - `devDependencies` are removed from the published manifest (`derivePublishManifest`);
 * - an optional peer that cannot be satisfied does not fail an install;
 * - `optionalDependencies` are the ones npm proceeds without "if it cannot be found or fails to
 *   install" (npm's own documentation; not measured here).
 * Measured on opra's 1.31.0 release: `@opra/api-ui` failed its first publish, and `@opra/http` -
 * which lists it as an optional peer and a devDependency only - was blocked, taking elastic, mongodb
 * and sqb with it, though none of their installs would have needed api-ui. */
export function consumerNeeds(pkg: Package, name: string): boolean {
  const raw = pkg.manifest.raw;
  if (raw.dependencies?.[name] !== undefined) return true;
  return raw.peerDependencies?.[name] !== undefined && !raw.peerDependenciesMeta?.[name]?.optional;
}
