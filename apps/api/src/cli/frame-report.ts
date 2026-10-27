/**
 * The check on the frame budget in use (#61, D-198): a stretch of the API's log in, the numbers
 * that decision rests on out — the synthetic measurement is `bun run measure:frames`.
 *
 *   bun run report:frames <log>...       one or more NDJSON log files, as the API writes them
 *   … | bun run report:frames            or the log on standard input
 *
 * Read from what is already written (`realtime/frame-meter.ts`): each socket's closing line carries
 * `frames`, `peakPerSecond` and `refused`; a frame or a send refused for the budget, and an HTTP request
 * answered `429`, each leave a line of their own. What is answered: the highest per-second rate a
 * connection reached, as the 99th percentile and the maximum, against the burst it is allowed; and
 * every refusal, which for legitimate use must be none. Lines that are not the API's JSON are counted
 * and skipped, never guessed at.
 */
import { SOCKET_FRAME_BUDGET } from '../realtime/rate-limiter';

export interface FrameReport {
  readonly sockets: number;
  readonly frames: number;
  readonly peakP99: number;
  readonly peakMax: number;
  /** Frames refused on sockets, as their closing lines count them. */
  readonly framesRefused: number;
  /** Sends refused for the person's write budget, and HTTP requests answered 429. */
  readonly writesRefused: number;
  readonly httpRefused: number;
  /** Lines that were not JSON. */
  readonly unreadable: number;
}

const numberIn = (line: object, field: string): number | null => {
  const value: unknown = Reflect.get(line, field);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/** The 99th percentile by nearest rank; 0 when there is nothing. */
const p99 = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.99) - 1] ?? 0;
};

export const summarise = (lines: Iterable<string>): FrameReport => {
  const peaks: number[] = [];
  let frames = 0;
  let framesRefused = 0;
  let writesRefused = 0;
  let httpRefused = 0;
  let unreadable = 0;
  for (const text of lines) {
    if (text.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      unreadable += 1;
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      unreadable += 1;
      continue;
    }
    const line = parsed;
    const message: unknown = Reflect.get(line, 'msg');
    if (message === 'socket closed') {
      const peak = numberIn(line, 'peakPerSecond');
      if (peak !== null) peaks.push(peak);
      frames += numberIn(line, 'frames') ?? 0;
      framesRefused += numberIn(line, 'refused') ?? 0;
    } else if (message === 'send refused: over the user write budget') {
      writesRefused += 1;
    } else if (message === 'request' && Reflect.get(line, 'status') === 429) {
      httpRefused += 1;
    }
  }
  return {
    sockets: peaks.length,
    frames,
    peakP99: p99(peaks),
    peakMax: peaks.length === 0 ? 0 : Math.max(...peaks),
    framesRefused,
    writesRefused,
    httpRefused,
    unreadable,
  };
};

/** What the report says, in the terms D-198 is held to. */
export const describe = (report: FrameReport): readonly string[] => {
  const { perSecond, burst } = SOCKET_FRAME_BUDGET;
  const refusals = report.framesRefused + report.writesRefused + report.httpRefused;
  return [
    `sockets closed: ${String(report.sockets)}, frames: ${String(report.frames)}`,
    `peak frames in a second, p99: ${String(report.peakP99)}, max: ${String(report.peakMax)} — the budget is ${String(perSecond)}/s with a burst of ${String(burst)}`,
    `refused: ${String(report.framesRefused)} frames, ${String(report.writesRefused)} sends, ${String(report.httpRefused)} HTTP requests`,
    refusals === 0 && report.peakP99 <= burst
      ? 'frame budget: legitimate use met no refusal, inside the burst'
      : 'frame budget: something met it — read the refusals, and D-198 for what it reverses on',
    ...(report.unreadable === 0
      ? []
      : [`lines that were not JSON, skipped: ${String(report.unreadable)}`]),
  ];
};

/** The report of these files, or of standard input when there are none. */
export const reportOf = async (
  files: readonly string[],
  stdin: () => Promise<string>,
): Promise<readonly string[]> => {
  const texts =
    files.length === 0
      ? [await stdin()]
      : await Promise.all(files.map(async (file) => await Bun.file(file).text()));
  return describe(summarise(texts.flatMap((text) => text.split('\n'))));
};

if (import.meta.main) {
  const lines = await reportOf(process.argv.slice(2), Bun.stdin.text.bind(Bun.stdin));
  for (const line of lines) console.log(line);
}
