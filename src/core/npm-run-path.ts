/* eslint-disable max-len */
/**
 * Inspired from [npm-run-path](https://github.com/sindresorhus/npm-run-path)
 */
import process from 'process';
import path from 'path';
import pathKey from 'path-key';

export interface RunPathOptions {
    /**
     Working directory.
     @default process.cwd()
     */
    readonly cwd?: string;

    /**
     PATH to be appended. Default: [`PATH`](https://github.com/sindresorhus/path-key).
     Set it to an empty string to exclude the default PATH.
     */
    readonly path?: string;

    /**
     Path to the Node.js executable to use in child processes if that is different from the current one. Its directory is pushed to the front of PATH.
     This can be either an absolute path or a path relative to the `cwd` option.
     @default process.execPath
     */
    readonly execPath?: string;
}

export type ProcessEnv = Record<string, string | undefined>;

export interface EnvOptions {
    /**
     The working directory.
     @default process.cwd()
     */
    readonly cwd?: string;

    /**
     Accepts an object of environment variables, like `process.env`,
     and modifies the PATH using the correct [PATH key](https://github.com/sindresorhus/path-key).
     Use this if you're modifying the PATH for use in the `child_process` options.
     */
    readonly env?: ProcessEnv;

    /**
     The path to the current Node.js executable. Its directory is pushed to the front of PATH.
     This can be either an absolute path or a path relative to the `cwd` option.
     @default process.execPath
     */
    readonly execPath?: string;
}

/**
 Get your [PATH](https://en.wikipedia.org/wiki/PATH_(variable)) prepended with locally installed binaries.
 @returns The augmented path string.
 @example
 ```
 import childProcess from 'node:child_process';
 import {npmRunPath} from 'npm-run-path';
 console.log(process.env.PATH);
 //=> '/usr/local/bin'
 console.log(npmRunPath());
 //=> '/Users/sindresorhus/dev/foo/node_modules/.bin:/Users/sindresorhus/dev/node_modules/.bin:/Users/sindresorhus/node_modules/.bin:/Users/node_modules/.bin:/node_modules/.bin:/usr/local/bin'
 ```
 */
export function npmRunPath(options: RunPathOptions = {}) {
    const cwd = options.cwd || process.cwd();
    const path_ = options.path || process.env[pathKey()];
    const execPath = options.execPath || process.execPath;

    let previous;
    let cwdPath = path.resolve(cwd);
    const result: string[] = [];

    while (previous !== cwdPath) {
        result.push(path.join(cwdPath, 'node_modules/.bin'));
        previous = cwdPath;
        cwdPath = path.resolve(cwdPath, '..');
    }

    // Ensure the running `node` binary is used.
    result.push(path.resolve(cwd, execPath, '..'));

    return [...result, path_].join(path.delimiter);
}

/**
 @returns The augmented [`process.env`](https://nodejs.org/api/process.html#process_process_env) object.
 @example
 ```
 import childProcess from 'node:child_process';
 import {npmRunPathEnv} from 'npm-run-path';
 // `foo` is a locally installed binary
 childProcess.execFileSync('foo', {
	env: npmRunPathEnv()
});
 ```
 */
export function npmRunPathEnv(options: EnvOptions = {}) {
    const env = {...(options.env || process.env)};
    const path_: string = pathKey({env});
    const opts: RunPathOptions = {...options, path: env[path_]};
    env[path_] = npmRunPath(opts);
    return env;
}
