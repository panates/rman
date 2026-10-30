# This repository: pnpm, build, release workflow, docs

Design decisions moved out of `CLAUDE.md`. Covers pnpm setup, a build without rman, `release.yml` and npm Trusted Publishing, linking a built package, the reference docs.

## This repository installs with pnpm

`pnpm-workspace.yaml` lists the workspace and `package.json#packageManager` pins pnpm; there is no
`package-lock.json` and no `workspaces` key - pnpm ignores the latter, so keeping it would be a
second list to drift. Scripts say `pnpm run`, and so does the guidance below where it names a
command; older sections still saying `npm run x` mean `pnpm run x`.

- **Every tool a script calls is a direct devDependency.** npm hoisted `eslint` out of
  `@panates/eslint-config-ts`; pnpm does not, and `pnpm run lint` answered `eslint: command not
  found` until `eslint` and `typescript-eslint` (that preset's peer) were declared.
- **`allowBuilds` names `@swc/core` and `unrs-resolver`**: pnpm refuses an install with unapproved
  build scripts (`ERR_PNPM_IGNORED_BUILDS`), and both are napi postinstalls npm ran unasked.
- **`minimumReleaseAge: 0`, the user's call**: pnpm's default holds back anything younger than a
  day, a second floor under what `rman deps` reports.
- **The release publishes with pnpm too**, the lockfile's manager. It was `--package-manager npm`
  while Trusted Publishing had been measured with npm alone; pnpm 12 does the OIDC exchange and signs
  provenance itself (measured on `panates/sqb` 6.3.2), and rman passes it `--no-git-checks`.

## The build must not need rman

`pnpm run build` is `pnpm --filter rman run build` - plain pnpm, never `rman build`.

**It was `rman build`, and that is a bootstrap loop that only bites on the release that matters.**
The `rman` on PATH is whatever is *published*, so a version introducing a config feature cannot
build itself: the repository's own `.rmanrc.yml` already uses `plugins` and `"[*]"`, neither of
which 1.0.x understands. The failure lands exactly when a release is being cut.

- **It named two workspaces until `packages/node` was folded in, and the second half stayed here
  long after the directory went.** What that ordering clause said - `rman` first, because
  `rman-node`'s build resolved `rman` from `packages/rman/build/index.d.ts`, and because `tsc -b`
  would order the compilation but not the pre/post hooks around it - is still the right reasoning
  for a second package, and there is no second package. Restore it with the order written out, not
  derived, if one ever comes back.
- npm runs each workspace's `prebuild`/`postbuild` itself, so nothing else moves.
- **CI needed no change, and that was worth checking rather than assuming**: the release workflow
  (`panates/github-actions/.github/workflows/node-release.yaml@v1`) calls rman nowhere - packages
  come from `gh-repository-info`, publishing from `release-npm`, the release from `ncipollo`. Its
  `build_script` input defaults to `npm run build`, so `npm run build` was the single place CI
  depended on rman at all.
- Measured from a clean tree with rman absent from PATH entirely: both packages build in ~2.6s, and
  the output is what `rman build` produced - generated manifests, README/LICENSE copied, `bin` at
  755, the version constant stamped (`node packages/rman/build/cli.js --version` reports the new
  one).

Dogfooding is not gone, only off the critical path: `npx rman build` still works once a build
exists, and is the right thing to run when changing `RunService`.

## The release workflow, and the npm auth trap that cost five runs

[`.github/workflows/release.yml`](../../.github/workflows/release.yml) releases rman **with the rman in
that commit** - `pnpm install --frozen-lockfile`, `pnpm run build`, then `node packages/rman/build/cli.js version/publish/
github-release`. It called `panates/github-actions/.../node-release.yaml@v1` until 40f41e3, which is
safe only because *that* version calls rman nowhere: `@v2` drives the whole release with
`npx rman@1` (measured: 0 references against 20), so following the other repositories onto it would
have had rman 2.x released by an rman that cannot read this repository's own `.rmanrc.yml`. Same
bootstrap loop `npm run build` was taken off, and it bites exactly when a release is being cut.

- **A release goes through a pull request, after `dev` has tested green - never a `main` pushed by
  hand.** The order: push `dev`; wait for the Test run on `dev` to finish green; open a PR `dev` ->
  `main` (`gh pr create --base main --head dev`) and merge it; watch the Release run; then
  fast-forward `dev` to `main`. The user's rule, after `dev` and `main` were pushed seconds apart and
  the Test and Release runs went at once - a release must not start before its tests have answered.
  The workflows are built for this route too: `release.yml` skips its own test job only for a
  `Merge pull request ... /dev` commit, so a hand-merged `main` tests the same commit a second time.
- **Two builds, and both are load-bearing.** The first is the bootstrap - there is no rman to run
  `version` with until it finishes. The second is the artifact: `postbuild.cjs` bakes
  `package.json`'s version into `build/constants.js`, so a build made *before* the bump ships a CLI
  reporting the old version. Measured: set `package.json` to 9.9.9 without rebuilding and
  `--version` still answers the previous one. It holds although `.rmanrc.yml` declares no
  `version.stamp` - what bakes the version in is postbuild, not the config.
- **The built-in `GITHUB_TOKEN`, not a PAT**, and that removes a redundant run rather than a secret:
  a push made with `GITHUB_TOKEN` deliberately does not trigger workflows, and `version --push`
  pushes to `main`, which is what this workflow triggers on. With a PAT every release started a
  second run of itself, which the `no-release` guard does not catch (a `chore(release): ...` message
  contains neither guard word) and `concurrency: cancel-in-progress: false` does not cancel.
- **`private: true` had to come off `packages/rman/package.json`**, or `rman publish` released
  nothing: measured, the plan answered `skip - private package`. (Since 2.11.1 it would publish - the
  decision reads the build directory's manifest, see the build-directory section - but the
  `prepublishOnly` guard below is still the better statement.)
  The flag was never about the artifact - publish runs `npm publish` with cwd =
  `packages/rman/build` and `derivePublishManifest` generates that manifest itself, deleting
  `private` on the way. It was guarding the *source* directory against a stray `npm publish`, which
  a `prepublishOnly` says on its own: measured on four routes, it blocks `npm publish` in the
  package and `npm publish -w packages/rman` from the root, and does not fire for cwd=build (rman's
  own route) or `npm publish build`. It cannot reach a consumer - `postbuild.cjs` deletes `scripts`
  wholesale and `derivePublishManifest` keeps only the three install hooks. **No backticks in that
  message**: npm runs a script through `sh -c "..."`, where a backticked `` `rman publish` `` is
  command substitution and would run.

**npm Trusted Publishing (OIDC), and the four dead ends it went through.** All of these report as
one of two messages, neither of which names the cause:

| symptom | what it means |
| --- | --- |
| `ENEEDAUTH` | npm found no credential **and did not attempt the OIDC exchange** |
| `404 Not Found - PUT .../rman` | npm sent a credential the registry rejected - it returns 404 rather than 403 so nobody can probe which packages exist |

- **`registry-url` on `setup-node` is required**, and dropping it was the first dead end. The
  reasoning was right for v4 and explicitly wrong for v7: v4 wrote an `.npmrc` whose `_authToken`
  was a dummy `NODE_AUTH_TOKEN` fallback, v7 removed it and says so ("npm Trusted Publishing (OIDC)
  is not affected, since it does not use NODE_AUTH_TOKEN"), and the documented recipe sets it.
- **The empty auth line it writes must be stripped**, and that was the second. `registry-url` makes
  setup-node write `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into the file
  `NPM_CONFIG_USERCONFIG` points at - **not** `./.npmrc`, which is where a diagnostic will look
  first and find nothing. With no token that resolves to nothing, and npm reads *having* an
  `_authToken` entry as being authenticated already, so it never reaches for OIDC. This is
  actions/setup-node#1551. The `Configure npm auth` step removes it with `grep -v` into a temp file;
  **not `sed -i`**, which BSD sed reads as a backup suffix, making the line a silent no-op on macOS
  - measured while checking that very step.
- **`npm install -g npm@latest` was a third**, and it was insurance that moved the runner: Node 24
  ships npm 11.19.0, well past the 11.5.1 OIDC needs, and the upgrade took the job to npm 12.1.0 -
  a major the recipe never contemplates, since it has no upgrade step at all.
- **The cause was the trusted-publisher registration on npmjs.com**, and deleting and recreating it
  fixed it with every field re-entered identically. That is the documented remedy for "everything
  looks right and OIDC never engages", and it is worth reaching for **early** rather than last.
- **rman was ruled out by measurement, not by argument.** `npm publish` is a *grandchild* here -
  `rman publish` execs it through `BinPath.env`, which rebuilds the environment from
  `{ ...process.env }` - and a probe run inside that spawn reported
  `child OIDC url: present, child OIDC token: present, child npm: 11.19.0`.
- **A publish is not visible immediately.** npm answers `Your package is being processed and may
  take a few minutes to become available`, and a registry query inside that window says the version
  is absent - measured, and mistaken for a failed publish. Read `npm notice ... Signed provenance
  statement` plus `+ rman@<version>` in the log as the success, not a registry read taken seconds
  later. **Under pnpm the line is `Published package rman@<version>`** - the release has published with
  pnpm since it moved off `--package-manager npm`; npm's `+ rman@` and `npm notice` lines are gone.

**The diagnostic step that found all this is deleted**, because the question is answered and it
printed eight lines on every release. What it did, if it is ever needed again: `npm --version`, the
presence (never the value) of `ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN`, the contents of
`${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}` with `_authToken` values redacted, and the claims npm
matches a publisher on, read from the token GitHub issues for npm's own audience:

```bash
curl -sS -H "authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=npm:registry.npmjs.org" |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const c=JSON.parse(Buffer.from(JSON.parse(s).value.split('.')[1],'base64url'));
    for (const k of ['repository','repository_owner','workflow_ref','job_workflow_ref','environment'])
      console.log(k, c[k] ?? '(absent)');
  })"
