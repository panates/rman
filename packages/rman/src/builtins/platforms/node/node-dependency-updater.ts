import fs from 'node:fs';
import path from 'node:path';
import colors from 'ansi-colors';
import micromatch from 'micromatch';
import semver from 'semver';
import type { Package } from '../../../core/classes/package.js';
import { DependencyUpdater } from '../../../core/interfaces/dependency-updater.js';
import { Manifest } from '../../../core/interfaces/manifest.js';
import { exec } from '../../../utils/exec.js';
import { type NpmRelease, type NpmReleases, npmViewReleases } from '../../publish-targets/npm/npm-view.js';
import { DEPENDENCY_KEYS } from './node-manifest.provider.js';
import { CiService } from './services/ci.service.js';
import { parseWorkspaceRange } from './utils/workspace-range.js';

/**
 * npm's answer to `rman deps`: which of a `package.json`'s dependencies have a newer version on the
 * registry, and which of those can be taken without breaking a rule another dependency states.
 *
 * Only a caret or tilde range on a plain version moves (`^1.2.3`, `~1.2.3`), keeping its prefix. An
 * exact version, a compound range (`>=1 <2`, `a || b`), a dist-tag, a URL, an alias and an in-repo
 * package are left as they are - but every one of them still counts as a rule the others must keep.
 */
/* **The default is the policy every `.ncurc.yml` in this organization wrote by hand.** Twenty
 * repositories carried the same `rejectVersion: "/(\|\|)|(&&)|>|<|^[0-9]/"` - no `||`, no `&&`, no
 * comparator, no bare version - which leaves exactly a `^` or `~` range. Built in, it is a line
 * nobody has to copy.
 *
 * **What a version has to get past, in order**, and only the last two depend on what else moves:
 *
 * 1. the package's own settings - `deps.target`, `reject`, `minAge`, and the registry: deprecated,
 *    above the `latest` dist-tag, or a prerelease when the range is not on one;
 * 2. the package's own other declarations of the same name - a `devDependencies` caret cannot move
 *    outside the package's own `peerDependencies` range for that name;
 * 3. the runtime: a version whose `engines.node` does not cover every Node the package supports;
 * 4. the peer ranges of the other dependencies the package names, at the versions *they* move to;
 * 5. a sibling package's peer range, for a package naming that sibling.
 *
 * Steps 4 and 5 are solved together: everything starts at its newest candidate, and while any rule
 * is broken one side of it steps down. A version only ever steps down and never below what is
 * declared now, so it ends. A rule broken by two versions neither of which moved is the
 * repository's existing state and is not this command's to fix.
 *
 * **Peer ranges are what `npm-check-updates`' `peer: true` checked**, which every `.ncurc.yml` here
 * turned on. It held a version back silently; this says which rule did.
 *
 * Out of sight, deliberately: a dependency's own dependency carrying a peer range. That is the
 * resolver's job, and `verify` asks the real one. */
export class NodeDependencyUpdater implements DependencyUpdater {
  /** `.rmanrc "deps.types"`'s short spellings, as `npm-check-updates` named them. The field names
   *  themselves are accepted too. */
  protected readonly kindAliases: Readonly<Record<string, string>> = {
    prod: 'dependencies',
    dev: 'devDependencies',
    optional: 'optionalDependencies',
    peer: 'peerDependencies',
  };

