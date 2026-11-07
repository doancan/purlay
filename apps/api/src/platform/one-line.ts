/**
 * The first line with something on it, trimmed and cut to `max` characters with an ellipsis, for a place that shows a long
 * text as one line (a hit of the find). A cut never leaves half of a character that takes two code units.
 */
export const oneLine = (text: string, max: number): string => {
  const line =
    text
      .split('\n')
      .find((candidate) => candidate.trim() !== '')
      ?.trim() ?? '';
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  const splitPair = last >= 0xd800 && last <= 0xdbff;
  return `${splitPair ? cut.slice(0, -1) : cut}…`;
};
