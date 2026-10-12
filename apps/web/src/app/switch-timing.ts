/**
 * The channel switch, measured in the page and kept there (O-5, `PRD.md` §5's 100 ms budget).
 *
 * Whether the feed needs virtualizing is to be decided from real use, and nothing measured a switch
 * outside the browser suite. Here the router marks every change of address, and the feed, once the new
 * channel's rows are drawn, measures from that mark: a `purlay:channel-switch` entry in the browser's
 * own performance timeline. Nothing leaves the device (D-44); a person who wants the numbers reads them
 * there — `performance.getEntriesByName('purlay:channel-switch')`.
 *
 * The mark is cleared by the measure, so a feed that draws again without a navigation is not a second
 * switch, and the first load of the page, which no navigation began, is none.
 */
export const ROUTE_MARK = 'purlay:route';
export const SWITCH_MEASURE = 'purlay:channel-switch';

/** The most switches kept: a long day of use, not a slowly growing heap. */
const KEPT = 500;

export const markRoute = (): void => {
  performance.clearMarks(ROUTE_MARK);
  performance.mark(ROUTE_MARK);
};

export const measureSwitch = (channelId: string): void => {
  const started = performance.getEntriesByName(ROUTE_MARK, 'mark').at(-1);
  if (started === undefined) return;
  performance.clearMarks(ROUTE_MARK);
  if (performance.getEntriesByName(SWITCH_MEASURE, 'measure').length >= KEPT) {
    performance.clearMeasures(SWITCH_MEASURE);
  }
  performance.measure(SWITCH_MEASURE, { start: started.startTime, detail: { channelId } });
};
