import panatesEslint from '@panates/eslint-config-ts';
import globals from 'globals';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    /** `build` is per package now. `old` is the gitignored pre-v1 tree kept locally for
     *  reference - it was only ever passing because its imports happened to be declared in the
     *  root package.json, which the monorepo split moved into `packages/rman`. */
    /**
     * `support/smoke-types/**` is a *fixture*, not source: it imports `rman` by package name so it
     * compiles the way a consumer does, against the built `index.d.ts` rather than against `src`.
     * That is the whole point of it, and it is exactly what `no-extraneous-dependencies` exists to
     * catch everywhere else - so the directory is excluded rather than the rule silenced inline.
     */
    ignores: ['packages/*/build/**', '**/node_modules/**', 'old/**', 'support/smoke-types/**'],
  },
  ...panatesEslint.configs.node,
  {
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
  },
  {
    /**
     * Tests only. In a workspace the dev tooling (mocha, expect, ...) is installed once at the
     * repository root rather than in each package, so `import expect from 'expect'` in a package's
     * tests reads as undeclared unless the rule is pointed at the root.
     *
     * Scoped to tests deliberately: `packageDir` *replaces* the default "nearest package.json"
     * lookup rather than adding to it, so setting it repository-wide made every runtime import in
     * `packages/rman/src` read as undeclared instead (measured - 90 errors on `ansi-colors` and
     * friends, which are declared exactly where they should be). Source keeps the default, which is
     * the check worth having: a runtime import no package declares.
     */
    files: ['packages/*/test/**/*.ts'],
    rules: {
      'import-x/no-extraneous-dependencies': [
        'error',
        {
          /** The repository root (dev tooling) *and* each package (its own deps and peers, which is
           *  how a third-party plugin declares `rman`). `packageDir` replaces the default nearest-package
           *  lookup rather than adding to it, so every root a test may legitimately import from has
           *  to be listed - a new package gets a line here. */
          packageDir: [import.meta.dirname, 'packages/rman'],
          devDependencies: true,
          peerDependencies: true,
        },
      ],
    },
  },
];
