import {AsyncEventEmitter, TypedEventEmitterClass} from 'strict-typed-events';
import chalk from 'chalk';
import stripColor from 'strip-color';
import type {Repository} from './repository';

export interface CommandEvents {
    start: () => void | Promise<void>;
    finish: (result?: any) => void | Promise<void>;
    error: (e: unknown) => void | Promise<void>;
}

export interface CommandOptions {
    logger?: (message?: any, ...optionalParams: any[]) => void;
    color?: boolean;
}

export abstract class Command extends TypedEventEmitterClass<CommandEvents>(AsyncEventEmitter) {
    protected _started = false;
    protected _finished = false;

    protected constructor(readonly repository: Repository, public options: CommandOptions = {}) {
        super();
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
        return new Promise<void>((resolve, reject) => {
            this._execute()
                .then(async (v) => {
                    this._finished = true;
                    try {
                        await this.emitAsync('finish', v);
                    } catch {
                        // ignore
                    }
                    resolve(v);
                })
                .catch(async e => {
                    this._finished = true;
                    try {
                        this.log(chalk.red(e));
                        if (this.listenerCount('error'))
                            await this.emitAsync('error', e);
                    } catch {
                        // ignore
                    }
                    reject(e);
                });
        });
    }

    log(message?: any, ...optionalParams: any[]): void {
        if (this.options.logger) {
            if (this.options.color === false) {
                if (typeof message === 'string')
                    message = stripColor(message);
                optionalParams = optionalParams.map(v =>
                    typeof v === 'string' ? stripColor(v) : v
                )
            }
            this.options.logger(message, ...optionalParams);
        }
    }

    protected abstract _execute(): Promise<any>;

}
