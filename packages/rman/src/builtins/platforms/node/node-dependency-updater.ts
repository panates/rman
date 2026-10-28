import fs from 'node:fs';
import path from 'node:path';
import colors from 'ansi-colors';
import micromatch from 'micromatch';
import semver from 'semver';
import type { Package } from '../../../core/classes/package.js';
import { DependencyUpdater } from '../../../core/interfaces/dependency-updater.js';
import { Manifest } from '../../../core/interfaces/manifest.js';
import { exec, type ExecResult } from '../../../utils/exec.js';
import { type NpmRelease, type NpmReleases, npmViewReleases } from '../../publish-targets/npm/npm-view.js';
import { DEPENDENCY_KEYS } from './node-manifest.provider.js';
import { CiService } from './services/ci.service.js';
import { parseWorkspaceRange } from './utils/workspace-range.js';

/**
 * npm's answer to `rman deps`: which of a `package.json`'s dependencies have a newer version on the
 * registry, and which of those can be taken without breaking a rule another dependency states.
 *
 * Only a caret or tilde range on a plain version moves (`^1.2.3`, `~1.2.3`), keeping its prefix -
 * an npm alias of one too (`npm:@scope/real@^1.2.3`), asked about under the package it names. An
 * exact version, a compound range (`>=1 <2`, `a || b`), a dist-tag, a URL and an in-repo package
 * are left as they are - but every one of them still counts as a rule the others must keep.
 */
