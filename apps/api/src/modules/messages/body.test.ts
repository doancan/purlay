/**
 * The one reading of a body (`body.ts`): refused for a broadcast, and a reading the engine got wrong
 * is a failure of this code — never stored, and named by the path that broke the contract.
 */
import { describe, expect, test } from 'bun:test';
import type { Engine } from '@purlay/markdown';
import { AppError } from '../../platform/errors';
import { readBody } from './body';

describe('reading a body', () => {
  test('names the people it mentions and records its code languages', () => {
    const body = readBody('@alice see\n\n```ts\nx\n```');
    expect(body.names).toEqual(['alice']);
    expect(body.metadata).toMatchObject({ codeLanguages: ['ts'] });
  });

  test('names only the prose the client draws: not a link, an address, or a name glued to code (#330)', () => {
    expect(readBody('[@bob](https://example.com) and https://medium.com/@carol').names).toEqual([]);
    expect(readBody('`x`@bob').names).toEqual([]);
    // Not code to the engine, so not to the server: a backtick pair across a blank line.
    expect(readBody('`one\n\n@bob two`').names).toEqual(['bob']);
    expect(readBody('**@bob**, see `@carol` and @dave').names).toEqual(['bob', 'dave']);
  });

  test('a broadcast in code is somebody quoting it, not one', () => {
    expect(readBody('use `@here` sparingly').names).toEqual([]);
  });

  test('refuses a broadcast, naming the field', () => {
    let refused: unknown;
    try {
      readBody('hey @channel');
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(AppError);
    expect(refused instanceof AppError ? refused.body : null).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: { content: 'broadcast mentions are not available' } },
    });
  });

  test('a reading outside the contract is an error naming the path, not a stored message', () => {
    // An engine that answers a code block whose language is not text.
    const wrong = {
      type: 'root',
      children: [{ type: 'code', lang: 7, value: 'x' }],
    };
    const engine = { blocks: () => wrong, full: () => wrong } as unknown as Engine;
    expect(() => readBody('```\nx\n```', engine)).toThrow(
      /metadata outside the contract at \/codeLanguages/,
    );
  });
});
