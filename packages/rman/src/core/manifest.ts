import path from 'node:path';
import { RmanApplication } from './application.js';
import type { Package } from './package.js';
import { baseTechStack, type TechStack } from './tech-stack.js';
import { semverScheme, type VersionScheme } from './version-scheme.js';

/**
 * A package's identity, however its ecosystem happens to record it.
 *
 * Three fields rman genuinely needs of every package, plus the raw document for the commands that
 * know what ecosystem they are in. Everything rman's core does - grouping, tagging, changelogs,
 * release identity - is expressed in terms of these three and nothing else.
 */
export interface Manifest {
  name: string;
  version: string;
  /** Excluded from publishing by the package's own declaration (`package.json#private`). Not the
   *  same as `.rmanrc "publish.skip"`, which is the *repository's* declaration about it. */
  private?: boolean;
  /** The document as the ecosystem wrote it. `rman-node`'s own commands read `package.json` fields
   *  the core has no opinion about (`scripts`, `publishConfig`, `engines`) off this. */
  raw: any;
}

/**
 * Where a package's identity is written, and how to change it.
 *
 * **The core has no provider.** "The name and version live in a `package.json`" is true of npm and
 * of nothing else - a `Cargo.toml`, a `pyproject.toml` and a `go.mod` each say the same thing
 * differently, and the version is not even in the same *kind* of place in all of them.
 * `rman-node` contributes the `package.json` one.
 *
 * Paired with `VersionScheme` on purpose: the ecosystem that decides *where* a version is written
 * is the one that decides *how* it is numbered, so a provider supplies both and a package gets a
 * matching pair rather than a `pyproject.toml` read with semver's arithmetic.
 */
export interface ManifestProvider {
  /**
   * **The ecosystem this provider speaks for**, surfaced on every package it reads as
   * `Package.provider` - `'node'` for `rman-node`. Short and about the technology, not about the
   * file: `fileName` already says `package.json`, and a name repeating it would tell a caller
   * nothing it did not have.
   *
   * This is what lets code that *does* know one ecosystem check before acting on a package -
   * `if (pkg.provider === 'node')` - which matters most in a repository holding more than one,
   * since `read` is asked per directory and two packages can legitimately answer to different
   * providers.
   */
  readonly name: string;
  /** The file this looks for, relative to a package directory - `'package.json'`. Used to report
   *  what was missing, and by `import` when grafting an external repository in. */
  readonly fileName: string;
  /** `undefined` when this directory holds no package of this kind, so another provider gets a
   *  turn rather than this one having to throw. */
  read(dir: string): Manifest | undefined;
  /** Writes `manifest` back. Only ever called with a manifest this provider produced. */
  write(dir: string, manifest: Manifest): void;
  /** How this ecosystem numbers versions. Defaults to semver when a provider has no opinion -
   *  which is right for Cargo and Go, and wrong for PEP 440, whose provider should say so. */
  readonly versionScheme?: VersionScheme;
  /**
   * The version of `pkg` this ecosystem's registry currently reports, or `undefined` for anything
   * that is not an answer (never published, no network, private with no access).
   *
   * **Read for exactly one purpose, and it is not "has this been published"**: `detectChangeHash`
   * borrows the version string to *guess a tag name*, and uses it only if a tag by that name
   * actually exists in git. The case it covers is rman being adopted onto a repository whose
   * releases predate it - a tag exists but is not in HEAD's ancestry (cut on another branch,
   * rewritten history, a shallow clone), so `git describe` cannot see it. Never compare this
   * against the local manifest version; that is `publish`'s question, and mixing the two is the
   * measured bug the A/B split exists to prevent.
   *
   * Here rather than behind a repository-wide hook because a registry belongs to an *ecosystem*: a
   * polyglot repository asks npm about its `node` packages and crates.io about its `cargo` ones, and
   * only a per-package provider can do that. Optional - an ecosystem with no registry to ask (or a
   * repository that would rather not reach the network) simply leaves git tags as the only source,
   * which is the honest answer rather than a diminished one.
   */
  publishedVersion?(pkg: Package): Promise<string | undefined>;
  /**
   * Rewrites `content` so the version it hard-codes reads `version`, for a file `.rmanrc
   * "version.stamp"` lists - returning `undefined` when there is nothing to change, so the caller
   * writes nothing and can report a file that matched nothing.
   *
   * **Here because how a version is *declared* is the language's**, and this provider is already
   * the ecosystem's representative for exactly that: `write` says where the manifest keeps it,
   * `versionScheme` says how it is numbered, and this says what it looks like in source. Measured
   * before it moved: the core's one pattern stamped a Go `const version = "…"` and a Gradle
   * `version = "…"` but silently missed `const Version`, `__version__`, Rust's
   * `pub const VERSION: &str = "…"` and `pom.xml`'s `<version>` - and "silently" is the part that
   * mattered, since a listed file that matches nothing looked exactly like a file with no version
   * in it.
   *
   * `file` is the absolute path, for a provider that keys off the extension (a `.ts` constant and a
   * `Chart.yaml` are both npm-adjacent and are not the same rewrite). `options.constant` is the
   * identifier the repository says holds it, from the config - a provider whose format has no
   * identifier ignores it.
   *
   * `stampVersionConstant` is exported for the common case; delegating to it is one line.
   */
  stampVersion?(file: string, content: string, version: string, options?: { constant?: string }): string | undefined;
  /**
   * Which of `candidates` this package declares a dependency on.
   *
   * The *field names* are the ecosystem's: npm spreads four of them
   * (`dependencies`/`devDependencies`/`peerDependencies`/`optionalDependencies`), Cargo has
   * `[dev-dependencies]` and `[build-dependencies]`, `go.mod` has one `require` block. rman only
   * wants the edges of the graph, so the provider reads its own manifest and returns the packages.
   *
   * Returning **packages rather than names** for the same reason `Package.dependencies` holds
   * them: a name identifies a package only where the ecosystem guarantees uniqueness, and the
   * provider is the only thing that knows how its own ecosystem refers to a dependency.
   *
   * Omit it and a package has no declared dependencies beyond `.rmanrc "dependencies"`.
   */
  dependencies?(manifest: Manifest, candidates: readonly Package[]): Package[];
  /**
   * Splits a package name into the parts a config expression can ask for - `${{ pkg.scope }}` and
   * `${{ pkg.unscopedName }}`.
   *
   * npm's `@scope/name` is a convention, not a universal: a Go module path (`github.com/x/y`)
   * split on `/` would report a scope of `github.com/x`, and a Cargo crate has no such notion at
   * all. Omit it and a name has no scope and is its own unscoped form, which is the honest answer
   * for an ecosystem without the concept.
   */
  splitName?(name: string): { scope?: string; unscopedName: string };
  /**
   * Rewrites this manifest's references to in-repo packages that just got a new version.
   *
   * `bumped` maps a package to the version it is being given. What a "reference" looks like is
   * entirely the ecosystem's: npm has four dependency fields and a `"workspace:"` protocol whose
   * bare selectors resolve at publish time and must *not* be rewritten; Cargo has `path`
   * dependencies that carry no version at all. rman only knows that a bump may leave siblings
   * pointing at the old number.
   *
   * Mutates `manifest.raw` in place - the caller writes it out afterwards, in the same pass that
   * wrote the new version, so there is one file write rather than two.
   *
   * Omit it and nothing is rewritten, which is correct for an ecosystem that references siblings
   * by path.
   */
  updateDependencyVersions?(manifest: Manifest, bumped: ReadonlyMap<Package, string>): void;
}

