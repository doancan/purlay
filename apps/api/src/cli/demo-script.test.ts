/**
 * The conversation the demo tells, judged without a database: every message is one the
 * contract accepts, the threads are what the screens need, and the script is the same
 * script every time.
 */
import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { MessageContent } from '@purlay/types';
import {
  PERSONAS,
  apiChannel,
  deploysChannel,
  directMessages,
  incidentsChannel,
  messageCount,
  securityChannel,
  selfNotes,
  type Step,
} from './demo-script';

const everyText = (steps: readonly Step[]): string[] =>
  steps.flatMap((step) => [step.text, ...(step.replies ?? []).map((reply) => reply.text)]);

const all = (): Step[] => [
  ...apiChannel(),
  ...deploysChannel(),
  ...incidentsChannel(),
  ...securityChannel(),
  ...directMessages(),
  ...selfNotes(),
];

describe('the demo script', () => {
  test('every message is content the contract accepts, and none of them is a broadcast', () => {
    for (const text of everyText(all())) {
      expect(Value.Check(MessageContent, text)).toBe(true);
      expect(text).not.toMatch(/@(here|channel|everyone)\b/i);
    }
  });

  test('is the same script every time, so a snapshot of it is a snapshot of one screen', () => {
    expect(JSON.stringify(deploysChannel())).toBe(JSON.stringify(deploysChannel()));
    expect(JSON.stringify(apiChannel())).toBe(JSON.stringify(apiChannel()));
  });

  test('#api is about fifty messages with the three threads and the mentions the screens need', () => {
    const steps = apiChannel();
    expect(messageCount(steps)).toBeGreaterThanOrEqual(45);
    expect(messageCount(steps)).toBeLessThanOrEqual(70);
    const threads = steps.filter((step) => (step.replies?.length ?? 0) > 0);
    expect(threads.map((step) => step.replies?.length)).toEqual([4, 3, 2]);
    expect(threads.filter((step) => step.resolvedBy !== undefined)).toHaveLength(1);
    const mentions = everyText(steps).filter((text) => text.includes('@dogancan'));
    expect(mentions.length).toBeGreaterThanOrEqual(3);
  });

  test('#api has code in four languages, a link, and reactions from more than one person', () => {
    const text = everyText(apiChannel()).join('\n');
    for (const language of ['ts', 'bash', 'diff', 'json'])
      expect(text).toContain(`\`\`\`${language}\n`);
    expect(text).toContain('https://');
    const reactions = apiChannel().flatMap((step) => step.reactions ?? []);
    expect(reactions.some((reaction) => reaction.by.length > 1)).toBe(true);
  });

  test('the viewer has read part of #api and part of #deploys, and #deploys is long enough to page', () => {
    expect(apiChannel().filter((step) => step.readUpTo === true)).toHaveLength(1);
    const deploys = deploysChannel();
    expect(deploys).toHaveLength(200);
    expect(deploys.findIndex((step) => step.readUpTo === true)).toBe(119);
  });

  test('#incidents has an open thread that names the viewer', () => {
    const open = incidentsChannel().find((step) => step.key === 'incident-open');
    expect(open?.text).toContain('@dogancan');
    expect(open?.resolvedBy).toBeUndefined();
    expect(open?.replies).toHaveLength(3);
  });

  test('every author is one of the four people', () => {
    for (const step of all()) {
      expect(Object.keys(PERSONAS)).toContain(step.who);
      for (const reply of step.replies ?? []) expect(Object.keys(PERSONAS)).toContain(reply.who);
    }
  });

  test('the note to self is the viewer alone', () => {
    expect(selfNotes().every((step) => step.who === 'dogancan')).toBe(true);
  });

  test('a count includes replies', () => {
    expect(
      messageCount([
        {
          who: 'alice',
          text: 'x',
          gapMinutes: 0,
          replies: [{ who: 'bob', text: 'y', gapMinutes: 1 }],
        },
      ]),
    ).toBe(2);
  });
});
