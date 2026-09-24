# rman

Repository manager. This repository is a monorepo:

| Package | |
| --- | --- |
| [`rman`](packages/rman) | everything - the language-agnostic core, plus the built-in plugins that ship with it. |

rman began as a Node repository manager. It has an extension system now - a repository's own
commands in `.rman/*.mjs`, shared config packages through `extends`, and `Plugin` for a whole
technology - so being a Node repository is one option rather than the assumption: the core keeps
what is true of any repository, and everything npm- or `package.json`-specific belongs to the
**`node` built-in**.

That built-in ships *inside* `rman` rather than as a second package to install, and shipping it is
not the same as turning it on: it registers when a repository names it (`plugins: ['node']`) or when
detection reads the directory as a Node one, and in any other repository `rman clean` is still
`Unknown argument`. It was its own package, `rman-node`, through the 2.0 betas; the `1.x` line of
that name stays on npm and nothing 2.x was ever published under it.

See [`packages/rman/README.md`](packages/rman/README.md) for what rman does and how to use it.
Reference docs follow the same split as the code:

| | |
| --- | --- |
| [`docs/cli-rman.md`](docs/cli-rman.md) | every command, plus global options, the shared option groups, and where a command can come from |
| [`docs/cli/`](docs/cli) | one page per command |
| [`docs/rman.md`](docs/rman.md) | the programmatic API, the config reference, and the `node` built-in |

**There were four files, two per package, and there is one package now.** `rman-node` was folded
into rman, so `docs/node.md` and `docs/cli-node.md` are gone rather than stale - what was true of
them lives in the two above.

## Working on it

```bash
npm install
npm run build     # plain npm, in dependency order - never `rman build`, which is a bootstrap loop
npm test          # mocha, across packages/*/test
npm run typecheck # what mocha cannot see: the specs' own types
npm run lint
npm run smoke     # the built CLI actually starts, and a consumer's compiler sees what it should
```

## Licence

MIT
