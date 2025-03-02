import path from 'path';
import { exec } from './exec.js';
import { PackageNotFoundError } from './package-not-found-error.js';

export namespace NpmHelper {}

export interface NpmOptions {
  cwd?: string;
  userconfig?: string;
}

export class NpmHelper {
  cwd: string;
  userconfig?: string;

  constructor(options?: NpmOptions) {
    this.cwd = options?.cwd || process.cwd();
    this.userconfig = options?.userconfig ? path.resolve(this.cwd, options.userconfig) : undefined;
  }

  async getPackageInfo(packageName: string): Promise<any> {
    const argv = ['view', packageName, '--json'];
    if (this.userconfig) argv.push('--userconfig', this.userconfig);
    const x = await exec('npm', { cwd: this.cwd, argv });
    if (x && x.stdout) {
      if (x.code && x.stdout.includes('404')) {
        throw new PackageNotFoundError('Package ' + packageName + ' not found in repository');
      }
      const b = x.stdout.indexOf('{');
      const e = x.stdout.lastIndexOf('}');
      const s = x.stdout.substring(b, e + 1);
      try {
        if (s) return JSON.parse(s);
      } catch {
        //
      }
    }
    throw new Error('Unable to fetch version info');
  }
}
