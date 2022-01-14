import fs from 'fs';
import path from 'path';

export class Package {
    private _json: any;
    dependencies: string[] = [];

    constructor(readonly dirname: string) {
        this.reloadJson();
    }

    get name(): string {
        return this._json.name;
    }

    get version(): string {
        return this._json.version;
    }

    get json(): any {
        return this._json;
    }

    get isPrivate(): boolean {
        return !!this._json.private;
    }

    reloadJson(): any {
        const f = path.join(this.dirname, 'package.json');
        this._json = JSON.parse(fs.readFileSync(f, 'utf-8'));
        return this._json;
    }

}
