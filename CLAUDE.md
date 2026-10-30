# rman

A language-agnostic monorepo manager: one package, `packages/rman`, holding the core
(`src/core`, `src/services`, `src/commands`) and the built-ins it ships (`src/builtins`: the `node`
platform, the npm, docker, cloudflare and spm publish targets, the presets). Specs are in
`packages/rman/test`, the reference docs in `docs/`.

Commands (pnpm, never `rman build` - see [repository](docs/decisions/repository.md)):
`pnpm run build`, `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run smoke`,
`graphify update .`.

This file holds the rules. **The design decisions - the reasoning, the measurements, the approaches
tried and dropped - are in [`docs/decisions/`](docs/decisions)**, one file per subject. Before
changing code in one of those subjects, read its file: most of them record a trap the code alone
does not show. A new decision goes into the matching file, not here; a new rule comes here.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Before every push: deps, a clean install, checks, tests

The user's rule. Run with the CLI this commit builds (`node packages/rman/build/cli.js`), in order:

1. `rman deps` - are the dependency versions current?
2. `rman deps -u` when it lists an upgrade.
3. `rman ci` - a clean install (wipes `node_modules` and the lockfile, installs with pnpm).
4. `pnpm run typecheck`, `pnpm run lint`, `pnpm run build`, `pnpm run smoke` - the checks.
5. `pnpm test`.
6. Only then push - and a release still goes through the PR route.

Commit what steps 2 and 3 changed (`package.json`, `pnpm-lock.yaml`) with the work, or on its own
when there is nothing else.

## Rules for this repository

- **Release only through a pull request**: push `dev`, wait for its Test run to go green, open and
  merge `dev` -> `main`, watch the Release run, fast-forward `dev`. Never push `main` by hand.
- **The build never calls rman**: `pnpm run build` is plain pnpm, so a release can build itself.
- **Every tool a script calls is a direct devDependency** - pnpm does not hoist.
- **A spec brings its own ecosystem** through the fixture's `createRepository` / `createApp`, never
  `Repository.create`; a fixture repository sets `user.email` / `user.name` right after `git init`;
  a test must never be able to reach a real `npm` or `docker`. Verify with `--parallel=false` after
  touching a registry, an augmentation or a fixture. Details in
  [testing.md](docs/decisions/testing.md).
- **A new spec gets a control run**: revert the fix, check that it fails.
- **Run `pnpm run smoke` after any move that changes who imports whom**: `core/` must not statically
  import a platform or a preset (the ESM cycle only the built CLI shows).
- **Docs baselines**: `docs/cli-rman.md` and `docs/rman.md` each start with a `docs-baseline`
  block. Diff `src/` from its commit before updating, update only what changed, then bump the
  block. Check anchors with github-slugger's rule after a heading change. A published README links
  `docs/` by full GitHub URL.

## Design decisions

| file | read before touching |
| --- | --- |
| [config.md](docs/decisions/config.md) | `ConfigReader`, `Workspace`'s cascade, `"[selector]"` blocks, `vars`, `${{ }}`, `extends`, presets, the missing JSON Schema |
| [config-types.md](docs/decisions/config-types.md) | `rman-config.interface.ts`, `Resolved`, contributed keys, `packageManager`, `dependencies`, `PublishTarget` |
| [config-functions.md](docs/decisions/config-functions.md) | value functions, `value`, function steps, `STEP_PATHS`, the console capture |
| [platforms.md](docs/decisions/platforms.md) | `builtins/` layout, `Platform` / `Plugin`, `Package.provider`, discovery, selectors, `BinPath`, `plugins` / `platforms` |
| [commands.md](docs/decisions/commands.md) | declaring a command, `shadowable`, `skip` / `--from-root` / `--scope /`, `.rman/*.mjs` |
| [output.md](docs/decisions/output.md) | `--json` / `--log-file`, reporters, the status line, progress panel, `rman config` |
| [release-detection.md](docs/decisions/release-detection.md) | questions A / B / C, `ChangeHashService`, tag patterns, release identity |
| [version.md](docs/decisions/version.md) | `VersionPlanService`, `VersionService`, cascade, `dependentRanges`, carries, stamping |
| [changelog.md](docs/decisions/changelog.md) | `ChangelogService` |
| [publish.md](docs/decisions/publish.md) | `publish`, its targets, `github-release` |
| [run.md](docs/decisions/run.md) | `RunService`, `list`, `clean` |
| [testing.md](docs/decisions/testing.md) | fixtures, `smoke`, `typecheck`, eslint `packageDir` |
| [repository.md](docs/decisions/repository.md) | this repository's pnpm setup, build, `release.yml`, npm auth, linking a build, the docs baselines |

## File layout: exported first, private below

Within any `src/**/*.ts` file, top-level exported declarations (functions, classes, namespaces,
interfaces/types) go first, right after the imports. Private (non-exported) helper
functions/consts/interfaces used only within that file go afterward, at the bottom - never above
or between exported declarations.

