import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installDom } from '../../testing/dom';
import { browserChime } from './chime';

installDom();

class Tone {
  readonly frequency = { setValueAtTime: (): void => undefined };
  onended: (() => void) | null = null;
  starts = 0;
  stops = 0;
  connect(): void {
    /* Native audio output boundary. */
  }
  disconnect(): void {
    /* Native audio output boundary. */
  }
  start(): void {
    this.starts += 1;
  }
  stop(): void {
    this.stops += 1;
  }
}
class Audio {
  static made: Audio[] = [];
  state: AudioContextState = 'suspended';
  currentTime = 0;
  readonly destination = {};
  readonly tones: Tone[] = [];
  readonly peaks: number[] = [];
  resumeResult: Promise<void> | null = null;
  closed = false;
  constructor() {
    Audio.made.push(this);
  }
  async resume(): Promise<void> {
    await this.resumeResult;
    this.state = 'running';
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  createOscillator(): Tone {
    const tone = new Tone();
    this.tones.push(tone);
    return tone;
  }
  createGain(): {
    readonly connect: () => void;
    readonly disconnect: () => void;
    readonly gain: {
      readonly setValueAtTime: () => void;
      readonly linearRampToValueAtTime: (value: number) => void;
      readonly exponentialRampToValueAtTime: () => void;
    };
  } {
    return {
      connect: () => undefined,
      disconnect: () => undefined,
      gain: {
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: (value): void => {
          this.peaks.push(value);
        },
        exponentialRampToValueAtTime: () => undefined,
      },
    };
  }
}
let original: PropertyDescriptor | undefined;
let originalWindow: PropertyDescriptor | undefined;
beforeEach(() => {
  original = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  originalWindow = Object.getOwnPropertyDescriptor(window, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { value: Audio, configurable: true });
  Object.defineProperty(window, 'AudioContext', { value: Audio, configurable: true });
  Audio.made = [];
});
afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(globalThis, 'AudioContext');
  else Object.defineProperty(globalThis, 'AudioContext', original);
  if (originalWindow === undefined) Reflect.deleteProperty(window, 'AudioContext');
  else Object.defineProperty(window, 'AudioContext', originalWindow);
});

describe('the app chime', () => {
  test('a refused browser resume is reported without trying to play', async () => {
    const chime = browserChime();
    await chime?.unlock();
    const audio = Audio.made[0];
    if (audio === undefined) throw new Error('Missing native boundary');
    audio.state = 'suspended';
    audio.resumeResult = Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
    expect(await chime?.unlock()).toBe(false);
    expect(chime?.play(50)).toBe(false);
    chime?.dispose();
  });
  test('creates no audio on load, stays quiet until unlocked, and has no overlapping voices', async () => {
    const chime = browserChime();
    expect(chime).not.toBeNull();
    expect(Audio.made).toHaveLength(0);
    expect(chime?.play(50)).toBe(false);
    expect(await chime?.unlock()).toBe(true);
    expect(chime?.play(0)).toBe(false);
    expect(chime?.play(50)).toBe(true);
    expect(chime?.play(100)).toBe(true);
    expect(chime?.play(1000)).toBe(true);
    const audio = Audio.made[0];
    expect(audio?.peaks).toEqual([0.04, 0.08, 0.08]);
    expect(audio?.tones[0]?.stops).toBe(2);
    chime?.dispose();
    expect(audio?.closed).toBe(true);
    expect(chime?.play(50)).toBe(false);
    expect(await chime?.unlock()).toBe(false);
  });
  test.each(['stop', 'dispose'] as const)('a pending unlock cannot play after %s', async (end) => {
    const chime = browserChime();
    let resume: (() => void) | undefined;
    const unlocking = chime?.unlock();
    const audio = Audio.made[0];
    if (audio === undefined) throw new Error('Audio was not created');
    // Start another unlock while the native resume promise is held.
    await unlocking;
    audio.state = 'suspended';
    audio.resumeResult = new Promise((resolve) => {
      resume = resolve;
    });
    const pending = chime?.unlock();
    chime?.[end]();
    resume?.();
    expect(await pending).toBe(false);
    expect(audio.tones).toHaveLength(0);
  });
});
