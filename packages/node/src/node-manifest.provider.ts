import fs from 'node:fs';
import path from 'node:path';
import { Manifest, type ManifestProvider, type Package, stampVersionConstant } from 'rman';
import { npmViewVersion } from './utils/npm-view.js';
import { parseWorkspaceRange } from './utils/workspace-range.js';

export class NodeManifestProvider implements ManifestProvider {
  name = 'node';
  fileName = 'package.json';

  read(dir: string): Manifest | undefined {
    const file = path.join(dir, 'package.json');
    if (!fs.existsSync(file)) return undefined;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return {
      /** A `package.json` with no `name` is unusual but legal, and `info` prints such a package
       *  rather than refusing it - so the directory name stands in, as it does for a package with
       *  no manifest at all. */
      name: typeof raw?.name === 'string' && raw.name ? raw.name : path.basename(dir),
      version: typeof raw?.version === 'string' && raw.version ? raw.version : '0.0.0',
      private: !!raw?.private,
      raw: raw ?? {},
    };
  }

  /**
   * npm's four dependency fields, and only the entries naming a package of this repository -
   * an external dependency is not an edge in rman's graph.
   *
   * Matched by name, which is npm's own identifier and unique by construction; an ecosystem where
   * that does not hold resolves its own way, which is why this is the provider's job.
   */
  dependencies(manifest: Manifest, candidates: readonly Package[]): Package[] {
    const declared = Object.assign({}, ...DEPENDENCY_KEYS.map(key => manifest.raw[key]));
    const byName = new Map(candidates.map(p => [p.name, p]));
    const result: Package[] = [];
    for (const name of Object.keys(declared)) {
      const pkg = byName.get(name);
      if (pkg && !result.includes(pkg)) result.push(pkg);
    }
    return result;
  }

  /** npm's `@scope/name`. A name with no `/` has no scope and is its own unscoped form; the
   *  *last* `/` splits it, so `@scope/a/b` keeps `@scope/a` as the scope the registry would. */
  splitName(name: string): { scope?: string; unscopedName: string } {
    const at = name.lastIndexOf('/');
    return at > 0 ? { scope: name.slice(0, at), unscopedName: name.slice(at + 1) } : { unscopedName: name };
  }

  /**
   * Rewrites a sibling's range in all four fields after it was bumped.
   *
   * **A bare `"workspace:*"`/`"^"`/`"~"` selector is left alone**, and that is the load-bearing
   * case: it resolves to the dependency's *current* version at publish time (see
   * `resolveWorkspaceRange`), so rewriting it would replace a live reference with a frozen one.
   * Only an explicit version after `workspace:` needs bumping, like a plain range.
   */
  updateDependencyVersions(manifest: Manifest, bumped: ReadonlyMap<Package, string>): void {
    const versionByName = new Map([...bumped].map(([pkg, version]) => [pkg.name, version]));
    for (const depKey of DEPENDENCY_KEYS) {
      const deps = manifest.raw[depKey];
      if (!deps) continue;
      for (const depName of Object.keys(deps)) {
        const to = versionByName.get(depName);
        if (!to) continue;
        const workspace = parseWorkspaceRange(deps[depName]);
        if (workspace) {
          if (workspace.selector === 'explicit') deps[depName] = `workspace:^${to}`;
          continue;
        }
        deps[depName] = '^' + to;
      }
    }
  }

  /**
   * What the npm registry says this package's current version is - used *only* by
   * `detectChangeHash`, to guess a tag name for a package that has no git tag yet. See
   * `Plugin.publishedVersion` for why that is not a "has this been published" check.
   *
   * No `--registry`/`--userconfig`: a bare `npm view` run in the package's own directory already
   * honours the repository's `.npmrc`, and the flags exist for `publish`'s CLI overrides, which
   * this path has none of.
   */
  publishedVersion(pkg: Package): Promise<string | undefined> {
    return npmViewVersion(pkg.name, pkg.dirname);
  }

  /**
   * npm's source shape: a quoted string assigned to an identifier, which is what a `.ts`/`.js`
   * version constant looks like. `constant` comes from the repository's own `version.stamp` entry,
   * for a file whose identifier is not literally `version`.
   *
   * One line, because `stampVersionConstant` is exported for it - the *pattern* is shared by most
   * languages, while *choosing* it is this ecosystem's call. A provider for a format with no
   * identifier at all (a `pom.xml`) would ignore `constant` and match its own way.
   */
  stampVersion(file: string, content: string, version: string, options?: { constant?: string }) {
    return stampVersionConstant(content, version, options?.constant);
  }

  write(dir: string, manifest: Manifest): void {
    /**
     * The version is written back into `raw` before serializing, because `raw` is the document and
     * `manifest.version` is rman's view of one field in it. Writing only the view would produce a
     * file whose `version` never changed; writing only `raw` would leave the two disagreeing for
     * anything still holding the manifest.
     */
    const raw = { ...manifest.raw, version: manifest.version };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(raw, undefined, 2) + '\n', 'utf-8');
  }
}

/**
 * `package.json` as rman's manifest: where an npm package's name and version are written.
 *
 * This is the deepest npm assumption that used to be in rman's core - `Package.name`,
 * `Package.version`, `Package.json` and `Package.isPrivate` all read this file directly, which
 * meant every command that asked a package what it was called was asking npm.
 *
 * The version scheme is left unset, so packages get the core's semver default: npm versions *are*
 * semver, and saying so again here would only be a second place for the two to disagree.
 */
export const packageJsonManifest = {} satisfies Partial<Plugin>;

/** npm's four dependency fields. Was `rman`'s `DEPENDENCY_KEYS`, which made the core carry npm's
 *  field names - `publish` imports it from here now. */
export const DEPENDENCY_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