/**
 * The registry, merged onto the `Manifest` interface so one name carries both the shape and the
 * operations - `Manifest.read(dir)` returns a `Manifest`.
 *
 * A namespace rather than loose `addManifestProvider`/`readManifest` functions because a namespace
 * is what a plugin can *augment*: `declare module 'rman' { namespace Manifest { ... } }` is how
 * `rman-node` already adds to `SystemInfo`, and anything this seam grows later can arrive the
 * same way instead of as another top-level export.
 */
export namespace Manifest {
  /**
   * Starts a fresh application, which is what "clear the providers" now means.
   *
   * Kept under its old name because that is what `support/mocha-root-hooks.ts` and both fixtures
   * call, and it does strictly more than it used to - every registry goes, not just this one.
   */
  export function clearProviders(): void {
    RmanApplication.reset();
  }

  /**
   * Reads `dir`'s manifest through the first provider that recognizes it, with the scheme that
   * provider brings.
   *
   * **With no provider registered, or none recognizing the directory**, the fallback is a package
   * named after its own directory at version `0.0.0`. That is deliberately the least it can claim:
   * the directory name is a fact, and `0.0.0` is the version a thing has when nothing says
   * otherwise. The alternative - refusing to construct a package at all - would make `rman info` and
   * `rman list` fail in a repository whose `.rmanrc` simply names no plugin yet, which is exactly
   * when someone needs to run them.
   */
  export function read(dir: string): {
    manifest: Manifest;
    versionScheme: VersionScheme;
    fileName: string;
    techStack: TechStack;
  } {
    for (const techStack of RmanApplication.current().techStacks) {
      const provider = techStack.manifestProvider;
      const manifest = provider.read(dir);
      if (manifest) {
        return {
          manifest,
          versionScheme: provider.versionScheme ?? semverScheme,
          fileName: provider.fileName,
          techStack,
        };
      }
    }
    return {
      manifest: { name: path.basename(dir), version: '0.0.0', raw: {} },
      versionScheme: semverScheme,
      /** Nothing was read, so nothing can be named - a caller listing "the file I changed" has no
       *  file to list, which is correct rather than a placeholder that does not exist. */
      fileName: '',
      /** Same reasoning: no stack claimed this directory, so it belongs to no technology. The
       *  base stack's name is empty rather than a sentinel like `'unknown'`, which would read as a
       *  technology's name and could collide with a real one's. */
      techStack: baseTechStack,
    };
  }

