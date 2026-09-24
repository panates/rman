process.env.TS_NODE_PROJECT = __dirname + '/tsconfig-test.json';
/** @type {import('mocha').MochaOptions} */
module.exports = {
  /**
   * **No root hooks any more.** There used to be one, emptying five module-global registries before
   * every test, because two repositories in a process shared them: whichever spec registered first
   * decided the answer for the rest. Each `Repository.create` builds its own `RmanApplication` now,
   * so there is nothing left that could survive a case.
   */
  require: ['@swc-node/register/esm-register'],
  extension: ['ts'],
  spec: './packages/*/test/**/*.spec.ts',
  timeout: 30000,
  parallel: true,
};
