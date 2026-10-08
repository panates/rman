import { EventEmitter } from 'node:events';
import { expect } from 'expect';
import { askEnterOrEsc } from '../../src/utils/key-prompt.js';

/** A terminal that types `keys` once the question is up, and records what raw mode was left in. */
function terminal(...keys: string[]) {
  const emitter = new EventEmitter();
  const input = Object.assign(emitter, {
    isRaw: false,
    setRawMode(mode: boolean) {
      input.isRaw = mode;
      return input;
    },
    resume: () => input,
    pause: () => input,
  });
  setImmediate(() => {
    for (const key of keys) emitter.emit('data', Buffer.from(key));
  });
  return input as unknown as NodeJS.ReadStream;
}

describe('utils/askEnterOrEsc', () => {
  const write = process.stderr.write;
  beforeEach(() => {
    process.stderr.write = (() => true) as typeof process.stderr.write;
  });
  afterEach(() => {
    process.stderr.write = write;
  });

  it('answers yes on Enter, and puts raw mode back', async () => {
    const input = terminal('\r');
    expect(await askEnterOrEsc('go? ', input)).toBe(true);
    expect(input.isRaw).toBe(false);
  });

  it('answers no on Esc and on Ctrl+C', async () => {
    expect(await askEnterOrEsc('go? ', terminal('\x1b'))).toBe(false);
    expect(await askEnterOrEsc('go? ', terminal('\x03'))).toBe(false);
  });

  /** An arrow key arrives as an escape sequence; only a lone Esc cancels. */
  it('ignores any other key, an arrow key included', async () => {
    expect(await askEnterOrEsc('go? ', terminal('x', '\x1b[A', '\r'))).toBe(true);
  });
});
