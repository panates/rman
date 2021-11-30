import path from 'path';
import fs from 'fs';

type ExitListener = (signal: NodeJS.Signals | "exit") => void

export function getPackageJson(dirname: string): any {
    const f = path.resolve(dirname, 'package.json');
    if (!fs.existsSync(f))
        return
    return JSON.parse(fs.readFileSync(f, 'utf-8'));
}

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
