import {AsyncEventEmitter, TypedEventEmitterClass} from 'strict-typed-events';
import logger from 'npmlog';
import logUpdate from 'log-update';
import isCi from 'is-ci';
import './logger';
import type {Repository} from './repository';
import {isTTY} from '../utils/constants';

export interface CommandEvents {
    start: () => void | Promise<void>;
    finish: (error?: any, result?: any) => void | Promise<void>;
    error: (e: unknown) => void | Promise<void>;
}

export interface CommandOptions {
    json?: boolean;
    logLevel?: string;
    ci?: boolean;
    progress?: boolean;
}

export abstract class Command<TOptions extends CommandOptions = CommandOptions> extends TypedEventEmitterClass<CommandEvents>(AsyncEventEmitter) {
    protected _started = false;
    protected _finished = false;
    protected _options!: TOptions;
    protected _progressTimer?: NodeJS.Timer;
    static commandName: string;

    protected constructor(readonly repository: Repository, options?: TOptions) {
        super();
        this._readOptions(['json', 'logLevel', 'ci', 'progress'], options);
        if (this.options.progress == null)
            this.options.progress = true;
        if (isCi)
            this.options.ci = true;
        if (this.options.ci || !isTTY)
            this.options.progress = false;
    }

    get options(): TOptions {
        return this._options;
    }

    get commandName(): string {
        return Object.getPrototypeOf(this).constructor.commandName;
    }

    protected _readOptions(keys: string[], options?: any): void {
        this._options = {} as TOptions;
        const cfg = this.repository.config.data;
        const cmdConfig = this.repository.config.getObject('command.' + this.commandName);
        for (const k of keys) {
            if (options[k] != null)
                this._options[k] = options[k];
            if (cfg && cfg[k] != null)
                this._options[k] = cfg[k];
            if (cmdConfig && cmdConfig[k] != null)
                this._options[k] = cmdConfig[k];
        }
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
            logger.level = this.options.logLevel ||
                (this.options.ci ? 'error' : 'info');
            if (this.options.ci || !isTTY) {
                logger.disableColor();
                logger.disableUnicode();
            } else {
                logger.enableColor();
                logger.enableUnicode();
            }

            logger.info('project', this.repository.dirname);
            if (this._preExecute)
                await this._preExecute();
            const v = await this._execute();
            if (this._postExecute)
                await this._postExecute();
            await this.emitAsync('finish', undefined, v).catch();
            this.disableProgress();
            logger.resume();
            logger.success('', 'Command completed')
            return v;
        } catch (e: any) {
            this.disableProgress();
            await this.emitAsync('finish', e).catch();
            if (this.listenerCount('error'))
                await this.emitAsync('error', e).catch();
            logger.resume();
            throw e;
        } finally {
            this._finished = true;
        }
    }

    protected enableProgress() {
        if (!this.options.progress || this.options.ci || !isTTY)
            return;
        this._progressTimer = setInterval(() =>
                logUpdate(this._drawProgress()),
            80);
        this._progressTimer.unref();
    }

    protected disableProgress() {
        if (this._progressTimer) {
            clearInterval(this._progressTimer);
            this._progressTimer = undefined;
            logUpdate('');
        }
    }

    protected _drawProgress(): string {
        return '';
    }

    protected abstract _execute(): Promise<any>;

    protected async _preExecute?(): Promise<void>;

    protected async _postExecute?(): Promise<void>;

}
