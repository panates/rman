/**
 * Writes `question` to stderr and waits for one key: **Enter** answers `true`, **Esc** or
 * **Ctrl+C** answers `false`. Any other key is ignored.
 *
 * Only for a terminal - the caller checks `process.stdin.isTTY` first, since there is no key to
 * wait for in a pipe.
 */
/* One key rather than a typed answer, because the question is a gate in front of the whole run and
 * the two answers are "go on" and "stop". An escape sequence (an arrow key arrives as `\x1b[A`) is
 * not Esc: only a lone `\x1b` cancels. */
export function askEnterOrEsc(
  question: string,
  /** Where the key comes from - the terminal, unless a caller (a spec) brings its own. */
  stdin: Pick<NodeJS.ReadStream, 'isRaw' | 'setRawMode' | 'resume' | 'pause' | 'on' | 'off'> = process.stdin,
): Promise<boolean> {
  process.stderr.write(question);
  return new Promise(resolve => {
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const finish = (answer: boolean) => {
      stdin.off('data', onKey);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stderr.write('\n');
      resolve(answer);
    };
    const onKey = (data: Buffer) => {
      const key = data.toString();
      if (key === '\r' || key === '\n') finish(true);
      else if (key === '\x1b' || key === '\x03') finish(false);
    };
    stdin.on('data', onKey);
  });
}
