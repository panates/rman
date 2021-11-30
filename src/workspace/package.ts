import parseNpmScript from '@netlify/parse-npm-script';

export interface RunScriptResult {
    script: string;
    code?: number;
    errorCount: number;
    commands: CommandResult[];
}

export interface ScriptCommand {
    name: string;
    command: string;
    step: string;
}

export interface CommandResult {
    package: string;
    command: string;
    code: number;
    error: any;
    stdout: string;
    stderr: string;
}

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

    getScriptCommands(script: string): ScriptCommand[] {
        const result: ScriptCommand[] = [];
        let scriptInfo: any;
        try {
            scriptInfo = parseNpmScript(this.def, 'npm run ' + script);
        } catch {
            return result;
        }
        if (scriptInfo && scriptInfo.raw)
            for (const step of scriptInfo.steps) {
                const parsed = Array.isArray(step.parsed) ? step.parsed: [step.parsed];
                for (const cmd of parsed) {
                    result.push({
                        name: cmd.split(' ')[0],
                        command: cmd,
                        step: step.name
                    })
                }
            }
        return result;
    }

}
