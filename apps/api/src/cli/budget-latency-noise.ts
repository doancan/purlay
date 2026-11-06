/**
 * What CI's `schema` job recorded for `budget:latency` on identical code: 80 runs of three trials, each trial's ACK
 * and fan-out p95 in milliseconds (the artifacts of 2026-11-05, 240 trials; D-267). The noise a runner makes, as it made it.
 */
export interface RecordedRun {
  readonly ack: readonly number[];
  readonly fanOut: readonly number[];
}

export const RECORDED_RUNS: readonly RecordedRun[] = [
  { ack: [15.3, 14.7, 65.7], fanOut: [15.2, 14.6, 65.6] },
  { ack: [15.7, 17.8, 16.7], fanOut: [15.4, 17.8, 16.6] },
  { ack: [11.0, 11.3, 12.4], fanOut: [11.0, 11.2, 12.3] },
  { ack: [19.0, 18.8, 19.2], fanOut: [18.9, 18.8, 18.8] },
  { ack: [16.2, 16.0, 15.3], fanOut: [16.2, 16.0, 15.2] },
  { ack: [16.4, 16.9, 15.9], fanOut: [16.4, 16.8, 15.8] },
  { ack: [13.2, 19.2, 13.9], fanOut: [13.2, 19.2, 13.9] },
  { ack: [15.6, 15.7, 15.9], fanOut: [15.5, 15.6, 15.4] },
  { ack: [14.8, 15.4, 14.9], fanOut: [14.7, 15.1, 14.9] },
  { ack: [18.4, 15.6, 15.8], fanOut: [18.2, 15.5, 15.8] },
  { ack: [13.4, 12.8, 23.5], fanOut: [13.3, 12.8, 22.5] },
  { ack: [16.7, 17.0, 15.6], fanOut: [16.5, 16.9, 15.6] },
  { ack: [15.5, 15.9, 15.7], fanOut: [15.5, 15.9, 15.7] },
  { ack: [13.4, 16.6, 13.1], fanOut: [13.4, 16.5, 13.1] },
  { ack: [16.5, 18.2, 17.3], fanOut: [16.5, 18.2, 17.2] },
  { ack: [13.0, 29.1, 12.6], fanOut: [12.9, 29.0, 12.6] },
  { ack: [17.0, 16.6, 17.3], fanOut: [17.0, 16.5, 17.2] },
  { ack: [15.3, 14.4, 15.1], fanOut: [15.3, 14.2, 15.0] },
  { ack: [21.4, 19.3, 22.4], fanOut: [21.3, 19.1, 22.3] },
  { ack: [14.8, 16.9, 13.0], fanOut: [14.8, 16.7, 13.0] },
  { ack: [17.0, 70.5, 17.7], fanOut: [17.0, 70.5, 17.6] },
  { ack: [12.0, 11.1, 11.9], fanOut: [12.0, 11.1, 11.8] },
  { ack: [16.0, 16.0, 15.0], fanOut: [15.9, 15.8, 14.8] },
  { ack: [11.3, 13.1, 13.3], fanOut: [11.1, 12.7, 13.1] },
  { ack: [15.0, 16.5, 16.4], fanOut: [15.0, 16.4, 16.3] },
  { ack: [12.4, 16.6, 23.3], fanOut: [12.4, 16.5, 23.3] },
  { ack: [14.7, 20.5, 13.3], fanOut: [14.7, 20.4, 13.3] },
  { ack: [13.9, 13.3, 14.1], fanOut: [13.9, 13.2, 14.1] },
  { ack: [13.3, 13.8, 14.0], fanOut: [13.3, 13.7, 14.0] },
  { ack: [13.2, 17.4, 15.2], fanOut: [13.0, 17.3, 15.1] },
  { ack: [16.8, 15.8, 17.0], fanOut: [16.7, 15.7, 17.0] },
  { ack: [13.6, 16.8, 15.7], fanOut: [13.6, 16.8, 15.7] },
  { ack: [16.4, 18.8, 16.4], fanOut: [16.4, 18.8, 16.4] },
  { ack: [22.1, 26.2, 22.4], fanOut: [21.8, 25.4, 22.2] },
  { ack: [13.1, 36.3, 13.6], fanOut: [13.0, 36.3, 13.6] },
  { ack: [16.0, 16.0, 16.3], fanOut: [15.9, 16.0, 16.2] },
  { ack: [15.1, 14.3, 14.0], fanOut: [15.0, 14.2, 13.9] },
  { ack: [13.6, 14.1, 15.4], fanOut: [13.5, 14.1, 15.4] },
  { ack: [16.1, 17.8, 17.3], fanOut: [16.0, 17.7, 17.2] },
  { ack: [16.3, 14.9, 16.6], fanOut: [16.2, 14.9, 16.6] },
  { ack: [20.4, 17.8, 20.7], fanOut: [20.4, 17.7, 20.8] },
  { ack: [17.4, 15.7, 15.3], fanOut: [16.1, 15.6, 15.2] },
  { ack: [16.0, 15.4, 14.6], fanOut: [15.7, 15.4, 14.6] },
  { ack: [20.6, 10.7, 14.6], fanOut: [20.6, 10.7, 14.6] },
  { ack: [9.8, 11.4, 10.4], fanOut: [9.8, 11.4, 10.4] },
  { ack: [12.7, 13.8, 13.8], fanOut: [12.7, 13.8, 13.8] },
  { ack: [15.9, 17.3, 15.9], fanOut: [15.9, 17.2, 15.9] },
  { ack: [15.3, 15.1, 15.4], fanOut: [15.2, 14.8, 15.2] },
  { ack: [10.8, 11.1, 10.6], fanOut: [10.8, 11.0, 10.5] },
  { ack: [12.5, 13.2, 14.0], fanOut: [12.5, 13.2, 14.0] },
  { ack: [17.2, 16.6, 16.1], fanOut: [16.9, 16.4, 16.1] },
  { ack: [15.2, 17.2, 15.7], fanOut: [15.1, 17.2, 15.6] },
  { ack: [32.6, 42.9, 17.6], fanOut: [32.6, 43.0, 17.6] },
  { ack: [17.1, 17.1, 13.6], fanOut: [17.1, 17.1, 13.6] },
  { ack: [17.8, 16.2, 17.0], fanOut: [17.5, 16.2, 16.6] },
  { ack: [17.3, 16.4, 15.8], fanOut: [17.2, 16.3, 15.8] },
  { ack: [17.7, 18.3, 18.0], fanOut: [17.7, 18.2, 18.0] },
  { ack: [16.7, 17.7, 19.0], fanOut: [16.7, 17.7, 19.1] },
  { ack: [45.2, 31.7, 17.3], fanOut: [45.2, 31.5, 17.2] },
  { ack: [15.8, 16.2, 17.0], fanOut: [15.8, 16.2, 17.0] },
  { ack: [12.3, 15.2, 13.7], fanOut: [12.2, 15.2, 13.5] },
  { ack: [28.1, 21.0, 15.5], fanOut: [28.0, 21.0, 15.5] },
  { ack: [14.2, 14.9, 15.2], fanOut: [14.1, 14.9, 15.2] },
  { ack: [16.1, 29.0, 14.5], fanOut: [16.1, 29.0, 14.5] },
  { ack: [16.2, 15.5, 14.9], fanOut: [15.7, 15.5, 14.9] },
  { ack: [12.8, 11.8, 12.0], fanOut: [12.9, 11.8, 11.9] },
  { ack: [12.9, 11.6, 12.8], fanOut: [12.9, 11.6, 12.6] },
  { ack: [15.7, 16.7, 16.5], fanOut: [15.6, 16.7, 16.4] },
  { ack: [30.3, 69.4, 12.7], fanOut: [30.1, 69.3, 12.6] },
  { ack: [16.0, 19.4, 18.4], fanOut: [16.0, 19.3, 18.3] },
  { ack: [11.6, 14.5, 12.0], fanOut: [11.4, 14.5, 12.0] },
  { ack: [18.4, 17.5, 16.6], fanOut: [18.2, 17.2, 16.5] },
  { ack: [14.7, 18.1, 14.5], fanOut: [14.6, 18.0, 14.5] },
  { ack: [16.9, 16.4, 17.7], fanOut: [16.9, 16.1, 17.6] },
  { ack: [13.9, 15.3, 14.3], fanOut: [13.9, 15.2, 14.3] },
  { ack: [15.7, 17.4, 18.2], fanOut: [15.6, 17.4, 18.0] },
  { ack: [15.8, 15.2, 15.5], fanOut: [15.7, 15.0, 15.4] },
  { ack: [16.4, 18.0, 17.1], fanOut: [16.2, 17.9, 17.1] },
  { ack: [16.5, 16.0, 16.8], fanOut: [16.3, 16.0, 16.8] },
  { ack: [16.3, 14.9, 15.2], fanOut: [16.2, 14.8, 15.1] },
];

/**
 * What `budget:latency` recorded for issues' list with chat busy, on a laptop under heavy load (ten cores, load average
 * about 20, six more busy loops): eleven gate runs of three trials, as the lowest and the highest p95 of each run's
 * trials in milliseconds (the log keeps the range, not the middle trial). Local, not CI's: CI's `api-latency` artifacts
 * keep the trials of this metric from now on, and these are replaced by them once there are enough.
 */
export const RECORDED_LOADED_RUNS: readonly {
  readonly lowest: number;
  readonly highest: number;
}[] = [
  { lowest: 12.4, highest: 15.6 },
  { lowest: 13.8, highest: 22.0 },
  { lowest: 21.4, highest: 28.6 },
  { lowest: 14.1, highest: 46.6 },
  { lowest: 12.4, highest: 14.5 },
  { lowest: 9.8, highest: 19.3 },
  { lowest: 8.9, highest: 14.4 },
  { lowest: 14.9, highest: 16.9 },
  { lowest: 11.5, highest: 20.2 },
  { lowest: 22.2, highest: 25.8 },
  { lowest: 20.0, highest: 23.0 },
];
