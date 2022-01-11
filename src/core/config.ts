import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import {getPackageJson} from '../utils';

export interface ICommand {
    exec: IConfigScriptItem[];
    description?: string;
    options?: IConfigScriptOption[];
}

export interface IConfigScriptItem {
    shell?: string;
    script?: string;
    scope?: string;
}

export interface IConfigScriptOption {
    flags: string;
    description?: string;
    defaultValue?: string | boolean;
}

export class Config {

    readonly commands: Record<string, ICommand> = {};

    update(obj: any): void {
        if (obj.commands) {
            for (const [k, o] of Object.entries<any>(obj.commands)) {
                if (!o.exec)
                    continue;
                const exec: IConfigScriptItem[] = [];
                const script = {...o, exec};
                const _execute = (Array.isArray(o.exec) ? o.exec : [o.exec]);
                for (const r of _execute) {
                    if (typeof r === 'string') {
                        exec.push({shell: r});
                    } else if (typeof r === 'object') {
                        exec.push(
                            Object.keys(r)
                                .reduce<IConfigScriptItem>((x, l) => {
                                    if (['shell', 'script', 'scope'].includes(l))
                                        x[l] = r[l];
                                    return x;
                                }, {})
                        );
                    }
                }

                this.commands[k] = script;
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
