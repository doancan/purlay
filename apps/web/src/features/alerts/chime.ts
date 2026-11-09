/** One short, soft two-tone cue. No media request, autoplay override or sound queue. */
export interface Chime {
  readonly unlock: () => Promise<boolean>;
  readonly play: (volume: number) => boolean;
  readonly stop: () => void;
  readonly dispose: () => void;
}

export const browserChime = (): Chime | null => {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
  let context: AudioContext | null = null;
  let disposed = false;
  let generation = 0;
  const playing = new Set<OscillatorNode>();
  const stop = (): void => {
    generation += 1;
    for (const node of playing) {
      node.stop();
      node.disconnect();
    }
    playing.clear();
  };
  return {
    unlock: async (): Promise<boolean> => {
      if (disposed) return false;
      const version = generation;
      const current = (): boolean => !disposed && version === generation;
      try {
        context ??= new AudioContext();
        await context.resume();
        return current() && context.state === 'running';
      } catch {
        return false;
      }
    },
    play: (volume): boolean => {
      if (disposed || context?.state !== 'running' || volume <= 0) return false;
      stop();
      const now = context.currentTime;
      const gain = context.createGain();
      gain.connect(context.destination);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime((Math.min(volume, 100) / 100) * 0.08, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
      const tone = context.createOscillator();
      tone.frequency.setValueAtTime(660, now);
      tone.frequency.setValueAtTime(880, now + 0.1);
      tone.connect(gain);
      playing.add(tone);
      tone.onended = (): void => {
        playing.delete(tone);
        tone.disconnect();
        gain.disconnect();
      };
      tone.start(now);
      tone.stop(now + 0.25);
      return true;
    },
    stop,
    dispose: (): void => {
      disposed = true;
      stop();
      void context?.close();
      context = null;
    },
  };
};