  /** The ranges that move: `^` or `~`, then a plain version. The prefix is kept on the rewrite. */
  protected readonly movablePattern: RegExp = /^([\^~])(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/;

  /** The plan each `'update'` entry was made from, for `applyPlan`. */
  protected readonly planned = new WeakMap<DependencyUpdater.Entry, NodeDependencyUpdater.Decision>();

  async getPlan(ctx: DependencyUpdater.Context, packages: readonly Package[]): Promise<DependencyUpdater.Entry[]> {
    const inRepo = new Set([ctx.repository.rootPackage, ...ctx.repository.packages].map(p => p.name));
    const decisions = packages.flatMap(pkg =>
      this.collect(pkg, DependencyUpdater.settingsFor(pkg, ctx.options), ctx.options, inRepo),
    );

    const withTime = decisions.some(d => d.settings.minAge > 0);
    const registry = await this.fetchAll(ctx, decisions, withTime);
    for (const d of decisions) this.prepare(d, registry.get(d.name));

    this.resolve(decisions, ctx);
    return decisions.filter(d => d.wanted).map(d => this.toEntry(d));
  }

  async applyPlan(
    ctx: DependencyUpdater.Context,
    plan: readonly DependencyUpdater.Entry[],
  ): Promise<DependencyUpdater.Applied> {
    const originals = new Map<Package, string>();
    for (const entry of plan) {
      const d = this.planned.get(entry);
      if (entry.status !== 'update' || !d) continue;
      const version = d.candidates[d.index]!;
      if (!originals.has(d.pkg)) originals.set(d.pkg, fs.readFileSync(this.manifestFile(d.pkg), 'utf-8'));
      for (const field of d.movable) {
        const deps = d.pkg.manifest.raw[field];
        deps[d.name] = this.movablePattern.exec(deps[d.name])![1] + version;
      }
    }
    for (const pkg of originals.keys()) Manifest.write(ctx.app, pkg.dirname, pkg.manifest);
    return {
      files: [...originals.keys()].map(pkg => this.manifestFile(pkg)),
      restore: () => {
        for (const [pkg, text] of originals) {
          fs.writeFileSync(this.manifestFile(pkg), text, 'utf-8');
          pkg.manifest.raw = JSON.parse(text);
        }
      },
    };
  }

  /**
   * `npm install --dry-run` at the repository root: npm's own resolver, which refuses a peer
   * conflict anywhere in the tree with `ERESOLVE`, and writes nothing.
   *
   * Another package manager is not asked - its dry run is not the same question - and a note says so.
   */
  /* Measured on a manifest pairing `typescript@^7` with `@typescript-eslint/parser@8.40.0`, whose
   * peer range stops below 6: `--dry-run` exits 1 with `ERESOLVE unable to resolve dependency tree`
   * and the offending `peer typescript@">=4.8.4 <6.0.0"` line, as `--package-lock-only` does, but
   * without touching the lockfile. */
  async verify(ctx: DependencyUpdater.Context): Promise<string | undefined> {
    const manager = CiService.resolvePackageManager(ctx.repository);
    if (manager !== 'npm') {
      console.error(colors.yellow(`Not verified: "${manager}" has no dry-run install to ask.`));
      return undefined;
    }
    const result = await exec('npm install --dry-run --ignore-scripts --no-audit --no-fund', {
      cwd: ctx.repository.dirname,
      app: ctx.app,
      throwOnError: false,
    });
    if (!result.code) return undefined;
    const lines = (result.stdout ?? '')
      .split('\n')
      .filter(line => /^npm (error|ERR!)/.test(line) && !/complete log|_logs/.test(line))
      .map(line => line.replace(/^npm (error|ERR!)\s?/, '  '))
      .filter(line => line.trim());
    return lines.slice(0, 20).join('\n') || `  npm install --dry-run exited ${result.code}`;
  }

  /** One decision per dependency name `pkg` declares, whether or not it may move - one that may not
   *  still states rules the others have to keep. */
  protected collect(
    pkg: Package,
    settings: DependencyUpdater.Settings,
    options: DependencyUpdater.Options,
    inRepo: ReadonlySet<string>,
  ): NodeDependencyUpdater.Decision[] {
    const kinds = settings.types?.map(t => this.kindAliases[t] ?? t);
    const byName = new Map<string, NodeDependencyUpdater.Decision>();
    for (const field of DEPENDENCY_KEYS) {
      const declared = pkg.manifest.raw[field];
      if (!declared || typeof declared !== 'object') continue;
      for (const [name, range] of Object.entries<unknown>(declared)) {
        if (typeof range !== 'string' || inRepo.has(name) || parseWorkspaceRange(range)) continue;
        let d = byName.get(name);
        if (!d) {
          d = {
            pkg,
            name,
            settings,
            fields: new Map(),
            movable: [],
            wanted: false,
            allowed: [],
            candidates: [],
            index: -1,
          };
          byName.set(name, d);
        }
        d.fields.set(field, range);
        if (this.movablePattern.test(range) && (!kinds || kinds.includes(field))) d.movable.push(field);
      }
    }
    for (const d of byName.values()) {
      const picked = !options.names?.length || micromatch.isMatch(d.name, options.names);
      const rejected = settings.reject.length > 0 && micromatch.isMatch(d.name, settings.reject);
      d.wanted = d.movable.length > 0 && picked && !rejected;
      if (d.wanted) {
        d.floor = d.movable.map(f => semver.minVersion(d.fields.get(f)!)!.version).sort(semver.rcompare)[0];
      }
    }
    return [...byName.values()];
  }

  /** Every name's releases, from the lowest version any declaration of it can mean - once per name,
   *  however many packages declare it, `concurrency` at a time. */
  protected async fetchAll(
    ctx: DependencyUpdater.Context,
    decisions: readonly NodeDependencyUpdater.Decision[],
    withTime: boolean,
  ): Promise<Map<string, NpmReleases | undefined>> {
    const floors = new Map<string, string>();
    for (const d of decisions) {
      for (const range of d.fields.values()) {
        const min = semver.validRange(range) ? semver.minVersion(range)?.version : undefined;
        if (!min) continue;
        const known = floors.get(d.name);
        if (!known || semver.lt(min, known)) floors.set(d.name, min);
      }
    }
    const names = [...floors.keys()];
    const result = new Map<string, NpmReleases | undefined>();
    let done = 0;
    await this.mapConcurrent(names, ctx.options.concurrency, async name => {
      result.set(name, await this.fetchReleases(name, `>=${floors.get(name)}`, ctx.repository.dirname, withTime));
      ctx.options.onProgress?.(++done, names.length);
    });
    return result;
  }

  /** The registry's answer about one name - the seam a spec replaces. */
  protected fetchReleases(
    name: string,
    range: string,
    cwd: string,
    withTime: boolean,
  ): Promise<NpmReleases | undefined> {
    return npmViewReleases(name, range, cwd, { withTime });
  }

  /** Fills in what `d` may move to, from its own settings and the rules that do not depend on what
   *  else moves (steps 1-3). */
  protected prepare(d: NodeDependencyUpdater.Decision, info: NpmReleases | undefined): void {
    d.releases = new Map((info?.releases ?? []).map(r => [r.version, r]));
    d.latestTag = info?.latest;
    if (!d.wanted) return;
    if (!info) {
      d.error = 'the registry gave no answer';
      return;
    }
    const newer = (info?.releases ?? [])
      .filter(r => this.offerable(d, r))
      .sort((a, b) => semver.rcompare(a.version, b.version));
    d.available = newer[0]?.version;
    d.allowed = newer.filter(r => !this.settingRefusal(d, r, info.time)).map(r => r.version);
    if (d.available && d.available !== d.allowed[0]) {
      d.skipReason = this.settingRefusal(d, newer[0]!, info.time);
    }

    d.baselineNode = this.nodeCoverage(d.pkg, d.releases.get(d.floor!));
    for (const version of d.allowed) {
      const refusal = this.staticRefusal(d, d.releases.get(version)!);
      if (!refusal) d.candidates.push(version);
      else if (version === d.allowed[0]) d.reason = `${version} refused: ${refusal}`;
    }
    d.index = d.candidates.length ? 0 : -1;
  }

  /** Whether the registry offers `release` as a move at all: newer than what is declared, not
   *  deprecated, not above the `latest` tag, and not a prerelease unless the range is on one. */
  protected offerable(d: NodeDependencyUpdater.Decision, release: NpmRelease): boolean {
    const v = semver.parse(release.version);
    const floor = semver.parse(d.floor!)!;
    if (!v || release.deprecated || !semver.gt(v, floor)) return false;
    if (d.latestTag && semver.valid(d.latestTag) && semver.gt(v, d.latestTag)) return false;
    return !v.prerelease.length || floor.prerelease.length > 0;
  }

  /** Step 1: why the package's own settings leave `release` out - `deps.target` or `deps.minAge` -
   *  or `undefined` when they do not. */
  protected settingRefusal(
    d: NodeDependencyUpdater.Decision,
    release: NpmRelease,
    time?: Record<string, string>,
  ): string | undefined {
    const sizes = d.pkg.versionScheme.bumpNames;
    const size = this.sizeOf(d.floor!, release.version);
    const target = DependencyUpdater.targetFor(d.settings, d.name);
    if (sizes.indexOf(size) > sizes.indexOf(target.size)) return `${size} - ${target.from} is "${target.size}"`;
    if (d.settings.minAge > 0) {
      const published = time?.[release.version];
      if (!published) return `no publish date to check deps.minAge against`;
      const days = Math.floor((Date.now() - Date.parse(published)) / 86_400_000);
      if (days < d.settings.minAge) return `published ${days} day(s) ago - deps.minAge is ${d.settings.minAge}`;
    }
    return undefined;
  }

  /**
   * How big a move from `from` to `to` is, **as npm's caret reads it**: anything a `^from` range
   * would not accept is a `major`, so `0.1.0 -> 0.2.0` is one.
   */
  /* `semver.diff` alone calls `0.1.0 -> 0.2.0` a minor, and under `deps.target: minor` that would
   * take a break the ecosystem itself treats as one - `^0.1.0` stops below `0.2.0` precisely
   * because a 0.x minor is allowed to break. */
  protected sizeOf(from: string, to: string): string {
    if (!semver.satisfies(to, `^${from}`, { includePrerelease: true })) return 'major';
    const diff = semver.diff(from, to) ?? 'patch';
    return diff.replace(/^pre(?!release)/, '') === 'prerelease' ? 'patch' : diff.replace(/^pre(?!release)/, '');
  }

  /** Steps 2 and 3: the package's own other declarations of this name, and the runtime it supports.
   *  The rule `release` breaks, or `undefined`. */
  protected staticRefusal(d: NodeDependencyUpdater.Decision, release: NpmRelease): string | undefined {
    for (const [field, range] of d.fields) {
      if (d.movable.includes(field) || !semver.validRange(range)) continue;
      if (!semver.satisfies(release.version, range, { includePrerelease: true })) {
        return `${d.pkg.name} declares ${d.name} ${range} in ${field}`;
      }
    }
    const covered = d.baselineNode;
    const needed = release.engines?.node;
    if (covered && needed && semver.validRange(needed) && !semver.subset(covered, needed)) {
      return `${d.name}@${release.version} needs node ${needed}, ${d.pkg.name} supports ${this.supportedNode(d.pkg)}`;
    }
    return undefined;
  }

  /**
   * The Node versions a newer release has to keep covering: those the package supports **and** the
   * lowest release its declaration allows now (`current`) already runs on.
   */
  /* **Not the package's whole range**, and that was measured wrong first. A package declaring
   * `node >=18` with `eslint ^9` was offered no 9.x at all, because every one of them needs
   * `^18.18.0` - but so does the 9.x it already installs. A rule the current version breaks is not
   * one a newer version can be held to; only taking away a Node that works today is a refusal.
   *
   * **The floor, not the newest release the range allows.** `^1.0.0` installs 1.2.0 today, so
   * measuring against that would wave 1.2.0 through - but raising the floor to it is exactly what
   * stops a Node that 1.0.0 still served. */
  protected nodeCoverage(pkg: Package, current: NpmRelease | undefined): string | undefined {
    const supported = this.supportedNode(pkg);
    const runs = current?.engines?.node;
    if (!supported || !runs || !semver.validRange(runs)) return supported;
    const sets = new semver.Range(supported).set.flatMap(a =>
      new semver.Range(runs).set.map(b => [...a, ...b].map(c => c.value).join(' ')),
    );
    const both = sets.filter(set => semver.validRange(set) && semver.minVersion(set)).join(' || ');
    return both || supported;
  }

  /** The Node versions `pkg` supports - its own `engines.node`, else the repository root's. */
  protected supportedNode(pkg: Package): string | undefined {
    const own = pkg.manifest.raw?.engines?.node;
    const root = pkg.repository?.rootPackage.manifest.raw?.engines?.node;
    const range = typeof own === 'string' ? own : typeof root === 'string' ? root : undefined;
    return range && semver.validRange(range) ? range : undefined;
  }

  /**
   * Steps 4 and 5: while any peer range is broken by a version that moved, one side steps down.
   *
   * The side that steps down is the one the range is *about* - for "`parser` needs `typescript`
   * below 6", `typescript` - to the newest candidate the range allows; only when none is left does
   * the side stating the range step down instead.
   */
  protected resolve(decisions: readonly NodeDependencyUpdater.Decision[], ctx: DependencyUpdater.Context): void {
    const byPackage = new Map<Package, Map<string, NodeDependencyUpdater.Decision>>();
    for (const d of decisions) {
      if (!byPackage.has(d.pkg)) byPackage.set(d.pkg, new Map());
      byPackage.get(d.pkg)!.set(d.name, d);
    }
    const repoPackages = new Map(
      [ctx.repository.rootPackage, ...ctx.repository.packages].map(p => [p.name, p] as const),
    );

    for (let changed = true; changed;) {
      changed = false;
      for (const [pkg, own] of byPackage) {
        for (const stating of own.values()) {
          const version = this.effective(stating);
          const peers = version ? stating.releases?.get(version)?.peerDependencies : undefined;
          for (const [name, range] of Object.entries(peers ?? {})) {
            const about = own.get(name);
            if (about && this.settle(about, stating, range, `${stating.name}@${version} needs ${name} ${range}`)) {
              changed = true;
            }
          }
        }
        for (const sibling of this.siblingsOf(pkg, repoPackages)) {
          const theirs = byPackage.get(sibling);
          for (const [name, declared] of Object.entries<string>(sibling.manifest.raw.peerDependencies ?? {})) {
            const about = own.get(name);
            const stating = theirs?.get(name);
            const range = stating ? this.rangeFor(stating, 'peerDependencies') : declared;
            if (about && this.settle(about, stating, range, `${sibling.name} needs ${name} ${range}`)) changed = true;
          }
        }
      }
    }
  }

  /** One broken rule, mended by one step down. Whether anything moved. */
  protected settle(
    about: NodeDependencyUpdater.Decision,
    stating: NodeDependencyUpdater.Decision | undefined,
    range: string,
    rule: string,
  ): boolean {
    if (typeof range !== 'string' || !semver.validRange(range)) return false;
    const version = this.effective(about);
    if (!version || semver.satisfies(version, range, { includePrerelease: true })) return false;
    if (about.index >= 0) {
      const fits = about.candidates.findIndex((v, i) => i > about.index && semver.satisfies(v, range));
      this.stepTo(about, fits, rule);
      return true;
    }
    if (stating && stating.index >= 0) {
      this.stepTo(stating, stating.index + 1 < stating.candidates.length ? stating.index + 1 : -1, rule);
      return true;
    }
    return false;
  }

  /** Moves `d` down to `index` (`-1` keeps what is declared), remembering why it left its newest. */
  protected stepTo(d: NodeDependencyUpdater.Decision, index: number, rule: string): void {
    if (d.index === 0 && !d.reason) d.reason = `${d.candidates[0]} refused: ${rule}`;
    d.index = index;
  }

  /** The version `d` resolves to: the one it moves to, or else the newest release its declarations
   *  already allow, which is what an install picks. */
  protected effective(d: NodeDependencyUpdater.Decision): string | undefined {
    if (d.index >= 0) return d.candidates[d.index];
    if (!d.releases?.size) return undefined;
    const ranges = [...d.fields.values()].filter(r => semver.validRange(r));
    if (!ranges.length) return undefined;
    return [...d.releases.keys()]
      .filter(v => !d.latestTag || !semver.valid(d.latestTag) || semver.lte(v, d.latestTag))
      .filter(v => ranges.every(r => semver.satisfies(v, r)))
      .sort(semver.rcompare)[0];
  }

  /** What `d` declares in `field` once it has moved. */
  protected rangeFor(d: NodeDependencyUpdater.Decision, field: string): string {
    const declared = d.fields.get(field) ?? '';
    if (d.index < 0 || !d.movable.includes(field)) return declared;
    return this.movablePattern.exec(declared)![1] + d.candidates[d.index];
  }

  /** The in-repo packages `pkg` declares a dependency on. */
  protected siblingsOf(pkg: Package, repoPackages: ReadonlyMap<string, Package>): Package[] {
    const result = new Set<Package>();
    for (const field of DEPENDENCY_KEYS) {
      for (const name of Object.keys(pkg.manifest.raw[field] ?? {})) {
        const sibling = repoPackages.get(name);
        if (sibling && sibling !== pkg) result.add(sibling);
      }
    }
    return [...result];
  }

  protected toEntry(d: NodeDependencyUpdater.Decision): DependencyUpdater.Entry {
    const entry: DependencyUpdater.Entry = {
      package: d.pkg,
      name: d.name,
      types: [...d.fields.keys()],
      current: d.fields.get(d.movable[0]!)!,
      status: 'up-to-date',
      latest: d.allowed[0],
      available: d.available,
    };
    if (d.error) return { ...entry, status: 'error', reason: d.error };
    if (!d.available) return entry;
    if (!d.allowed.length) return { ...entry, status: 'skipped', reason: d.skipReason };
    if (d.index < 0) return { ...entry, status: 'held', reason: d.reason };
    const version = d.candidates[d.index]!;
    const result: DependencyUpdater.Entry = {
      ...entry,
      status: 'update',
      target: this.rangeFor(d, d.movable[0]!),
      bump: this.sizeOf(d.floor!, version),
      /** What stopped it short of `available`, if anything did - another rule first, since that is
       *  the nearer reason. */
      reason: version !== d.allowed[0] ? d.reason : version !== d.available ? d.skipReason : undefined,
    };
    this.planned.set(result, d);
    return result;
  }

  protected manifestFile(pkg: Package): string {
    return path.join(pkg.dirname, 'package.json');
  }

  /** `fn` over `items`, at most `limit` at a time. */
  protected async mapConcurrent<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < items.length) await fn(items[next++]!);
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  }
}

export namespace NodeDependencyUpdater {
  /** One dependency name of one package, and where planning has got to with it. */
  export interface Decision {
    pkg: Package;
    name: string;
    settings: DependencyUpdater.Settings;
    /** Every field declaring the name, and its range there. */
    fields: Map<string, string>;
    /** The fields whose range is rewritten. */
    movable: string[];
    /** Whether this name is planned at all - rather than only stating rules for the others. */
    wanted: boolean;
    /** What is declared now, as a version: the highest floor among the movable ranges. */
    floor?: string;
    /** The newest version the registry offers at all, before the package's own settings. */
    available?: string;
    /** Why the settings leave `available` out, when they do. */
    skipReason?: string;
    /** Newer versions the package's own settings allow, newest first. */
    allowed: string[];
    /** `allowed`, less the ones another of the package's own rules refuses. */
    candidates: string[];
    /** Into `candidates`; `-1` keeps what is declared. */
    index: number;
    releases?: Map<string, NpmRelease>;
    latestTag?: string;
    /** The Node versions a newer release has to keep covering - see `nodeCoverage`. */
    baselineNode?: string;
    reason?: string;
    error?: string;
  }
}
