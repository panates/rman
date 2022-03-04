import {AsyncEventEmitter, TypedEventEmitterClass} from 'strict-typed-events';
import npmlog from 'npmlog';
import isCi from 'is-ci';
import yargs from 'yargs';
import merge from 'putil-merge';
import './logger';
import {isTTY} from '../utils/constants';
import chalk from 'chalk';
import figures from 'figures';
import logger from 'npmlog';

const noOp = () => void (0);

export interface CommandEvents {
    start: () => void | Promise<void>;
    finish: (error?: any, result?: any) => void | Promise<void>;
    error: (e: unknown) => void | Promise<void>;
}

export abstract class Command<TOptions extends Command.GlobalOptions = Command.GlobalOptions>
    extends TypedEventEmitterClass<CommandEvents>(AsyncEventEmitter) {
    protected _started = false;
    protected _finished = false;
    protected _options!: TOptions;
    public logger: npmlog.Logger = npmlog;

    static commandName: string;

    constructor(options?: TOptions) {
        super();
        this._options = options || {} as TOptions;
        if (isCi)
            this.options.ci = true;
        this.logger.separator = chalk.gray(figures.lineVerticalDashed0);
        Object.defineProperty(this.logger, 'levelIndex', {
            get(): any {
                return logger.levels[logger.level] || 0;
            }
        })
    }

    get options(): TOptions {
        return this._options;
    }

    get commandName(): string {
        return Object.getPrototypeOf(this).constructor.commandName;
    }

    async execute(): Promise<any> {
        if (this._finished) {
            this._finished = false;
            this._started = false;
        }
        if (!this._started) {
            this._started = true;
            await this.emitAsync('start');
        }
        this._started = true;
        try {
            this.logger.level = this.options.logLevel ||
                (this.options.ci ? 'error' : 'info');
            if (this.options.ci || !isTTY) {
                this.logger.disableColor();
                this.logger.disableUnicode();
            } else {
                this.logger.enableColor();
                this.logger.enableUnicode();
            }

            if (this._preExecute)
                await this._preExecute();
            const v = await this._execute();
            if (this._postExecute)
                await this._postExecute();
            await this.emitAsync('finish', undefined, v).catch(noOp);
            this.disableProgress();
            this.logger.resume();
            this.logger.info('', 'Command completed')
            return v;
        } catch (e: any) {
            this.disableProgress();
            await this.emitAsync('finish', e).catch(noOp);
            if (this.listenerCount('error'))
                await this.emitAsync('error', e).catch(noOp);
            this.logger.resume();
            throw e;
        } finally {
            this._finished = true;
        }
    }

    protected async enableProgress() {
        if (this.options.ci || !isTTY || (this._screen && this._screen.visible))
            return;
    }

    protected disableProgress(): void {
        //
    }

    protected abstract _execute(): Promise<any>;

    protected async _preExecute(): Promise<void> {
        logger.info('rman', `Executing "${this.commandName}" command`);
    }

    protected async _postExecute?(): Promise<void>;

}

export namespace Command {

    export interface GlobalOptions {
        logLevel?: string;
        json?: boolean;
        ci?: boolean;
    }

    export const globalOptions: Record<string, yargs.Options> = {
        'log-level': {
            defaultDescription: "info",
            describe: "Set log level",
            choices: ['silly', 'verbose', 'info', 'output', 'notice', 'success', 'warn', 'error', 'silent'],
            requiresArg: true
        },
        'json': {
            alias: 'j',
            describe: '# Stream log as json',
            type: 'boolean'
        },
        'ci': {
            hidden: true,
            type: "boolean"
        }
    }

    export function composeOptions<TOptions extends GlobalOptions = GlobalOptions>(
        commandName: string, yargArgs: any, config: any
    ): Partial<TOptions> {
        const result = merge({}, yargArgs) as TOptions;
        merge(result, config, {filter: (_, key) => key !== 'command'})
        const cfgCmd = config.command && typeof config.command === 'object' ?
            config.command[commandName] : undefined;
        if (cfgCmd && typeof cfgCmd === 'object')
            merge(result, cfgCmd);
        return result;
    }
}
