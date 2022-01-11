import {ChildProcess, spawn, SpawnOptions} from 'child_process';
import chalk from 'chalk';
import {onProcessExit} from '../../utils';
import {npmRunPathEnv} from '../npm-run-path';

export interface IExecutorOptions {
    stdio?: 'inherit' | 'pipe';
    cwd?: string;
    argv?: string[];
    env?: Record<string, string | undefined>;
    shell?: boolean;
    color?: boolean;
    onSpawn?: (childProcess: ChildProcess) => void;
    onLine?: (line: string, stdio: 'stderr' | 'stdout') => void;
    onData?: (data: string, stdio: 'stderr' | 'stdout') => void;
}

export interface ExecuteCommandResult {
    code?: number;
    error?: any;
    stderr: string;
    stdout: string;
}

const runningChildren = new Map<number, ChildProcess>();

export async function execute(command: string, options?: IExecutorOptions): Promise<ExecuteCommandResult> {
    const opts = {
        ...options
    }
    opts.env = {
        ...npmRunPathEnv({cwd: options?.cwd}),
//        FORCE_COLOR: `${chalk.level}`,
        ...opts.env
    }
    opts.cwd = opts.cwd || process.cwd();
    opts.color = opts.color == null ? true : opts.color;

    const spawnOptions: SpawnOptions = {
        stdio: opts.stdio || 'pipe',
        env: opts.env,
        cwd: opts.cwd,
        shell: options?.shell,
        windowsHide: true
    }

    const result: ExecuteCommandResult = {
        code: undefined,
        stderr: '',
        stdout: ''
    }

    const buffer = {
        stdout: '',
        stderr: ''
    };

    const processData = (data: string, stdio: 'stderr' | 'stdout') => {
        buffer[stdio] += data;
        result[stdio] += data;
        if (opts.onData)
            opts.onData(data, stdio);
    }

    const processLines = (stdio: 'stderr' | 'stdout', flush?: boolean) => {
        let chunk = buffer[stdio];
        let i: number;
        if (flush && !chunk.endsWith('\n'))
            chunk += '\n';
        while ((i = chunk.indexOf('\n')) >= 0) {
            const line = chunk.substring(0, i);
            chunk = chunk.substring(i + 1);
            if (opts.onLine)
                opts.onLine(line, stdio);
        }
        buffer[stdio] = chunk;
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

    return new Promise(resolve => {
        let resolved;
        child.on('error', (err: any) => {
            if (child.pid)
                runningChildren.delete(child.pid);
            processLines('stdout', true);
            processLines('stderr', true);
            if (resolved)
                return;
            result.code = err.code || 1;
            result.error = err;
            if (!result.error) {
                const text = `Command failed (${result.code})`;
                result.error =
                    new Error((opts.color ? chalk.red(text) : text) + '\n  ' +
                    opts.color ? chalk.white(err.message) : err.message);
            }
            resolved = true;
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
                result.error = new Error((opts.color ? chalk.red(text) : text));
            }
            return resolve(result);
        });
    });
}

onProcessExit(() => {
    runningChildren.forEach((child) => {
        child.kill();
    })
})
