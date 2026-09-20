import path from 'path';
import type { RmanConfig } from '../interfaces/rman-cfg.interface.js';
import type { RmanApplication } from './application.js';
import { Manifest } from './manifest.js';
import type { Repository } from './repository.js';
import type { TechStack } from './tech-stack.js';
import { semverScheme, type VersionScheme } from './version-scheme.js';

export class Package {
  /**
   * This package's identity, read through whichever `ManifestProvider` recognizes its directory.
   *
   * There is no `json` here any more, and that is the point: `package.json` is npm's answer to
   * "where is a package's name and version written", not rman's. `manifest.raw` is still the whole
   * document for a command that knows its own ecosystem - `rman-node` reads `scripts` and
   * `publishConfig` off it - but the core only ever touches `name`, `version` and `private`.
   */
  manifest: Manifest;
  /**
   * In-repo packages this one depends on - **the full transitive closure**, not just its direct
   * dependencies (see `Repository._updateDependencies`).
   *
   * References, not names: a name is only an identifier if the ecosystem guarantees uniqueness,
   * which npm does and others do not - Go identifies a module by import path, and nothing stops a
   * repository from holding two packages whose short names collide. A `Package` is unambiguous
   * whatever the ecosystem, and comparing by identity removes a lookup from every consumer.
   */
  dependencies: Package[] = [];
  /** Effective rman config for this package, cascaded from the repository root, with every
   *  `${{ ... }}` expression already evaluated. */
  config: RmanConfig = {};
  /**
   * The repository this package belongs to - so anything holding a package can reach the whole
   * picture (its siblings, the root's config, git) without being handed it separately.
   *
   * Assigned by `Repository.create` rather than taken as a constructor argument, and it has to be:
   * `Repository extends Package`, so a repository constructing itself runs this constructor before
   * it exists to be passed in. A repository's own is itself.
   */
  repository!: Repository;
  /**
   * The package whose directory contains this one - the repository root for an ordinary member, and
   * a genuine enclosing package for one nested inside another (which `Repository.currentPackage`
   * already has to reason about). `undefined` for the root itself, which nothing contains.
   */
  parent?: Package;
  /**
   * How this package's versions are numbered - `pkg.versionScheme.next(pkg.version, 'minor')`.
   *
   * Comes from the same provider that read the manifest, because the ecosystem that decides where
   * a version is written is the one that decides how it is numbered - a `pyproject.toml` read with
   * semver's arithmetic would be a pair that never occurs in reality.
   *
   * Defaults to semver, so this seam existing changes nothing. **A group must not mix schemes** -
   * a group is one version line, and comparing across schemes is meaningless; `assertOneScheme`
   * refuses it rather than acting on whatever falls out.
   */
  versionScheme: VersionScheme = semverScheme;

  /** The file the manifest was read from, absolute - for a command that has to say which file it
   *  changed (a commit's path list). Empty when no provider recognized this directory. */
  manifestFileName: string;

  /**
   * **The technology this package belongs to** - the stack whose manifest provider claimed the
   * directory, or `baseTechStack` when none did.
   *
   * Per *package*, not per repository: the question is asked per directory, so a polyglot monorepo
   * can hold a `node` package beside a `cargo` one and a command sweeping `getPackages()` can tell
   * them apart. It is also what carries the rest of the technology's answers - where its binaries
   * live, where its scripts come from, how its releases are planned - so anything that used to walk
   * four separate registries asking "is this yours?" now asks the package it already has.
   */
  techStack: TechStack;

  /**
   * **Which ecosystem this package belongs to** - `'node'` for one read by `rman-node`. Empty when
   * no stack claimed the directory.
   *
   * The escape hatch for code that legitimately knows one technology: `if (pkg.provider === 'node')`
   * before reaching into `manifest.raw` for something only npm has.
   *
   * Not a union type on purpose: the set of ecosystems is whatever the repository's `plugins`
   * contribute, so narrowing it here would mean the core listing plugins it cannot know about.
   */
  get provider(): string {
    return this.techStack.name;
  }

  /**
   * **Takes the application but does not keep it.** A package needs it once, to find out which
   * technology claims its directory; afterwards it holds only data, so nothing that has a package
   * can reach a service through it. Data down, behaviour up - the work belongs to services, and a
   * piece of code holding only a package is not doing any.
   *
   * It also keeps the package out of every spread and serialization the application would
   * otherwise be dragged into: `{...pkg}` and `pkg.manifest.raw` are both real, and an `app` field
   * here would carry the whole world into them.
   */
  constructor(
    readonly dirname: string,
    app: RmanApplication,
  ) {
    const { manifest, versionScheme, fileName, techStack } = Manifest.read(app, dirname);
    this.manifest = manifest;
    this.versionScheme = versionScheme;
    this.manifestFileName = fileName ? path.join(dirname, fileName) : '';
    this.techStack = techStack;
  }

  get basename(): string {
    return path.basename(this.dirname);
  }

  get name(): string {
    return this.manifest.name;
  }

  get version(): string {
    return this.manifest.version;
  }

  get isPrivate(): boolean {
    return !!this.manifest.private;
  }

  /**
   * Whether this is the repository's **own root package** - what `--scope /` and `.rmanrc`'s
   * `"[/]"` both select.
   *
   * **By directory, and deliberately not by name or by identity.** The documented rule is that the
   * root package is the one whose directory *is* the repository root, because a name can be
   * anything - and identity (`this === repository.rootPackage`) is not equivalent either:
   * `Repository extends Package` while holding a separate `rootPackage` instance for the same
   * directory, so a comparison by reference answers `false` for one of the two objects that are
   * both, truthfully, the root.
   *
   * `false` before `Repository.create` has assigned `repository` - a bare `new Package(dir, app)`
   * (which the test fixtures build) belongs to no repository yet, so there is no root for it to be.
   */
  get isRoot(): boolean {
    const repository = this.repository as Repository | undefined;
    return !!repository && path.resolve(this.dirname) === path.resolve(repository.dirname);
  }

  /** Re-reads from disk - for a command that has just written the manifest itself and wants the
   *  package to agree with the file again. */
  /** Re-reads from disk through **its own** technology's provider - no search, since the package
   *  already knows which one claimed it, and a second opinion on a re-read was never wanted. */
  reloadManifest(): Manifest {
    const provider = this.techStack.manifestProvider;
    this.manifest = provider.read(this.dirname) ?? { name: path.basename(this.dirname), version: '0.0.0', raw: {} };
    this.versionScheme = provider.versionScheme ?? this.versionScheme;
    this.manifestFileName = provider.fileName ? path.join(this.dirname, provider.fileName) : '';
    return this.manifest;
  }

  /** Writes the current manifest back through its provider. */
  writeManifest(): void {
    this.techStack.manifestProvider.write(this.dirname, this.manifest);
  }
}
