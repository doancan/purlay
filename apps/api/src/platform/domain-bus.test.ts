import { describe, expect, test } from 'bun:test';
import { aRecordingLogger } from '../testing/doubles';
import { domainEvent, inProcessDomainBus } from './domain-bus';

const posted = domainEvent<{ readonly id: string }>('chat.message-posted');
const other = domainEvent<{ readonly name: string }>('notes.page-saved');

describe('the domain bus', () => {
  test('hands the payload to each subscriber of that event, and to no other', async () => {
    const bus = inProcessDomainBus(aRecordingLogger().log);
    const seen: string[] = [];
    bus.subscribe(posted, 'issues', ({ id }) => {
      seen.push(`issues:${id}`);
    });
    bus.subscribe(posted, 'search', ({ id }) => {
      seen.push(`search:${id}`);
    });
    bus.subscribe(other, 'search', ({ name }) => {
      seen.push(`other:${name}`);
    });
    await bus.publish(posted, { id: 'm1' });
    expect(seen).toEqual(['issues:m1', 'search:m1']);
  });

  test('nobody listening is not an error', async () => {
    const { log, lines } = aRecordingLogger();
    await inProcessDomainBus(log).publish(posted, { id: 'm1' });
    expect(lines).toEqual([]);
  });

  test('a handler that throws is logged with its module, and the others still hear it', async () => {
    const { log, lines } = aRecordingLogger();
    const bus = inProcessDomainBus(log);
    const seen: string[] = [];
    bus.subscribe(posted, 'issues', () => {
      throw new Error('boom');
    });
    bus.subscribe(posted, 'search', () => {
      seen.push('search');
    });
    bus.subscribe(posted, 'mail', () => Promise.reject(new Error('later')));
    await bus.publish(posted, { id: 'm1' });
    expect(seen).toEqual(['search']);
    expect(lines.map((line) => [line['msg'], line['event'], line['module']])).toEqual([
      ['a domain event handler failed', 'chat.message-posted', 'issues'],
      ['a domain event handler failed', 'chat.message-posted', 'mail'],
    ]);
  });

  test('a subscriber that stopped hears nothing more, and stopping twice is harmless', async () => {
    const bus = inProcessDomainBus(aRecordingLogger().log);
    const seen: string[] = [];
    const stop = bus.subscribe(posted, 'issues', ({ id }) => {
      seen.push(id);
    });
    bus.subscribe(posted, 'search', ({ id }) => {
      seen.push(`s${id}`);
    });
    await bus.publish(posted, { id: '1' });
    stop();
    stop();
    await bus.publish(posted, { id: '2' });
    expect(seen).toEqual(['1', 's1', 's2']);
  });

  test('a handler that subscribes while it is heard changes the next publish, not this one', async () => {
    const bus = inProcessDomainBus(aRecordingLogger().log);
    const seen: string[] = [];
    bus.subscribe(posted, 'first', () => {
      bus.subscribe(posted, 'late', () => {
        seen.push('late');
      });
      seen.push('first');
    });
    await bus.publish(posted, { id: '1' });
    expect(seen).toEqual(['first']);
    await bus.publish(posted, { id: '2' });
    expect(seen).toEqual(['first', 'first', 'late']);
  });
});