  /** Writes through whichever provider recognizes `dir`. Throws when none does: a write that lands
   *  nowhere is worse than one that fails, since the caller has already decided the new version. */
  export function write(dir: string, manifest: Manifest): void {
    for (const provider of manifestProviders()) {
      if (provider.read(dir)) {
        provider.write(dir, manifest);
        return;
      }
    }
    throw new Error(
      `No manifest provider recognizes "${dir}", so there is nowhere to write its version.\n` +
        `  A repository's ".rmanrc" names its providers - see "plugins" (e.g. ['rman-node']).`,
    );
  }

  /**
   * The packages `pkg` declares a dependency on, via whichever provider recognizes it.
   *
   * No provider, or one with no opinion, means no declared dependencies - `.rmanrc "dependencies"`
   * is then the only source, which is exactly right: a repository rman cannot read the manifests
   * of can still describe its own graph by hand.
   */
  export function dependenciesOf(pkg: Package, candidates: readonly Package[]): Package[] {
    return providerOf(pkg)?.dependencies?.(pkg.manifest, candidates) ?? [];
  }

  /** `${{ pkg.scope }}`/`${{ pkg.unscopedName }}`, by whichever provider recognizes `dir` - and
   *  "no scope, the name is its own unscoped form" when none has an opinion. */
  export function splitName(dir: string, name: string): { scope?: string; unscopedName: string } {
    for (const provider of manifestProviders()) {
      if (!provider.read(dir)) continue;
      return provider.splitName?.(name) ?? { unscopedName: name };
    }
    return { unscopedName: name };
  }

  /**
   * Refreshes `pkg`'s references to the packages in `bumped`, via whichever provider recognizes it.
   *
   * No provider, or one without an opinion, means nothing to rewrite - a repository whose packages
   * reference each other by path has nothing here to go stale.
   */
  export function updateDependencyVersions(pkg: Package, bumped: ReadonlyMap<Package, string>): void {
    providerOf(pkg)?.updateDependencyVersions?.(pkg.manifest, bumped);
  }

  /**
   * Rewrites a hard-coded version in `content` through `pkg`'s own ecosystem - see
   * `ManifestProvider.stampVersion`.
   *
   * `undefined` covers three cases the caller has to tell apart from each other, and cannot: no
   * provider claimed the package, the provider has no opinion about stamping, or it looked and found
   * nothing to change. All three mean "this file was not stamped", which is what `version` reports.
   */
  export function stampVersion(
    pkg: Package,
    file: string,
    content: string,
    version: string,
    options?: { constant?: string },
  ): string | undefined {
    return providerOf(pkg)?.stampVersion?.(file, content, version, options);
  }

  /**
   * What `pkg`'s own ecosystem's registry says its current version is - see
   * `ManifestProvider.publishedVersion` for the one thing this is for and the one thing it must
   * never be used for.
   *
   * `undefined` when the provider has no opinion, which includes every repository that names no
   * plugin: git tags then answer the boundary question alone.
   */
  export async function publishedVersion(pkg: Package): Promise<string | undefined> {
    return providerOf(pkg)?.publishedVersion?.(pkg);
  }

  /** The file names providers look for, for an error message that can say what was expected. */
  export function fileNames(): string[] {
    return manifestProviders().map(p => p.fileName);
  }

  /** Every registered stack's manifest provider, in declaration order - the list this namespace's
   *  own code used to keep. */
  function manifestProviders(): ManifestProvider[] {
    return [...RmanApplication.current().techStacks].map(stack => stack.manifestProvider);
  }

  /**
   * The provider that claimed `pkg`, found by the name it reported as `pkg.provider` - exact, and
   * without re-reading the manifest off disk to work it out again.
   *
   * The probe is the fallback, not the rule: it covers a package constructed *before* its provider
   * was registered, which `Repository.create` cannot produce (plugins load first) but a test
   * arranging providers by hand can.
   */
  /** The package's own stack answers directly now - it *is* the technology that claimed the
   *  directory, so there is nothing left to look up. The probe stays for a package constructed
   *  before any stack was registered, which only a test arranging things by hand can produce. */
  function providerOf(pkg: Package): ManifestProvider | undefined {
    if (pkg.techStack.name) return pkg.techStack.manifestProvider;
    return manifestProviders().find(p => p.read(pkg.dirname));
  }
}