- This holds regardless of call order - a private helper referenced inside an exported
  function's body may sit far below it; JS/TS function hoisting and closures make this safe.
- When a `services/*.ts` module exports a `namespace` (e.g. `Changelog`, `Ci`, `Run`), the whole
  `export namespace X { ... }` block comes first, and every private module-scope helper it calls
  internally goes below it, outside the namespace.
- When adding a new private helper to an existing file, append it after the last exported
  declaration rather than near whichever exported function happens to call it.

## A class's own steps are `protected` members, not module functions

**The rule above is about a module's helpers; this one overrides it for a class.** Whatever a class
uses to do its work - a helper function, a list of names it checks against - is a `protected` method
or field on the class, never a module-scope `function` or `const` below it.

- **A module function cannot be replaced, and that is the whole cost.** It is unreachable from
  outside its file, so a subclass can override the public method and nothing inside it: the one
  seam a technology needs (`NodeVersionPlanService extends VersionPlanService` replacing
  `detectBoundary` and `cascade` while keeping the orchestration) is exactly the shape a private
  function forbids. A spec cannot stub one either, and per `Service` a stub that *can* be written
  has to be - mutating a module is the failure CLAUDE.md already records, where restoring a
  module-scope capture broke a spec two files away.
- **A list a step checks against is a `protected readonly` field**, for the same reason and with
  one extra rule: type it `readonly string[]` rather than letting the literal infer, or the declared
  type is those exact strings and no other list satisfies an override. `ConfigService.configFiles`
  is the worked example - and it comes in a pair with `configFileKind`, because a subclass adding a
  name also has to say how that name is read. A field a subclass can widen while a sibling method
  still refuses what it added is half a seam.
- **`CODE_SUBTREES` is the exception, and it is not a class's.** It is a module const because
  `type CodeSubtree = (typeof CODE_SUBTREES)[number]` derives from it - a class field has no type
  to derive. The test is whether a *type* reads the value, not whether the value feels constant.
- Pure functions of their arguments that no class uses stay plain exported functions - the line
  `Service` already draws. This rule is about the steps of a class that exists.

## Class member order: the shape, then the door, then the API, then the workings

```
static constants
public fields
protected fields
private fields

static factories          // create(), from() - they stand in for the constructor
constructor

get / set
public methods
protected methods
private methods
static helpers            // protected/private statics
```

**This is `@typescript-eslint/member-ordering`'s default with one deviation**, and the default is the
closest thing to a standard here. The deviation: the rule puts *every* static method after the
accessors, which buries a factory - and a factory is how you get an instance, so it belongs beside
the constructor it replaces. `Workspace.create` sitting below `packageAt` would hide the only door
into a class whose constructor is `protected`.

- **Public before private, at every level**, which is the same rule as the file layout above: what
  is written for a caller comes first. Inverting it inside a class while the file around it says the
  opposite is two directions in one file. `Workspace` opening on `_levels` and `_configReader` -
  two bookkeeping Maps - is what that costs.
- **Fields before behaviour**, so the shape of the object is visible before what it does. That is
  the half of the common "private fields first" habit worth keeping; the visibility half is not.
- **Not enforced by lint yet.** Adding `member-ordering` turns most existing files red at once, so
  it is a rule to apply to new and rewritten classes first. Enforce it when the tree has caught up -
  a checked rule beats a remembered one, and this one is easy to forget.

## TSDoc is for the caller; the reasoning goes in a block comment beside it

**A `/** ... *&#47;` block is API documentation and nothing else** - what the thing does, what it
takes, what it gives back, what a caller has to know to use it. It is what an editor shows on hover
and what a doc generator publishes, so everything in it is read by someone who only wants to call
the function.

**Everything else - and this repository has a great deal of it - goes in a plain `/* ... *&#47;`
block immediately below the TSDoc.** The measurement behind a decision, the alternative that was
tried and failed, the trap a future editor would otherwise fall into, the spec that pins it: all of
that is for whoever *changes* the code, not for whoever calls it.

```ts
/**
 * Builds and initializes a workspace.
 */
/* **`new this()`, not `new Workspace()`.** In a static method `this` is the class the call was
 * made on, so a subclass inheriting this factory builds itself; hard-coding the name would let
 * someone override `_init` and never see it run. */
static async create(...)
```

- The split is by **audience**, not by length. A one-line note about why a parameter exists is still
  a note; a paragraph a caller genuinely needs is still TSDoc.
- **Inline comments inside a body stay where they are.** This rule is about the block attached to a
  declaration, which is the only one an editor surfaces.
- The same applies to a `protected` member: its TSDoc is read by a subclass author, and the reason
  it is shaped that way is not.
- Do not simply delete the reasoning when it does not belong in the TSDoc - this repository's
  comments *are* its record of what was measured, and losing one costs the next session the
  measurement. Move it down, do not drop it.
