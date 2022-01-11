import fs from 'fs';
import path from 'path';
import {IWorkspaceInfo, IWorkspaceProvider} from '../types';
import {NpmProvider} from '../providers/npm-provider';

const providers: IWorkspaceProvider[] = [
    new NpmProvider()
];

export function resolveRoot(root?: string, deep?: number): IWorkspaceInfo {
    root = root || process.cwd();
    deep = deep ?? 10;
    while (deep-- >= 0 && fs.existsSync(root)) {
        for (let i = providers.length - 1; i >= 0; i--) {
            const provider = providers[i];
            const inf = provider.parse(root);
            if (inf)
                return inf;
        }
        root = path.resolve(root, '..');
    }
    throw new Error('No project workspace detected');
}
