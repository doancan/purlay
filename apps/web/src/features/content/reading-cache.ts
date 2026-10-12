/**
 * A body is read once a session, however often its row mounts (#46).
 *
 * A row parses its body in a memo, so a re-render never reads it again; but a row that unmounts —
 * the person goes to another channel and back — would read every body anew. Readings are kept by
 * the text: the parser is a function of it, the text changes exactly when the message is edited
 * (`edited_at`), and two messages that say the same thing share one reading.
 *
 * **Bounded.** A session that reads a thousand channels does not keep a thousand channels of trees:
 * past `max` the reading used longest ago goes (a `Map` keeps insertion order, and a use moves the
 * entry to the end).
 */
export const readingCache = <T>(read: (text: string) => T, max: number): ((text: string) => T) => {
  const readings = new Map<string, T>();
  return (text) => {
    const known = readings.get(text);
    if (known !== undefined) {
      readings.delete(text);
      readings.set(text, known);
      return known;
    }
    const reading = read(text);
    readings.set(text, reading);
    if (readings.size > max) {
      const oldest = readings.keys().next();
      if (oldest.done !== true) readings.delete(oldest.value);
    }
    return reading;
  };
};
