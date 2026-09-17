/**
 * Development-time entry point, **never published**.
 *
 * This package's published root is its `build` directory (see `support/postbuild.cjs`), so
 * `package.json#exports` points at `./index.js` meaning `build/index.js`. Inside this checkout that
 * path does not exist, and anything resolving the package by name - the other workspace package
 * importing it, a plugin loaded through `.rmanrc "plugins"` - fails. This forwards to the build
 * output so in-repo resolution matches what a consumer gets.
 *
 * It sits outside `build`, which is what keeps it out of the published package.
 */
export * from './build/index.js';
