
export class Package {
    readonly def: any;
    dependencies: string[] = [];

    constructor(readonly dirname: string, def: any) {
        Object.defineProperty(this, 'def', {
            enumerable: false,
            value: def,
        })
    }

    get name(): string {
        return this.def.name;
    }

    get version(): string {
        return this.def.version;
    }

}
