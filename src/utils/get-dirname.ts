import fs from 'fs';
import path from 'path';
import CallSite = NodeJS.CallSite;

export function getDirname(): string {
  const pst = Error.prepareStackTrace;
  Error.prepareStackTrace = function (_, stack) {
    Error.prepareStackTrace = pst;
    return stack;
  };

  const e = new Error();
  if (!e.stack) throw Error('Can not parse stack');
  const stack: CallSite[] = (e.stack as unknown as CallSite[]).slice(1);
  while (stack.length) {
    const frame = stack.shift();
    const filename = frame && frame.getFileName();
    if (filename) return path.dirname(filename).replace('file://', '');
  }
  throw Error('Can not parse stack');
}

export function getPackageJson(dirname: string): any {
  const f = path.resolve(dirname, 'package.json');
  if (!fs.existsSync(f)) return;
  return JSON.parse(fs.readFileSync(f, 'utf-8'));
}
