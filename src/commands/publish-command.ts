import path from 'path';
import yargs from 'yargs';
import {Repository} from '../core/repository';
import {RunCommand} from './run-command';
import {MultiTaskCommand} from './multi-task-command';
import {ExecuteCommandResult} from '../utils/execute';

export class PublishCommand extends RunCommand<PublishCommand.Options> {

    static commandName = 'publish';

    constructor(readonly repository: Repository,
                options?: PublishCommand.Options) {
        super(repository, 'publish', options);
    }

    protected _prepareTasks(): void {
        const packages = this.repository.getPackages({toposort: true});
        for (const p of packages) {
            const j = {...p.json};
            j.scripts.publish = j.scripts.publish || 'npm publish';
            this._prepareTasksFromScripts(p, j);
        }
        const contents = this.getOption('contents');
        if (contents) {
            for (const task of this._tasks) {
                const basename = path.basename(task.package.dirname);
                const cwd = path.resolve(this.repository.dirname, contents, basename);
                for (const step of task.steps) {
                    if (step.name === 'publish')
                        step.cwd = cwd;
                }
            }
        }
    }

    protected async _executeStep(task: MultiTaskCommand.Task, step: MultiTaskCommand.TaskStep): Promise<ExecuteCommandResult> {
        console.log(step.cmd, step.cwd);
        return {code: 0}
    }

    protected _onStepResult(task: MultiTaskCommand.Task,
                            step: MultiTaskCommand.TaskStep,
                            stepResult: MultiTaskCommand.TaskStepResult
    ): MultiTaskCommand.TaskStepResult {
        if (step.name === 'publish' && stepResult.error) {
            if (stepResult.error.message.includes('403 Forbidden') &&
                stepResult.error.message.includes('previously published')) {
                stepResult.error = new Error('Previously published');
            }
        }
        return super._onStepResult(task, step, stepResult);
    }

}

export namespace PublishCommand {
    export interface Options extends RunCommand.Options {
        contents?: string;
    }

    export class Task extends RunCommand.Task {
    }

    export const cliCommandOptions: Record<string, yargs.Options> = {
        ...RunCommand.cliCommandOptions,
        'contents': {
            describe: '# Subdirectory to publish',
            type: 'string'
        }
    };

    export function initCli(workspace: Repository, program: yargs.Argv) {
        program.command({
            command: 'publish [...options]',
            describe: 'Publish packages in the current project',
            builder: (cmd) => {
                return cmd
                    .example("$0 publish", '')
                    .example("$0 publish --contents dist", '# publish package from built directory')
                    .option(PublishCommand.cliCommandOptions);
            },
            handler: async (options) => {
                await new PublishCommand(workspace, {...options, script: 'publish'} as Options).execute();
            }
        })
    }
}
