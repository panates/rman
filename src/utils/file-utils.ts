import fsa from 'fs/promises';
import path from 'path';
import {Stats} from 'node:fs';

export async function fsExists(s: string): Promise<boolean> {
    return fsa.lstat(s).then(() => true).catch(() => false);
}

export async function tryStat(s): Promise<Stats | undefined> {
    return fsa.lstat(s).catch(() => undefined);
}

export async function fsDelete(fileOrDir: string): Promise<boolean> {
    const stat = await tryStat(fileOrDir);
    if (stat) {
        if (stat.isFile() || stat.isSymbolicLink()) {
            await fsa.unlink(fileOrDir);
            return true;
        }
        if (stat.isDirectory()) {
            const list = await fsa.readdir(fileOrDir);
            for (const file of list)
                await fsDelete(path.join(fileOrDir, file));
            await fsa.rmdir(fileOrDir);
            return true;
        }
    }
    return false;
}