```

**Never print the token itself.** `ACTIONS_ID_TOKEN_REQUEST_TOKEN` is a live credential that GitHub
does **not** mask, because it is not a registered secret - and `${VAR:+present}${VAR:-ABSENT}`, which
reads as a tidy way to report presence, prints `present<the value>` when the variable is set. Caught
locally with a fake token before it ever ran.

## Linking a built package into another repository

**`packages/<name>/build` *is* the published package** - `postbuild.cjs` writes a `package.json`
there whose `exports` are relative to it. So the way to try a local build in another repository is to
symlink that directory as the package itself:

```bash
ln -s <rman>/packages/rman/build  <other-repo>/node_modules/rman
ln -s <rman>/packages/node/build  <other-repo>/node_modules/rman-node
```

Two things this measured, both of which cost more time than the linking did:

- **`tsc` writes a bin at 644, and npm is what normally makes it 755.** Linked rather than installed,
  `node_modules/.bin/rman` then points at a file the shell refuses - `permission denied`, with the
  shebang present and correct, which sends the reader to look at the shebang. `postbuild.cjs` now
  chmods every `bin` entry, so it survives each rebuild.
- **A plugin resolves `rman` from its own location, not from the repository using it.** So
  `rman-node`'s `import 'rman'` walks up from `<rman>/packages/node/build` and lands in **this**
  repository's `node_modules` - linking it elsewhere changes nothing about that. Its `node_modules/rman`
  therefore has to resolve too, and pointing it at `packages/rman/build` (rather than at
  `packages/rman`, which npm's workspace link does) is what makes it: the build directory is the
  published layout, so no dev-time bridge file is needed at all. The same link makes the whole test
  suite run - `packages/node/test/*` imports `'rman'` by name.
  - Caveat worth stating: with that link, node's specs run against the **built** core rather than
    `src`, so a stale `build` is silently what gets tested. `npm install` restores npm's own
    workspace links and undoes all of this.

## Docs: two reference files, and a baseline in each

**There were four, two per package, and there is one package now.** The split existed so a reader
asking what `rman` is need not know which half of the answer is npm's; `rman-node` was folded in, so
`docs/node.md` and `docs/cli-node.md` are **deleted** rather than stale. Don't recreate them.

| | |
| --- | --- |
| [`docs/cli-rman.md`](../../docs/cli-rman.md) | every command, plus global options, the shared option groups, and **Where a command comes from** |
| [`docs/rman.md`](../../docs/rman.md) | the programmatic API, the config reference, and **The `node` built-in** |

- **`docs/cli/*.md` stays one page per command**, which was always the right unit and is now
  unarguable: a reader looking up `rman clean` did not need to know which package shipped it, and
  there is nothing left to know.
- **Named `cli-rman.md`, not `cli/rman.md`.** The latter was tried and reverted within the hour: a
  `docs/cli/rman.md` beside a `docs/rman.md` makes every relative link ambiguous to a *reader*, who
  sees `rman.md` in two places meaning two different documents.
- `SystemInfo` is the exception worth remembering, and not an inconsistency: the service and the
  `info` command are the **core's**, so they are in `rman.md`; the npm half the plugin augments in
  is a short section of `node.md` pointing back at it.
- **Check anchors with github-slugger's rule, never by eye - and it is not a dependency here**, so
  the pass implements it inline: lowercase, drop everything that is not a letter, number, mark,
  connector, hyphen or space, then spaces to hyphens. Verified against the two cases below. Two long-standing links never jumped:
  `#configuration-rmanrc-rmanrcyml` needs **two** hyphens (the ` / ` in the heading becomes one each)
  and `#expressions--` needs **three**. A link to a missing anchor silently lands at the top of the
  page, so nothing reports it.
- A **published README must not carry relative `docs/` links.** `packages/*/README.md` ships to npm,
  where no `docs/` directory exists - and since the READMEs moved under `packages/`, a relative link
  was broken in the repository too. Use the full `https://github.com/panates/rman/blob/main/docs/...`
  URL.

