// noinspection ES6UnusedImports
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import path from 'path';
import fs from 'fs';
import CallSite = NodeJS.CallSite;

export function getDirname(): string {
    const pst = Error.prepareStackTrace;
    Error.prepareStackTrace = function (_, stack) {
        Error.prepareStackTrace = pst;
        return stack;
    };

    const e = new Error();
    if (!e.stack)
        throw Error('Can not parse stack');
    const stack: CallSite[] = (e.stack as unknown as CallSite[]).slice(1);
    while (stack) {
        const frame = stack.shift();
        const filename = frame && frame.getFileName();
        if (filename)
            return path.dirname(filename).replace('file://', '');
    }
    throw Error('Can not parse stack');
}

export function getPackageJson(dirname: string): any {
    const f = path.resolve(dirname, 'package.json');
    if (!fs.existsSync(f))
        return
    return JSON.parse(fs.readFileSync(f, 'utf-8'));
}

export type ExitListener = (signal: NodeJS.Signals | "exit") => void

export function onProcessExit(listener: ExitListener, forceExit = true) {
    (["SIGTERM", "SIGINT"] as const).forEach((event) =>
        process.once(event, (signal: NodeJS.Signals) => {
            listener(signal)
            if (forceExit) process.exit(1)
        })
    )
    process.once("exit", () => listener("exit"))
}

export function setFind<T>(set: Set<T>, cb: (item: T) => boolean) {
    for (const e of set) {
        if (cb(e))
            return e;
    }
}
