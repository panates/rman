import { ChildProcess, spawn, SpawnOptions } from 'child_process';
import { onExit } from 'signal-exit';
import { npmRunPathEnv } from './npm-run-path.js';

export interface IExecutorOptions {
  stdio?: 'inherit' | 'pipe';
  cwd?: string;
  argv?: string[];
  env?: Record<string, string | undefined>;
  shell?: boolean;
  onSpawn?: (childProcess: ChildProcess) => void;
  onLine?: (line: string, stdio: 'stderr' | 'stdout') => void;
  onData?: (data: string, stdio: 'stderr' | 'stdout') => void;
  throwOnError?: boolean;
}

export interface ExecuteCommandResult {
  code?: number;
  error?: Error;
  stdout?: string;
}

const runningChildren = new Map<number, ChildProcess>();

export async function exec(command: string, options?: IExecutorOptions): Promise<ExecuteCommandResult> {
  const opts = {
    shell: true,
    throwOnError: true,
    ...options,
  }
  opts.env = {
    ...npmRunPathEnv({cwd: opts.cwd}),
    ...opts.env
  }
  if (process.env.TS_NODE_PROJECT)
    delete opts.env.TS_NODE_PROJECT;
  opts.cwd = opts.cwd || process.cwd();

  const spawnOptions: SpawnOptions = {
    stdio: opts.stdio || 'pipe',
    env: opts.env,
    cwd: opts.cwd,
    shell: opts.shell,
    windowsHide: true
  }

  const result: ExecuteCommandResult = {
    code: undefined,
    stdout: ''
  }

  let buffer = '';

  const processData = (data: string, stdio: 'stderr' | 'stdout') => {
    buffer += '' + data;
    result.stdout += '' + data;
    if (opts.onData)
      opts.onData(data, stdio);
  }

  const processLines = (stdio: 'stderr' | 'stdout', flush?: boolean) => {
    let chunk = buffer;
    let i: number;
    if (flush && !chunk.endsWith('\n'))
      chunk += '\n';
    while ((i = chunk.indexOf('\n')) >= 0) {
      const line = chunk.substring(0, i);
      chunk = chunk.substring(i + 1);
      if (opts.onLine)
        opts.onLine(line, stdio);
    }
    buffer = chunk;
  }

  const child = spawn(command, opts.argv || [], spawnOptions);
  if (child.pid) {
    runningChildren.set(child.pid, child);
    if (opts.onSpawn)
      opts.onSpawn(child);
  }
  child.stdout?.on('data', (data) => {
    processData(data, 'stdout')
    processLines('stdout');
  });
  child.stderr?.on('data', (data) => {
    processData(data, 'stderr');
    processLines('stderr');
  });

  return new Promise((resolve, reject) => {
    let resolved;
    child.on('error', (err: any) => {
      if (child.pid)
        runningChildren.delete(child.pid);
      processLines('stdout', true);
      processLines('stderr', true);
      if (resolved)
        return;
      result.code = err.code || 1;
      if (!err) {
        const text = `Command failed (${result.code})`;
        err = new Error(text);
      }
      if (typeof err === 'string')
        err = new Error(err);
      result.error = err;
      resolved = true;
      if (opts.throwOnError)
        return reject(result.error);
      resolve(result);
    });
    child.on('close', (code?: number) => {
      if (child.pid)
        runningChildren.delete(child.pid);
      processLines('stdout', true);
      processLines('stderr', true);
      if (resolved)
        return;
      result.code = code;
      resolved = true;
      if (code) {
        const text = `Command failed (${result.code})`;
        result.error = new Error(text);
      }
      return resolve(result);
    });
  });
}

onExit(() => {
  runningChildren.forEach((child) => {
    child.kill();
  })
})
