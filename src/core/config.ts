import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import merge from 'putil-merge';
import {getPackageJson} from '../utils';

export class Config {

    constructor(public data: any) {
    }

    getObject(key: string, def?: any): any | undefined {
        const v = this.get(key);
        if (v != null && typeof v === 'object')
            return v;
        return def;
    }

    getString(key: string, def?: string): string | undefined {
        const v = this.get(key);
        if (v != null && typeof v !== 'object')
            return '' + v;
        return def;
    }

    getNumber(key: string, def?: number): number | undefined {
        const v = this.get(key);
        if (v != null && typeof v !== 'object') {
            const n = parseFloat(v);
            if (!isNaN(n))
                return n;
        }
        return def;
    }

    get(key: string): any {
        const keys = key.split('.');
        let o = this.data;
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (o.hasOwnProperty(k)) {
                if (i === keys.length - 1)
                    return o[k];
                if (o[k] && typeof o[k] === 'object') {
                    o = o[k];
                } else return;
            }
        }
    }

    static resolve(dirname: string): Config {
        const data = {};
        const pkgJson = getPackageJson(dirname);
        if (pkgJson && typeof pkgJson.rman === 'object')
            merge(data, pkgJson.rman, {deep: true});
        let filename = path.resolve(dirname, '.rman.yml');
        if (fs.existsSync(filename)) {
            const obj = yaml.load(fs.readFileSync(filename, 'utf-8'));
            if (obj && typeof obj === 'object')
                merge(data, obj, {deep: true});
        }
        filename = path.resolve(dirname, '.rmanrc');
        if (fs.existsSync(filename)) {
            const obj = JSON.parse(fs.readFileSync(filename, 'utf-8'));
            if (obj && typeof obj === 'object')
                merge(data, obj, {deep: true});
        }
        return new Config(data);
    }
}
