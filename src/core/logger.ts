import stripColor from 'strip-color';

export type LogHandler = (level: string, message: any, ...optionalParams: any[]) => void;

export type LogBufferItem = [level: string, message: any, ...optionalParams: any[]];

export class Logger {
    private _handler?: LogHandler;
    private _buffer: LogBufferItem[] = [];
    private _retain = false;
    colors = true;

    log(level: 'info' | 'warn' | 'error' | 'debug' | 'trace' , message: any, ...optionalParams: any[]): void {
        if (!this.colors) {
            if (typeof message === 'string')
                message = stripColor(message);
            optionalParams = optionalParams.map(v =>
                typeof v === 'string' ? stripColor(v) : v
            )
        }
        if (this._retain) {
            this._buffer.push([level, message, ...optionalParams]);
            return;
        }
        if (this._handler)
            this._handler(level, message, ...optionalParams);
    }

    info(message: any, ...optionalParams: any[]): void {
        this.log('info', message, ...optionalParams);
    }

    warn(message: any, ...optionalParams: any[]): void {
        this.log('warn', message, ...optionalParams);
    }

    error(message: any, ...optionalParams: any[]): void {
        this.log('error', message, ...optionalParams);
    }

    debug(message: any, ...optionalParams: any[]): void {
        this.log('debug', message, ...optionalParams);
    }

    trace(message: any, ...optionalParams: any[]): void {
        this.log('trace', message, ...optionalParams);
    }

    setHandler(handler: LogHandler): void {
        this._handler = handler;
    }

    retain(): void {
        this._retain = true;
    }

    release(): void {
        this._retain = false;
        const buffer = this._buffer;
        this._buffer = [];
        if (this._handler) {
            for (const buf of buffer) {
                this._handler(...buf);
            }
        }
    }

}

const logger = new Logger();

export default logger;
