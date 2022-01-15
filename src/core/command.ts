import {AsyncEventEmitter, TypedEventEmitterClass} from 'strict-typed-events';
import chalk from 'chalk';
import type {Repository} from './repository';
import logger from './logger';

export interface CommandEvents {
    start: () => void | Promise<void>;
    finish: (result?: any) => void | Promise<void>;
    error: (e: unknown) => void | Promise<void>;
}

export abstract class Command extends TypedEventEmitterClass<CommandEvents>(AsyncEventEmitter) {
    protected _started = false;
    protected _finished = false;
    abstract commandName: string;

    protected constructor(readonly repository: Repository) {
        super();
    }

    getOption(name: string): any {
        if (this.options[name] != null)
            return this.options[name];
        const o = this.repository.config.commands[this.commandName];
        if (o && typeof o === 'object')
            return o[name];
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
                        logger.error(chalk.red(e));
                        if (this.listenerCount('error'))
                            await this.emitAsync('error', e);
                    } catch {
                        // ignore
                    }
                    reject(e);
                });
        });
    }

    protected abstract _execute(): Promise<any>;

}