/* **Aliases were skipped outright, and silently**: `npm:...` is no semver range, so the field was
 * neither moved nor listed. Measured on `abisena/syncbridge-iomt`, whose host modules are a peer
 * `"@syncbridge/hl7": "^2.0.0"` beside a dev `"npm:@sbext/syncbridge__hl7@^2.0.0"` from a mirror:
 * the alias never appeared, and the peer was asked of npmjs.org under its own name, which stops at
 * 1.2.1 - so a 2.1.0 on the mirror would have read "up to date". The alias is what installs, so the
 * whole name is held to the package it names, and the peer moves with it. */
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
 * 3. the runtime: a version whose `engines.node` leaves out the Node rman is running on, or shares
 *    no Node at all with the package's own `engines.node`;
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

  /** The first pnpm whose `install` takes `--dry-run`; an older one is not asked. */
  /* pnpm 11.8 (2026-06-18) is where the release notes put it. Below it there is nothing to ask, and
   * no older pnpm was measured - what one makes of a flag it does not know is a guess, and the bad
   * guess is a real install. */
  protected readonly pnpmDryRunSince: string = '11.8.0';

  /** `name@version` for each move the last `applyPlan` wrote - what a pnpm peer issue is matched
   *  against, to tell the upgrade's issues from the repository's own. */
  protected written = new Set<string>();

  /** pnpm's `minimumReleaseAge` when nothing sets it, in minutes - see `pnpmReleaseAge`. */
  /* Measured on pnpm 12.10.1 rather than read: a release 22 hours old was added to
   * `minimumReleaseAgeExclude` by a plain install, one 25.7 hours old was not. `pnpm config get`
   * answers `null` for it, so the default is the one value that cannot be asked. */
  protected readonly pnpmDefaultReleaseAge: number = 1440;

  /** The first pnpm with a non-zero default `minimumReleaseAge`; an older one has none. */
  protected readonly pnpmReleaseAgeSince: string = '11.0.0';

  async getPlan(ctx: DependencyUpdater.Context, packages: readonly Package[]): Promise<DependencyUpdater.Entry[]> {
    const inRepo = new Set([ctx.repository.rootPackage, ...ctx.repository.packages].map(p => p.name));
    const decisions = packages.flatMap(pkg =>
      this.collect(pkg, DependencyUpdater.settingsFor(pkg, ctx.options), ctx.options, inRepo),
    );

    await this.applyReleaseAge(ctx, decisions);
    const withTime = decisions.some(d => d.settings.minAge > 0 || !!d.releaseAge?.minutes);
    const registry = await this.fetchAll(ctx, decisions, withTime);
    for (const d of decisions) this.prepare(d, registry.get(this.sourceOf(d)));

    this.resolve(decisions, ctx);
    return decisions
      .filter(d => d.wanted || d.unmovable)
      .map(d => {
        /** Set on the entry itself, never a copy: `planned` is keyed by that object. */
        const entry = this.toEntry(d);
        entry.installed = this.installedVersion(d.pkg, d.name);
        entry.resolved = this.resolvedVersion(d, entry.current);
        if (entry.installed && semver.validRange(entry.current)) {
          entry.installedInRange = semver.satisfies(entry.installed, entry.current, { includePrerelease: true });
        }
        return entry;
      });
  }

  async applyPlan(
    ctx: DependencyUpdater.Context,
    plan: readonly DependencyUpdater.Entry[],
  ): Promise<DependencyUpdater.Applied> {
    const originals = new Map<Package, string>();
    this.written = new Set();
    for (const entry of plan) {
      const d = this.planned.get(entry);
      if (entry.status !== 'update' || !d) continue;
      const version = d.candidates[d.index]!;
      this.written.add(`${d.name}@${version}`);
      if (!originals.has(d.pkg)) originals.set(d.pkg, fs.readFileSync(this.manifestFile(d.pkg), 'utf-8'));
      for (const field of d.movable) {
        d.pkg.manifest.raw[field][d.name] =
          (d.aliases.get(field) ?? '') + this.movablePattern.exec(d.fields.get(field)!)![1] + version;
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
   * The repository's own package manager, asked whether the manifests install, writing nothing:
   * `npm install --dry-run` (`verifyWithNpm`) or `pnpm install --dry-run --strict-peer-dependencies`
   * (`verifyWithPnpm`). yarn and bun are not asked, and a note says so.
   */
  async verify(ctx: DependencyUpdater.Context): Promise<string | undefined> {
    const manager = this.installer(ctx);
    if (manager === 'npm') return this.verifyWithNpm(ctx);
    if (manager === 'pnpm') return this.verifyWithPnpm(ctx);
    console.error(colors.yellow(`Not verified: "${manager}" has no dry-run install to ask.`));
    return undefined;
  }

  /**
   * The upgrades a refusal names at the version they move to - see `blameNpm` and `blamePnpm`,
   * which read the two package managers' own words.
   */
  blame(refusal: string, plan: readonly DependencyUpdater.Entry[]): DependencyUpdater.Blame[] {
    return this.pnpmPeerIssues(refusal).length ? this.blamePnpm(refusal, plan) : this.blameNpm(refusal, plan);
  }

  /**
   * The package manager that installs the repository: the one its lockfile belongs to, else the
   * one `CiService.resolvePackageManager` answers.
   */
  /* **The lockfile first, here and nowhere else in rman.** `deps` asks two questions of the tool
   * that installs - would it take these manifests (`verify`), and what does it let in (`pnpm`'s
   * release age) - and the lockfile is what that tool last wrote. `packageManager.node` answers who
   * *publishes* as well, and the two can differ on purpose: `panates/opra` installs with pnpm and
   * sets `node: npm` so `rman publish` keeps npm's provenance statement, and `verify` then ran
   * `npm install --dry-run` on a pnpm workspace and failed `EUNSUPPORTEDPROTOCOL` on every
   * `workspace:^`, putting the whole upgrade back. Two lockfiles in one directory fall through to
   * the setting, which is the documented way to settle that. */
  protected installer(ctx: DependencyUpdater.Context): CiService.PackageManager {
    try {
      const found = CiService.detectPackageManager(ctx.repository);
      if (found) return found;
    } catch {
      /** Two managers' lockfiles: the setting decides, or throws saying how. */
    }
    return CiService.resolvePackageManager(ctx.repository);
  }

  /**
   * In a pnpm repository, holds every dependency of a package that sets no `deps.minAge` to pnpm's
   * own `minimumReleaseAge` and `minimumReleaseAgeExclude` - see `pnpmReleaseAge`.
   */
  /* **The two have to agree, or pnpm settles it behind the user's back.** `deps.minAge` defaults to
   * 0 and pnpm 11+ to a day, so `deps -u` wrote versions pnpm refuses - and pnpm does not refuse
   * them: a plain `pnpm install` adds each one to `minimumReleaseAgeExclude` in
   * `pnpm-workspace.yaml` and says so in one line. Measured on `panates/opra`: six `@nestjs/*@12.3.2`
   * (21 hours old) and `postgrejs@3.14.1` (one hour) were exempted from the supply-chain check that
   * exists for exactly such releases, and it showed up in a commit diff.
   *
   * **pnpm's policy is read, never restated.** Mirroring it in `.rmanrc` was the workaround, and it
   * is two places to keep in step, in days on one side and minutes on the other. An explicit
   * `deps.minAge` or `--min-age` still wins - whoever wrote it decided. */
  protected async applyReleaseAge(
    ctx: DependencyUpdater.Context,
    decisions: readonly NodeDependencyUpdater.Decision[],
  ): Promise<void> {
    const inherits = (d: NodeDependencyUpdater.Decision) =>
      d.wanted && ctx.options.minAge === undefined && d.pkg.config.deps?.minAge === undefined;
    if (!decisions.some(inherits) || this.installer(ctx) !== 'pnpm') return;
    const policy = await this.pnpmReleaseAge(ctx);
    if (!policy.minutes) return;
    for (const d of decisions) if (inherits(d)) d.releaseAge = policy;
  }

  /**
   * pnpm's effective `minimumReleaseAge` (minutes) and `minimumReleaseAgeExclude` at the repository
   * root, as `pnpm config get` reads them - `pnpm-workspace.yaml`, the user's config and the
   * environment - and `pnpmDefaultReleaseAge` when none sets the age.
   */
  protected async pnpmReleaseAge(ctx: DependencyUpdater.Context): Promise<NodeDependencyUpdater.ReleaseAge> {
    const read = async (key: string): Promise<unknown> => {
      const result = await this.pnpm(ctx, `config get ${key} --json`);
      if (result.code) return undefined;
      try {
        return JSON.parse(result.stdout?.trim() || 'null');
      } catch {
        return undefined;
      }
    };
    const [age, exclude] = await Promise.all([read('minimumReleaseAge'), read('minimumReleaseAgeExclude')]);
    let minutes = Number(age);
    if (age === null || age === undefined || !Number.isFinite(minutes)) {
      const version = (await this.pnpm(ctx, '--version')).stdout?.trim();
      minutes =
        version && semver.valid(version) && semver.gte(version, this.pnpmReleaseAgeSince)
          ? this.pnpmDefaultReleaseAge
          : 0;
    }
    return {
      minutes,
      exclude: Array.isArray(exclude) ? exclude.filter((e): e is string => typeof e === 'string') : [],
    };
  }

  /** Whether `minimumReleaseAgeExclude` lets `name@version` in: an entry naming the package - a glob
   *  such as `@scope/*` - with no version, or with that version among its `||` alternatives. */
  protected releaseAgeExempt(exclude: readonly string[], name: string, version: string): boolean {
    return exclude.some(entry => {
      const at = entry.indexOf('@', 1);
      const pattern = at < 0 ? entry : entry.slice(0, at);
      if (!micromatch.isMatch(name, pattern)) return false;
      if (at < 0) return true;
      return entry
        .slice(at + 1)
        .split('||')
        .some(v => v.trim() === version);
    });
  }

  /**
   * `npm install --dry-run` at the repository root: npm's own resolver, which refuses a peer
   * conflict anywhere in the tree with `ERESOLVE`, and writes nothing.
   */
  /* Measured on a manifest pairing `typescript@^7` with `@typescript-eslint/parser@8.40.0`, whose
   * peer range stops below 6: `--dry-run` exits 1 with `ERESOLVE unable to resolve dependency tree`
   * and the offending `peer typescript@">=4.8.4 <6.0.0"` line, as `--package-lock-only` does, but
   * without touching the lockfile. */
  protected async verifyWithNpm(ctx: DependencyUpdater.Context): Promise<string | undefined> {
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
    return lines.join('\n') || `  npm install --dry-run exited ${result.code}`;
  }

  /**
   * `pnpm install --dry-run --strict-peer-dependencies` at the repository root - pnpm's resolver,
   * which writes nothing - counting only the peer issues one of this run's moves is part of. A pnpm
   * older than `pnpmDryRunSince` is not asked.
   */
  /* **`--strict-peer-dependencies`, or there is nothing to refuse.** pnpm treats an unmet peer as a
   * warning by default - measured on pnpm 12.10.1 with the npm case above: plain `--dry-run` exits 0
   * with `Issues with peer dependencies found`, the strict form exits 1 with
   * `ERR_PNPM_PEER_DEP_ISSUES`, and neither writes a lockfile or `node_modules`. A pnpm workspace is
   * covered from the root: the same conflict in `packages/a` came back under a `packages/a` heading.
   *
   * **Strict is also stricter than the repository**, which has lived with its peer warnings, so an
   * issue none of this run's moves is part of is the repository's own and is let through - otherwise
   * a repository carrying one could never upgrade anything. The cost, stated: a conflict a move
   * brings in only through a dependency of its own names that dependency, not the move, and passes
   * as well - which is what pnpm itself does with it by default.
   *
   * **Any other failure is a refusal, as with npm**: the manifests did not resolve, whatever the
   * reason, and with nothing to blame the command puts every write back and shows pnpm's lines. */
  protected async verifyWithPnpm(ctx: DependencyUpdater.Context): Promise<string | undefined> {
    const version = (await this.pnpm(ctx, '--version')).stdout?.trim();
    if (!version || !semver.valid(version) || semver.lt(version, this.pnpmDryRunSince)) {
      console.error(
        colors.yellow(
          `Not verified: pnpm ${version || '(not found)'} has no dry-run install - it needs pnpm ${this.pnpmDryRunSince}.`,
        ),
      );
      return undefined;
    }
    const result = await this.pnpm(ctx, 'install --dry-run --strict-peer-dependencies --ignore-scripts');
    if (!result.code) return undefined;
    const output = result.stdout ?? '';
    const issues = this.pnpmPeerIssues(output);
    if (issues.length) {
      const ours = issues.filter(issue => this.pnpmIssueMoves(issue).some(token => this.written.has(token)));
      if (!ours.length) return undefined;
      return ours.map(issue => issue.lines.map(line => `  ${line}`).join('\n')).join('\n');
    }
    /** Not a peer issue: pnpm's own error lines, without the dry run's list of what it would add. */
    const lines = output
      .split('\n')
      .filter(line => /ERR_PNPM_|^\s*error\b|^\s*✕/i.test(line))
      .map(line => `  ${line.trim()}`);
    return lines.join('\n') || `  pnpm install --dry-run exited ${result.code}`;
  }

  /**
   * The upgrades an `ERESOLVE` names at the version they move to - the one under `Could not resolve
   * dependency:` when it is one of them, else every one the output mentions.
   */
  /* **The version is what makes the name evidence.** `@hookform/resolvers@6.0.0` appears in the
   * output only because this run moved it there; the name alone also appears on every line about the
   * tree around it. The `Could not resolve dependency:` line is npm's own verdict - measured on the
   * `@hookform/resolvers` case it reads `peerOptional effect@"^4.0.0" from @hookform/resolvers@6.0.0`
   * - so a move it names is the one to hold, and the others it merely passes through stay. That line
   * sat past the 20 lines `verify` used to keep, which is why it now keeps them all.
   *
   * **The range form is the other name npm uses**, and missing it misattributed the hold: measured on
   * `abisena/syncbridge-iomt`, the verdict read `dev @syncbridge/syncbuild@"^2.2.0" from the root
   * project`, matched nothing, and every move the output mentioned anywhere was held under that one
   * line - `@syncbridge/testing` included, with syncbuild's reason. */
  protected blameNpm(refusal: string, plan: readonly DependencyUpdater.Entry[]): DependencyUpdater.Blame[] {
    const moves = plan.flatMap(entry => {
      const d = this.planned.get(entry);
      if (entry.status !== 'update' || !d) return [];
      /** npm names a move two ways: at the version it resolved (`from x@2.2.0`) and as the range a
       *  manifest declares (`dev x@"^2.2.0" from the root project`). */
      const tokens = [
        `${d.name}@${d.candidates[d.index]}`,
        ...d.movable.map(f => `${d.name}@"${this.writtenFor(d, f)}"`),
      ];
      return [{ entry, tokens }];
    });
    const names = (line: string, m: (typeof moves)[number]) => m.tokens.some(t => this.mentions(line, t));
    const lines = refusal.split('\n').map(line => line.trim());
    const at = lines.indexOf('Could not resolve dependency:');
    const verdict = at >= 0 ? lines.slice(at + 1).find(Boolean) : undefined;
    /** What it conflicts with, when npm says - the half of the verdict that explains it. */
    const conflict = lines.find(l => l.startsWith('Conflicting peer dependency:'));
    const named = verdict ? moves.filter(m => names(verdict, m)) : [];
    if (named.length) {
      const reason = `npm cannot install it: ${verdict}${conflict ? ` - ${conflict}` : ''}`;
      return named.map(m => ({ entry: m.entry, reason }));
    }
    return moves.flatMap(m => {
      const line = lines.find(l => names(l, m));
      return line ? [{ entry: m.entry, reason: `npm cannot install it: ${line}` }] : [];
    });
  }

  /** Runs `pnpm <args>` at the repository root, never throwing - the one place this class spawns
   *  pnpm, so a spec answers for it instead of whichever pnpm is on the machine. */
  protected pnpm(ctx: DependencyUpdater.Context, args: string): Promise<ExecResult> {
    return exec(`pnpm ${args}`, { cwd: ctx.repository.dirname, app: ctx.app, throwOnError: false });
  }

  /**
   * The moves a pnpm peer issue is about: the peer at the version pnpm found, when this run moved it
   * there, else the packages wanting it that this run moved.
   */
  /* **The peer first.** `typescript` moved to 7.0.2 and `@typescript-eslint/parser` wanting `<6` is
   * the peer outgrowing its requirers, and holding the peer is the one move that answers it; only
   * when the peer did not move is a requirer the one that changed. Each round holds at least one, so
   * a run with both moved holds the peer, asks again, and ends. */
  protected blamePnpm(refusal: string, plan: readonly DependencyUpdater.Entry[]): DependencyUpdater.Blame[] {
    const byToken = new Map<string, DependencyUpdater.Entry>();
    for (const entry of plan) {
      const d = this.planned.get(entry);
      if (entry.status === 'update' && d) byToken.set(`${d.name}@${d.candidates[d.index]}`, entry);
    }
    const blamed = new Map<DependencyUpdater.Entry, string>();
    for (const issue of this.pnpmPeerIssues(refusal)) {
      const peer = issue.installed && byToken.get(`${issue.peer}@${issue.installed}`);
      const entries = peer ? [peer] : issue.wanted.flatMap(w => w.by.flatMap(by => byToken.get(by) ?? []));
      for (const entry of entries) {
        if (blamed.has(entry)) continue;
        const wants = issue.wanted.map(w => `${w.range} by ${w.by[0]}`).join(', ');
        const found = issue.installed ? ` (found ${issue.installed})` : '';
        blamed.set(entry, `pnpm cannot install it: unmet peer ${issue.peer}${found}, wanted ${wants}`);
      }
    }
    return [...blamed].map(([entry, reason]) => ({ entry, reason }));
  }

  /** Every `name@version` a pnpm peer issue names - the peer as found, and each package wanting it. */
  protected pnpmIssueMoves(issue: NodeDependencyUpdater.PnpmPeerIssue): string[] {
    return [...(issue.installed ? [`${issue.peer}@${issue.installed}`] : []), ...issue.wanted.flatMap(w => w.by)];
  }

  /**
   * The peer issues in pnpm's `ERR_PNPM_PEER_DEP_ISSUES` report, each with its own lines.
   */
  /* The shape, measured on pnpm 12.10.1 - a workspace adds a project heading above and indents the
   * rest, so lines are read trimmed:
   *
   *     ✕ unmet peer typescript
   *       Installed: 7.0.2
   *       Wanted:
   *         ">=4.8.4 <6.0.0":
   *           @typescript-eslint/parser@8.40.0
   *           @typescript-eslint/typescript-estree@8.40.0
   *
   * `missing peer` is read the same way, with no `Installed`. **A range is quoted only when it has
   * a space** - `panates/opra`'s `schema-utils` wanting webpack came back as a bare `^5.112.0:` -
   * and read as anything else it ended the issue before its requirers, so the issue named no
   * package wanting the peer and nothing could be held for it. */
  protected pnpmPeerIssues(output: string): NodeDependencyUpdater.PnpmPeerIssue[] {
    const issues: NodeDependencyUpdater.PnpmPeerIssue[] = [];
    let issue: NodeDependencyUpdater.PnpmPeerIssue | undefined;
    for (const raw of output.split('\n')) {
      const line = raw.trim();
      const head = /^✕ (?:unmet|missing) peer (\S+)$/.exec(line);
      if (head) {
        issue = { peer: head[1]!, wanted: [], lines: [line] };
        issues.push(issue);
        continue;
      }
      if (!issue) continue;
      const installed = /^Installed: (\S+)$/.exec(line);
      const range = line === 'Wanted:' ? null : /^(".*"|\S+):$/.exec(line);
      const by = /^((?:@[^/@\s]+\/)?[^@\s]+@\S+)$/.exec(line);
      if (installed) issue.installed = installed[1];
      else if (range) issue.wanted.push({ range: range[1]!, by: [] });
      else if (by && issue.wanted.length) issue.wanted.at(-1)!.by.push(by[1]!);
      else if (line !== 'Wanted:') {
        issue = undefined;
        continue;
      }
      issue.lines.push(line);
    }
    return issues;
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
      for (const [name, value] of Object.entries<unknown>(declared)) {
        if (typeof value !== 'string' || inRepo.has(name) || parseWorkspaceRange(value)) continue;
        let d = byName.get(name);
        if (!d) {
          d = {
            pkg,
            name,
            settings,
            fields: new Map(),
            aliases: new Map(),
            movable: [],
            fixed: [],
            wanted: false,
            allowed: [],
            candidates: [],
            index: -1,
          };
          byName.set(name, d);
        }
        /** An alias is the range of the package it names: its versions are that package's, so the
         *  rules compare the range and the rewrite keeps the `npm:<name>@` in front. */
        /** Two fields aliasing one name to different packages have no one version list to share -
         *  the second is left as written, which no rule moves. */
        const parsed = this.aliasOf(value);
        const alias = parsed && (!d.source || d.source === parsed.source) ? parsed : undefined;
        if (alias) {
          d.source = alias.source;
          d.aliases.set(field, `npm:${alias.source}@`);
        }
        const range = alias ? alias.range : value;
        d.fields.set(field, range);
        if (kinds && !kinds.includes(field)) continue;
        if (this.movablePattern.test(range)) d.movable.push(field);
        else if (semver.validRange(range)) d.fixed.push(field);
      }
    }
    for (const d of byName.values()) {
      const picked = !options.names?.length || micromatch.isMatch(d.name, options.names);
      const rejected = settings.reject.length > 0 && micromatch.isMatch(d.name, settings.reject);
      d.wanted = d.movable.length > 0 && picked && !rejected;
      d.listed = !d.wanted && d.fixed.length > 0 && picked && !rejected;
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
      const source = this.sourceOf(d);
      for (const range of d.fields.values()) {
        const min = semver.validRange(range) ? semver.minVersion(range)?.version : undefined;
        if (!min) continue;
        const known = floors.get(source);
        if (!known || semver.lt(min, known)) floors.set(source, min);
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
    if (d.listed && info) d.unmovable = this.outgrown(d, info.releases);
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

    for (const version of d.allowed) {
      const refusal = this.staticRefusal(d, d.releases.get(version)!);
      if (!refusal) d.candidates.push(version);
      else if (version === d.allowed[0]) d.reason = `${version} refused: ${refusal}`;
    }
    d.index = d.candidates.length ? 0 : -1;
  }

  /**
   * The first range of a dependency rman does not move - a pinned `11.7.5`, a `>=2 <3` - that the
   * registry's newest offerable release falls outside, and that release. `undefined` when every
   * such range still takes it, which is nothing worth a row.
   */
  /* **Listed, never moved.** Only a `^` or `~` range on a plain version is rewritten, since anything
   * else was written that way on purpose. But leaving such a dependency out of the table entirely
   * hid it: measured on `panates/hl7v2`, `"mocha": "11.7.5"` with 12.x out appeared nowhere, and a
   * person reading the table took that for "up to date". A `skipped` row says what is there and why
   * it stays. */
  protected outgrown(
    d: NodeDependencyUpdater.Decision,
    releases: readonly NpmRelease[],
  ): NodeDependencyUpdater.Decision['unmovable'] {
    for (const field of d.fixed) {
      const range = d.fields.get(field)!;
      const newest = releases
        .map(r => semver.parse(r.version))
        .filter((v): v is semver.SemVer => !!v && !v.prerelease.length)
        .filter(v => !releases.find(r => r.version === v.version)?.deprecated)
        .filter(v => !d.latestTag || !semver.valid(d.latestTag) || semver.lte(v, d.latestTag))
        .sort(semver.rcompare)[0];
      if (newest && !semver.satisfies(newest, range)) return { field, range, version: newest.version };
    }
    return undefined;
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
    const age = d.releaseAge;
    const rule =
      d.settings.minAge > 0
        ? { minutes: d.settings.minAge * 1440, from: `deps.minAge is ${d.settings.minAge}` }
        : age?.minutes && !this.releaseAgeExempt(age.exclude, this.sourceOf(d), release.version)
          ? { minutes: age.minutes, from: `pnpm's minimumReleaseAge is ${age.minutes} minutes` }
          : undefined;
    if (rule) {
      const published = time?.[release.version];
      if (!published) return `no publish date to check the release age against - ${rule.from}`;
      const minutes = (Date.now() - Date.parse(published)) / 60_000;
      if (minutes < rule.minutes) return `published ${this.ageText(minutes)} ago - ${rule.from}`;
    }
    return undefined;
  }

  /** A release's age, in the largest unit that reads well - `3 day(s)`, `21 hour(s)`. */
  protected ageText(minutes: number): string {
    if (minutes >= 1440) return `${Math.floor(minutes / 1440)} day(s)`;
    if (minutes >= 60) return `${Math.floor(minutes / 60)} hour(s)`;
    return `${Math.max(0, Math.floor(minutes))} minute(s)`;
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

  /** Steps 2 and 3: the package's own other declarations of this name, and Node - the one rman runs
   *  on, and the ones the package supports. The rule `release` breaks, or `undefined`. */
  protected staticRefusal(d: NodeDependencyUpdater.Decision, release: NpmRelease): string | undefined {
    for (const [field, range] of d.fields) {
      if (d.movable.includes(field) || !semver.validRange(range)) continue;
      if (!semver.satisfies(release.version, range, { includePrerelease: true })) {
        return `${d.pkg.name} declares ${d.name} ${range} in ${field}`;
      }
    }
    const floor = d.floor ? d.releases?.get(d.floor) : undefined;
    const node = this.runningNode();
    if (!this.runsOn(release, node) && this.runsOn(floor, node)) {
      return `${d.name}@${release.version} needs node ${release.engines!.node}, this is node ${node}`;
    }
    const supported = this.supportedNode(d.pkg);
    if (supported && !this.sharesNode(release, supported) && this.sharesNode(floor, supported)) {
      return `${d.name}@${release.version} needs node ${release.engines!.node}, none of which ${d.pkg.name} supports (${supported})`;
    }
    return undefined;
  }

  /** The Node a release is checked against first - the one running rman, which is the one that
   *  installs. */
  /* **Two questions, and both are the user's.** Does it install on the Node running now, and does it
   * share *any* Node with the package's own `engines.node` (`sharesNode`). The second was
   * `semver.subset(supported, needed)` - every Node the package supports - until it was reported on
   * `panates/peacox-ui`: jsdom 30.1.3 needs `^22.22.2 || ^24.15.0 || >=26.0.0`, Node 25 left out,
   * and the package says `>=24.15`, so `deps --target major` held it on a machine running 24.15.0
   * where it installs. A range is "I accept these"; a gap in a dependency's range is not a reason to
   * refuse it, a range with nothing in common is. What that gives up, stated: a library whose runtime
   * dependency drops *one* Node its own `engines` still names is no longer told so here.
   *
   * **A Node the declared version already leaves out is no objection either** - the floor, measured
   * the hard way under the old rule: `eslint ^9` needs `^18.18.0`, so a package on an older 18 was
   * offered no 9.x at all, though the 9.x it installs today has the same requirement. Only a release
   * that stops working where the current one works is refused. The floor rather than the newest the
   * range allows, because raising the floor is what can stop it. */
  protected runningNode(): string {
    return process.versions.node;
  }

  /** Whether `release` declares that it runs on `node`. No `engines.node`, or one semver cannot
   *  read, is no objection. */
  protected runsOn(release: NpmRelease | undefined, node: string): boolean {
    const needed = release?.engines?.node;
    return !needed || !semver.validRange(needed) || semver.satisfies(node, needed, { includePrerelease: true });
  }

  /** Whether `release`'s `engines.node` and `supported` have at least one Node in common. No
   *  `engines.node`, or one semver cannot read, is no objection. */
  protected sharesNode(release: NpmRelease | undefined, supported: string): boolean {
    const needed = release?.engines?.node;
    return !needed || !semver.validRange(needed) || semver.intersects(supported, needed, { includePrerelease: true });
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
      if (fits >= 0) {
        this.stepTo(about, fits, rule);
        return true;
      }
      const declared = this.resolvedDeclared(about);
      if (declared && semver.satisfies(declared, range, { includePrerelease: true })) {
        this.stepTo(about, -1, rule);
        return true;
      }
      /* Nothing `about` may move to keeps the rule - so stepping it down gains nothing, and since a
       * decision only ever steps down it would never come back up once the side stating the rule
       * had given way. Measured on `abisena/syncbridge-iomt`: `@syncbridge/builtins@0.14.13` needs
       * `@syncbridge/common ^0.14.0`, which `deps.target: minor` leaves out (a 0.x minor is a
       * major), and `common`'s own `0.13.9` was dropped for it - then `builtins` stepped back too,
       * and both read "not updated" with a reason pointing at a move that never happened. */
    }
    if (stating && stating.index >= 0) {
      this.stepTo(
        stating,
        stating.index + 1 < stating.candidates.length ? stating.index + 1 : -1,
        this.explain(rule, about, range),
      );
      return true;
    }
    return false;
  }

  /** `rule`, plus why `about` cannot meet it when the version that would is one its own settings
   *  leave out - `0.14.0: major - deps.target is "minor"`. */
  protected explain(rule: string, about: NodeDependencyUpdater.Decision, range: string): string {
    const newest = about.available;
    if (!newest || !about.skipReason || !semver.satisfies(newest, range, { includePrerelease: true })) return rule;
    return `${rule} (${about.name}@${newest}: ${about.skipReason})`;
  }

  /** Moves `d` down to `index` (`-1` keeps what is declared), remembering why it left its newest. */
  protected stepTo(d: NodeDependencyUpdater.Decision, index: number, rule: string): void {
    if (d.index === 0 && !d.reason) d.reason = `${d.candidates[0]} refused: ${rule}`;
    d.index = index;
  }

  /** The version `d` resolves to: the one it moves to, or else the newest release its declarations
   *  already allow, which is what an install picks. */
  protected effective(d: NodeDependencyUpdater.Decision): string | undefined {
    return d.index >= 0 ? d.candidates[d.index] : this.resolvedDeclared(d);
  }

  /** The newest release `d`'s declarations already allow - what an install picks if `d` does not
   *  move. */
  protected resolvedDeclared(d: NodeDependencyUpdater.Decision): string | undefined {
    if (!d.releases?.size) return undefined;
    const ranges = [...d.fields.values()].filter(r => semver.validRange(r));
    if (!ranges.length) return undefined;
    return [...d.releases.keys()]
      .filter(v => !d.latestTag || !semver.valid(d.latestTag) || semver.lte(v, d.latestTag))
      .filter(v => ranges.every(r => semver.satisfies(v, r)))
      .sort(semver.rcompare)[0];
  }

  /** Whether `line` names `token` (`name@version`) whole - not `1.2.3` inside `1.2.30`. */
  protected mentions(line: string, token: string): boolean {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[\\s"'(])${escaped}(?![\\w.+-])`).test(line);
  }

  /** What `d` declares in `field` once it has moved - the range alone, an alias's `npm:<name>@`
   *  left off, which is what every rule compares. */
  protected rangeFor(d: NodeDependencyUpdater.Decision, field: string): string {
    const declared = d.fields.get(field) ?? '';
    if (d.index < 0 || !d.movable.includes(field)) return declared;
    return this.movablePattern.exec(declared)![1] + d.candidates[d.index];
  }

  /** The name `d`'s versions are asked under - the package an alias names, else its own. */
  protected sourceOf(d: NodeDependencyUpdater.Decision): string {
    return d.source ?? d.name;
  }

  /** What `field` holds once `d` has moved, as the manifest spells it - an alias keeps its
   *  `npm:<name>@`. */
  protected writtenFor(d: NodeDependencyUpdater.Decision, field: string): string {
    return (d.aliases.get(field) ?? '') + this.rangeFor(d, field);
  }

  /** `npm:<name>@<range>`, npm's alias form, as the package it names and the range - or `undefined`
   *  for anything else. */
  protected aliasOf(value: string): { source: string; range: string } | undefined {
    const match = /^npm:((?:@[^/@\s]+\/)?[^@\s]+)@(.+)$/.exec(value);
    return match ? { source: match[1]!, range: match[2]! } : undefined;
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
    if (!d.wanted && d.unmovable) {
      const { field, range, version } = d.unmovable;
      return {
        package: d.pkg,
        name: d.name,
        types: [field],
        current: range,
        status: 'skipped',
        latest: version,
        available: version,
        reason: 'not a ^ or ~ range - rman moves only those',
      };
    }
    const entry: DependencyUpdater.Entry = {
      package: d.pkg,
      name: d.name,
      types: [...d.fields.keys()],
      current: (d.aliases.get(d.movable[0]!) ?? '') + d.fields.get(d.movable[0]!)!,
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
      target: this.writtenFor(d, d.movable[0]!),
      bump: this.sizeOf(d.floor!, version),
      /** What stopped it short of `available`, if anything did - another rule first, since that is
       *  the nearer reason. */
      reason: version !== d.allowed[0] ? d.reason : version !== d.available ? d.skipReason : undefined,
    };
    this.planned.set(result, d);
    return result;
  }

  /**
   * The version of `name` that `pkg` resolves today: the first `node_modules/<name>/package.json`
   * walking up from its directory, which is Node's own lookup - so a hoisted copy at a monorepo's
   * root counts, and a nested one under the package wins over it.
   */
  protected installedVersion(pkg: Package, name: string): string | undefined {
    let dir = pkg.dirname;
    for (;;) {
      const file = path.join(dir, 'node_modules', name, 'package.json');
      if (fs.existsSync(file)) {
        try {
          const version = JSON.parse(fs.readFileSync(file, 'utf-8'))?.version;
          return typeof version === 'string' ? version : undefined;
        } catch {
          return undefined;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }

  /** The newest release `range` takes, as npm's install would pick it: no prerelease unless the
   *  range asks for one, nothing above the `latest` tag, a deprecated one only when nothing else is. */
  protected resolvedVersion(d: NodeDependencyUpdater.Decision, range: string): string | undefined {
    if (!d.releases || !semver.validRange(range)) return undefined;
    const taken = [...d.releases.values()]
      .filter(r => semver.satisfies(r.version, range))
      .filter(r => !d.latestTag || !semver.valid(d.latestTag) || semver.lte(r.version, d.latestTag))
      .sort((a, b) => semver.rcompare(a.version, b.version));
    return (taken.find(r => !r.deprecated) ?? taken[0])?.version;
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
    /** Every field declaring the name, and its range there - an alias's range, its `npm:<name>@`
     *  kept in `aliases`. */
    fields: Map<string, string>;
    /** The fields declaring the name as an npm alias, and the `npm:<name>@` they write in front. */
    aliases: Map<string, string>;
    /** The package an alias names, whose versions every field of this name is held to - an alias
     *  is what installs, so a plain peer range beside it is satisfied by that package. */
    source?: string;
    /** The fields whose range is rewritten. */
    movable: string[];
    /** The fields holding a valid range rman does not rewrite - a pinned version, `>=a <b`. */
    fixed: string[];
    /** Not planned, but listed when a release falls outside a `fixed` range - see `outgrown`. */
    listed?: boolean;
    /** That release, and the range it falls outside. */
    unmovable?: { field: string; range: string; version: string };
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
    /** pnpm's release-age policy, when the package sets no `deps.minAge` of its own - see
     *  `applyReleaseAge`. */
    releaseAge?: ReleaseAge;
    latestTag?: string;
    reason?: string;
    error?: string;
  }

  /** pnpm's `minimumReleaseAge`, in minutes, and its `minimumReleaseAgeExclude`. */
  export interface ReleaseAge {
    minutes: number;
    exclude: string[];
  }

  /** One unmet or missing peer in pnpm's report - see `pnpmPeerIssues`. */
  export interface PnpmPeerIssue {
    peer: string;
    /** The version pnpm found, absent for a missing peer. */
    installed?: string;
    /** Each range asked for, quoted as pnpm prints it, with the `name@version`s asking. */
    wanted: { range: string; by: string[] }[];
    /** The issue as pnpm printed it, trimmed. */
    lines: string[];
  }
}
