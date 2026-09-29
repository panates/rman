# rman

Repository manager. This repository is a monorepo:

[![NPM Version][npm-image]][npm-url]
[![NPM Downloads][downloads-image]][downloads-url]
[![CI Tests][ci-test-image]][ci-test-url]
[![Test Coverage][coveralls-image]][coveralls-url]


| Package | |
| --- | --- |
| [`rman`](packages/rman) | everything - the language-agnostic core, plus the built-in plugins that ship with it. |

rman began as a Node repository manager. It has an extension system now - a repository's own
commands in `.rman/*.mjs`, shared config packages through `extends`, and `Plugin` for a whole
technology - so being a Node repository is one option rather than the assumption: the core keeps
what is true of any repository, and everything npm- or `package.json`-specific belongs to the
**`node` built-in**.

That built-in ships *inside* `rman` rather than as a second package to install, and it is **laid
under every repository by default** - so a fresh clone with no `.rmanrc` at all already has the
`node` technology, `clean`, `ci` and the npm publish target, and a repository declaring another
technology (`extends: 'rman:cargo'`) has its own asked about each directory first. It was its own
package, `rman-node`, through the 2.0 betas; the `1.x` line of that name stays on npm and nothing
2.x was ever published under it.

The cost of a default is stated rather than hidden: a repository of some other technology carries
node's `clean` and `ci` in `rman --help` whether or not they mean anything to it. rman ships one
preset, so nothing else is visible today. The thing this replaced was *detection* - asking each
built-in "is this directory yours?" before turning anything on - which cost a catalogue, a memo, a
symbol and a three-condition gate, and answered the same question the platform registry answers now.

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


[npm-image]: https://img.shields.io/npm/v/rman
[npm-url]: https://npmjs.org/package/rman
[downloads-image]: https://img.shields.io/npm/dm/rman.svg
[downloads-url]: https://npmjs.org/package/rman
[ci-test-image]: https://github.com/panates/rman/actions/workflows/test.yml/badge.svg
[ci-test-url]: https://github.com/panates/rman/actions/workflows/test.yml
[coveralls-image]: https://img.shields.io/coveralls/panates/rman/dev.svg
[coveralls-url]: https://coveralls.io/r/panates/rman
