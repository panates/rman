import {exec} from './exec';

export class PackageNotFoundError extends Error {

}

export namespace NpmHelper {


}

export interface NpmOptions {
    cwd?: string;
}

export class NpmHelper {
    cwd: string;

    constructor(options?: NpmOptions) {
        this.cwd = options?.cwd || process.cwd();
    }

    async getPackageInfo(packageName: string): Promise<any> {
        const x = await exec('npm', {
            cwd: this.cwd,
            argv: ['view', packageName, '--json']
        });
        if (x && x.stdout) {
            if (x.code && x.stdout.includes('404'))
                return new PackageNotFoundError('Package ' + packageName + ' not found in repository');
            const b = x.stdout.indexOf('{');
            const e = x.stdout.lastIndexOf('}');
            const s = x.stdout.substring(b, e + 1);
            try {
                if (s)
                    return JSON.parse(s);
            } catch {
                //
            }
        }
        throw new Error('Unable to fetch version info');
    }

}
