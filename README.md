# rman

Repository manager. This repository is a monorepo:

| Package | |
| --- | --- |
| [`rman`](packages/rman) | the core - packages, versions, changelogs, releases, registries. Language-agnostic. |
| [`@rman/node`](packages/node) | Node.js support - the commands and conventions that only mean something in a Node repository. |

rman began as a Node repository manager. Now that it has an extension system (a repository's own
commands in `.rman/*.mjs`, and shared config packages through `extends`), being a Node repository is
one option rather than the assumption: the core keeps what is true of any repository, and everything
npm- or `package.json`-specific moves into `@rman/node`.

See [`packages/rman/README.md`](packages/rman/README.md) for what rman does and how to use it.
Reference docs follow the same split as the code:

| | |
| --- | --- |
| [`docs/cli-rman.md`](docs/cli-rman.md) | the CLI rman itself ships - plus global options, the shared option groups, and where a command can come from |
| [`docs/cli-node.md`](docs/cli-node.md) | the three commands `@rman/node` adds |
| [`docs/cli/`](docs/cli) | one page per command, whichever package ships it |
| [`docs/rman.md`](docs/rman.md) | the core's programmatic API |
| [`docs/node.md`](docs/node.md) | `@rman/node`'s - its config keys, services and the seams it fills |

## Working on it

```bash
npm install
npm run build     # rman build - every package, in dependency order
npm test          # mocha, across packages/*/test
npm run lint
```

## Licence

MIT