Each file starts with an HTML comment block (`docs-baseline`) recording the git commit, package
version, and date it was last verified against source - see that block for the exact format and the
`git diff <commit>..HEAD -- <its own src>` command it documents.

Rules:
- Whenever you write or update these API docs, record (or update) that baseline block with the
  commit you verified against - so a later session can diff from a known point instead of
  re-reading everything from scratch.
- Before trusting/updating the docs, diff that package's `src/` (and its `test/**/*.spec.ts` for
  examples) between the recorded commit and `HEAD` to see what actually changed, then update only
  the affected doc section(s) - don't regenerate everything unless the diff is broad enough to
  warrant it.
- After updating, bump `git-commit`/`package-version`/`date` in the baseline block to the new
  `HEAD` (only once the docs are verified accurate as of that commit).
- **Re-read a signature from source before moving a section between these files.** The move looks
  mechanical and is not: the sections moved out of the old `docs/api.md` were at a baseline three
  refactors old, and carried a `getSystemInfo(packageManager, options)` and a `detectChangeHash`
  that no longer existed.
- **`docs-api.spec.ts` is the only thing that ever looks at these docs.** It imports every name
  `docs/rman.md`'s Installation block advertises and type-checks its command-declaration example
  verbatim, so a name the package stops exporting fails at compile time. It is a **floor, not a
  contract**: a name *added* to the package does not fail it, and no prose is checked at all. The
  whole arc that made services classes, merged the plugin seams into one `Plugin` and introduced
  `RmanApplication` left the page describing none of it, because nothing looked - mocha transpiles
  without type-checking and no spec imported what the page claims.
- **Check anchors after any heading change.** The last full pass: **243 links, 1 broken** - and that
  one is `packages/rman/README.md -> LICENSE`, which resolves in the *published* package, where
  postbuild copies the root LICENSE beside the README. A link to a missing anchor lands silently at
  the top of the page, so nothing else reports it.
