import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import type { Package } from '../../../core/classes/package.js';
import type { ManifestProvider } from '../../../core/interfaces/manifest.js';
import { Manifest } from '../../../core/interfaces/manifest.js';
import { stampVersionConstant } from '../../../utils/version-stamp.js';
import { npmViewVersion } from '../../publish-targets/npm/npm-view.js';
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
   * A peer marked `"optional": true` in `peerDependenciesMeta` is **not** an edge: an optional peer
   * is by definition one the package works without, so it states no order. It still counts where
   * another field declares it too - the fields are read together, and `devDependencies` naming it
   * is a real build-time need whatever the peer block says.
   *
   * Matched by name, which is npm's own identifier and unique by construction; an ecosystem where
   * that does not hold resolves its own way, which is why this is the provider's job.
   */
  /* **Measured on `panates/opra`, which is why the second half of that rule is written out.**
   * Seven of its edges are optional peers, and *every one* of them is also a `devDependencies`
   * entry - so excluding optional peers removed no edge at all, and the `@opra/cli` <-> `@opra/api-ui`
   * cycle that was destroying its build order stood untouched. Reading the peer block alone would
   * have looked like a fix and changed nothing. */
  dependencies(manifest: Manifest, candidates: readonly Package[]): Package[] {
    const optionalPeers = this.optionalPeerNames(manifest);
    const byName = new Map(candidates.map(p => [p.name, p]));
    const result: Package[] = [];
    for (const key of DEPENDENCY_KEYS) {
      const declared = manifest.raw[key];
      if (!declared || typeof declared !== 'object') continue;
      for (const name of Object.keys(declared)) {
        if (key === 'peerDependencies' && optionalPeers.has(name)) continue;
        const pkg = byName.get(name);
        if (pkg && !result.includes(pkg)) result.push(pkg);
      }
    }
    return result;
  }

  /** `dependencies`, `optionalDependencies` and the peers that are not optional - everything but
   *  what only a developer of the package installs. */
  runtimeDependencies(manifest: Manifest, candidates: readonly Package[]): Package[] {
    const optionalPeers = this.optionalPeerNames(manifest);
    const byName = new Map(candidates.map(p => [p.name, p]));
    const result: Package[] = [];
    for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const declared = manifest.raw[key];
      if (!declared || typeof declared !== 'object') continue;
      for (const name of Object.keys(declared)) {
        if (key === 'peerDependencies' && optionalPeers.has(name)) continue;
        const pkg = byName.get(name);
        if (pkg && !result.includes(pkg)) result.push(pkg);
      }
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
   * Every field naming `dependency`, with npm's answer to whether its range accepts `version` and
   * the range with its floor raised to it - see `ManifestProvider.referencesTo`.
   *
   * A bare `"workspace:*"`/`"^"`/`"~"` is `dynamic`: it already follows the sibling, so there is
   * nothing to keep or raise. An explicit `"workspace:<range>"` is judged by the range after it.
   */
  referencesTo(manifest: Manifest, dependency: string, version: string): ManifestProvider.Reference[] {
    const refs: ManifestProvider.Reference[] = [];
    for (const field of DEPENDENCY_KEYS) {
      const declared = manifest.raw[field]?.[dependency];
      if (typeof declared !== 'string') continue;
      const workspace = parseWorkspaceRange(declared);
      if (workspace && workspace.selector !== 'explicit') {
        refs.push({ field, range: declared, dynamic: true, accepts: true });
        continue;
      }
      const range = workspace ? workspace.range! : declared;
      const prefix = workspace ? 'workspace:' : '';
      const accepts = semver.satisfies(version, range);
      const raised = this.raiseFloor(range, version);
      const rewritten = accepts ? undefined : this.moveRange(range, version);
      refs.push({
        field,
        range: declared,
        accepts,
        ...(raised === null ? { unraisable: true } : raised ? { raised: prefix + raised } : {}),
        ...(rewritten ? { rewritten: prefix + rewritten } : {}),
      });
    }
    return refs;
  }

  setReference(manifest: Manifest, field: string, dependency: string, range: string): void {
    const deps = manifest.raw[field];
    if (deps && typeof deps === 'object') deps[dependency] = range;
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

  /**
   * `range` moved to accept a `version` it does not: `^1.1.4` -> `^2.0.0`, `~1.1.4` -> `~2.0.0`, a
   * pinned `1.1.4` -> `2.0.0`, and `>=1.1.0 <2` -> `>=2.0.0 <3` - a window spanning one major moves
   * to the next. `undefined` for any other shape: `||`, a hyphen range, an upper bound that is not
   * the next major.
   */
  /* **Moved rather than refused**, which is what `keep` first did - and measured wrong on
   * `panates/syncbridge`: `@syncbridge/common` went 1.1.4 -> 2.0.0 and four packages of its own
   * group, every one already planned for 2.0.0, were refused for `^1.1.4`. A range that no longer
   * accepts its sibling has to change whatever the setting says; `keep` is about the ranges that
   * still do. Only a shape this can move without guessing is moved - the rest still refuse. */
  protected moveRange(range: string, version: string): string | undefined {
    const r = range.trim();
    const v = semver.parse(version);
    if (!v) return undefined;
    if (semver.valid(r)) return version;
    const caret = /^([\^~])\s*v?\d[^\s|]*$/.exec(r);
    if (caret) return `${caret[1]}${version}`;
    const bounded = /^>=\s*v?(\d\S*)\s+<\s*v?(\d+)(\.0(\.0)?)?$/.exec(r);
    if (bounded) {
      const floor = semver.coerce(bounded[1]);
      if (floor && Number(bounded[2]) === floor.major + 1) return `>=${version} <${v.major + 1}${bounded[3] ?? ''}`;
    }
    return undefined;
  }

  /**
   * `range` with its lower bound moved up to `version`, keeping its upper bound and its operator -
   * `undefined` when the floor is already at or above it, `null` for a shape with no single floor
   * to move.
   *
   * The shapes a hand-written range takes: `^a`, `~a`, `>=a`, `>=a <b` (or `<=b`) and `a - b`. An
   * exact pin never needs moving - one that accepts `version` already is it.
   */
  /* **`null` rather than a guess for anything else**, `||` above all: which alternative's floor is
   * meant cannot be read off the range, and rewriting the wrong one changes what it accepts.
   * `version` reports it instead, so the range can be raised by hand. */
  protected raiseFloor(range: string, version: string): string | null | undefined {
    const r = range.trim();
    let floor: semver.SemVer | null;
    try {
      floor = semver.minVersion(r);
    } catch {
      return null;
    }
    if (!floor) return null;
    if (semver.lte(version, floor)) return undefined;
    if (semver.valid(r)) return undefined;
    const caret = /^([\^~])\s*v?\d[^\s|]*$/.exec(r);
    if (caret) return `${caret[1]}${version}`;
    if (/^>=\s*v?\d\S*$/.test(r)) return `>=${version}`;
    const bounded = /^>=\s*v?\d\S*\s+(<=?\s*v?\d\S*)$/.exec(r);
    if (bounded) return `>=${version} ${bounded[1]}`;
    const hyphen = /^v?\d\S*\s+-\s+(v?\d\S*)$/.exec(r);
    if (hyphen) return `${version} - ${hyphen[1]}`;
    return null;
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

  /** The peers this manifest marks `"optional": true`, which `dependencies` leaves out of the
   *  graph. `optionalDependencies` is deliberately *not* read the same way: an optional peer says
   *  "works without it", while an optional dependency is one the package means to use and may fail
   *  to install. */
  protected optionalPeerNames(manifest: Manifest): Set<string> {
    const meta = manifest.raw.peerDependenciesMeta;
    if (!meta || typeof meta !== 'object') return new Set();
    return new Set(Object.keys(meta).filter(name => meta[name]?.optional === true));
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
