import fs from 'fs';
import path from 'path';

export class Package {
  private _json: any;
  dependencies: string[] = [];

  constructor(readonly dirname: string) {
    this.reloadJson();
  }

  get basename(): string {
    return path.basename(this.dirname);
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

  get jsonFileName(): string {
    return path.join(this.dirname, 'package.json');
  }

  get isPrivate(): boolean {
    return !!this._json.private;
  }

  reloadJson(): any {
    const f = this.jsonFileName;
    this._json = JSON.parse(fs.readFileSync(f, 'utf-8'));
    return this._json;
  }

  writeJson(): void {
    const f = this.jsonFileName;
    const data = JSON.stringify(this._json, undefined, 2);
    fs.writeFileSync(f, data, 'utf-8');
  }
}
