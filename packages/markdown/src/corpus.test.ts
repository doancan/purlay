/**
 * The conformance corpus (D-192): the inputs a second implementation of this reading is held to.
 *
 * `readMarkdown` is the definition of what a message means (D-101) and the client draws from the raw text, so
 * a client that is not this engine — the macOS application reads with a different parser — is right exactly to
 * the extent it produces the same narrowed tree. The corpus is the list of inputs it is tried on; the expected
 * trees are never written here, they are what this engine says, so the definition stays one thing.
 *
 * What this test holds is that the corpus is *worth* being held to: it reaches every kind of node the tree has,
 * every bound that makes a body be shown as typed, both sides of the one rule about addresses, and it is
 * stable — the same input, the same reading, every time.
 */
import { describe, expect, test } from 'bun:test';
import { CORPUS, serialiseReading } from './corpus';
import { readMarkdown } from './parse';

const readings = CORPUS.map((entry) => ({ entry, reading: readMarkdown(entry.input) }));

const kindsIn = (value: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) {
    for (const item of value) kindsIn(item, found);
  } else if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record['type'] === 'string') {
      found.add(
        record['type'] === 'list'
          ? record['ordered'] === true
            ? 'list:ordered'
            : 'list:bullet'
          : record['type'],
      );
    }
    for (const child of Object.values(record)) kindsIn(child, found);
  }
  return found;
};

describe('the conformance corpus', () => {
  test('is large enough to mean something, and each case is named once', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(150);
    const names = CORPUS.map((entry) => entry.name);
    expect(names.filter((name, at) => names.indexOf(name) !== at)).toEqual([]);
  });

  test('names every case by what it is about, in the form `group/what`', () => {
    for (const entry of CORPUS) expect(entry.name).toMatch(/^[a-z][a-z-]*\/[a-z0-9][a-z0-9-]*$/);
  });

  test('is read without a throw: a defect in the engine on an input is a failure here, never a surprise elsewhere', () => {
    for (const { reading } of readings) {
      expect(reading.tree === null ? reading.reason : 'tree').not.toBe('engine');
    }
  });

  test('reaches every kind of node the narrowed tree has', () => {
    const kinds = new Set<string>();
    for (const { reading } of readings) {
      if (reading.tree !== null) kindsIn(serialiseReading(reading), kinds);
    }
    const wanted = [
      'root',
      'paragraph',
      'heading',
      'code',
      'blockquote',
      'list:ordered',
      'list:bullet',
      'listItem',
      'table',
      'tableRow',
      'tableCell',
      'thematicBreak',
      'text',
      'inlineCode',
      'emphasis',
      'strong',
      'delete',
      'link',
      'break',
    ];
    expect(wanted.filter((kind) => !kinds.has(kind))).toEqual([]);
  });

  test('reaches a task item both ways, and an item that is no task', () => {
    const checked = new Set<unknown>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>;
        if (record['type'] === 'listItem') checked.add(record['checked']);
        Object.values(record).forEach(walk);
      }
    };
    for (const { reading } of readings) walk(serialiseReading(reading));
    expect([...checked].sort()).toEqual([false, null, true]);
  });

  test('reaches every column alignment', () => {
    const aligns = new Set<unknown>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>;
        if (record['type'] === 'table')
          for (const align of record['align'] as unknown[]) aligns.add(align);
        Object.values(record).forEach(walk);
      }
    };
    for (const { reading } of readings) walk(serialiseReading(reading));
    expect([...aligns].map(String).sort()).toEqual(['center', 'left', 'null', 'right']);
  });

  test('reaches every reason a body is shown as typed', () => {
    const reasons = new Set(
      readings.flatMap(({ reading }) => (reading.tree === null ? [reading.reason] : [])),
    );
    expect([...reasons].sort()).toEqual(['delimiters', 'depth', 'nesting', 'run']);
  });

  test('reaches both sides of every bound: just inside it, which is formatted, and just past it', () => {
    const formatted = (name: string): boolean =>
      readings.find(({ entry }) => entry.name === name)?.reading.tree !== null;
    expect(formatted('bounds/nesting-at-limit')).toBe(true);
    expect(formatted('bounds/nesting')).toBe(false);
    expect(formatted('bounds/delimiters-in-code')).toBe(true);
    expect(formatted('bounds/delimiters')).toBe(false);
    expect(formatted('bounds/run-at-limit')).toBe(true);
    expect(formatted('bounds/run')).toBe(false);
    expect(formatted('bounds/depth-just-under')).toBe(true);
    expect(formatted('bounds/depth')).toBe(false);
  });

  test('reaches the one rule about addresses on both sides: a safe one is a link, anything else is its label', () => {
    const linked = (name: string): boolean =>
      JSON.stringify(
        serialiseReading(readings.find(({ entry }) => entry.name === name)?.reading),
      ).includes('"type":"link"');
    for (const safe of ['link/inline-https', 'link/inline-http', 'link/mailto', 'link/angle']) {
      expect({ safe, linked: linked(safe) }).toEqual({ safe, linked: true });
    }
    for (const unsafe of [
      'link/javascript',
      'link/data',
      'link/vbscript',
      'link/file',
      'link/ftp',
      'link/relative-path',
      'link/protocol-relative',
      'link/tel',
      'link/mixed-case-javascript',
      'link/entity-obfuscated',
    ]) {
      expect({ unsafe, linked: linked(unsafe) }).toEqual({ unsafe, linked: false });
    }
  });

  test('writes every link as an address a client may open, and nothing else', () => {
    const addresses: unknown[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>;
        if (record['type'] === 'link') addresses.push(record['url']);
        Object.values(record).forEach(walk);
      }
    };
    for (const { reading } of readings) walk(serialiseReading(reading));
    expect(addresses.length).toBeGreaterThan(10);
    for (const address of addresses) {
      expect(typeof address).toBe('string');
      expect(String(address)).toMatch(/^(https?:\/\/|mailto:)/);
    }
  });

  test('is stable: reading an input twice is the same reading', () => {
    for (const { entry, reading } of readings) {
      expect({
        name: entry.name,
        same: JSON.stringify(serialiseReading(readMarkdown(entry.input))),
      }).toEqual({
        name: entry.name,
        same: JSON.stringify(serialiseReading(reading)),
      });
    }
  });

  test('serialises to JSON a client can read: no class instance, no symbol, no function', () => {
    for (const { reading } of readings) {
      const text = JSON.stringify(serialiseReading(reading));
      expect(text).not.toContain('SafeHref');
      expect(JSON.parse(text)).toEqual(serialiseReading(reading));
    }
  });
});
