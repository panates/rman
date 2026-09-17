import type { ChildProcess } from 'node:child_process';
import { onExit } from 'signal-exit';

/**
 * Registers `child` to be killed if rman exits while it is still running - Ctrl-C, a signal, a throw
 * on some other path.
 *
 * **Here rather than inside `exec`, because `runBin` needs the same thing and did not have it.** A
 * child spawned by `runBin` (which is what a plugin's or a `.rman/*.mjs` command's `runBin` reaches)
 * outlived an interrupted rman run: the registry and the exit hook lived in `exec.ts` and nothing
 * else could see them. Anything in rman that spawns a process goes through one of those two, so
 * tracking belongs where both can reach it.
 *
 * Untracks itself on `close`/`error`, so a long session does not accumulate dead entries. Adding
 * listeners here is safe alongside the caller's own - an `error` event needs *a* listener, not
 * exactly one, and both `exec` and `runBin` attach theirs anyway.
 */
export function trackChild(child: ChildProcess): void {
  const pid = child.pid;
  /** No pid means the spawn failed before the OS gave it one - there is nothing to kill, and the
   *  caller's own `error` handler is about to report it. */
  if (!pid) return;
  running.set(pid, child);
  const forget = () => running.delete(pid);
  child.on('close', forget);
  child.on('error', forget);
}

const running = new Map<number, ChildProcess>();

onExit(() => {
  running.forEach(child => child.kill());
});
