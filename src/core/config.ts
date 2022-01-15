import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import {getPackageJson} from '../utils';

export namespace Config {

    export interface ScriptOptions {
        parallel?: boolean;
        concurrency?: number;
        noBail?: boolean;
        noProgress?: boolean;
    }
}

export class Config {
    readonly commands: Record<string, any> = {};
    readonly scripts: Record<string, Config.ScriptOptions> = {};

    update(obj: any): void {
        if (obj.commands) {
            for (const [k, o] of Object.entries<any>(obj.commands)) {
                this.commands[k] = o
            }
        }
        if (obj.scripts) {
            for (const [k, o] of Object.entries<any>(obj.scripts)) {
                this.scripts[k] = {
                    parallel: !!o.parallel,
                    noBail: !!o.noBail,
                    noProgress: !!o.noProgress,
                    concurrency: o.concurrency != null ?
                        parseInt(o.concurrency, 10) || undefined : undefined
                }
            }
        }
    }

    static resolve(dirname: string): Config {
        const config = new Config();
        const pkgJson = getPackageJson(dirname);
        if (pkgJson && typeof pkgJson.rman === 'object')
            config.update(pkgJson.rman);
        let filename = path.resolve(dirname, '.rman.yml');
        if (fs.existsSync(filename)) {
            const obj = yaml.load(fs.readFileSync(filename, 'utf-8'));
            if (typeof obj === 'object')
                config.update(obj);
        }
        filename = path.resolve(dirname, '.rmanrc');
        if (fs.existsSync(filename)) {
            const obj = JSON.parse(fs.readFileSync(filename, 'utf-8'));
            if (typeof obj === 'object')
                config.update(obj);
        }
        return config;
    }
}
