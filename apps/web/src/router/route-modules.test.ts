import { describe, expect, test } from 'bun:test';
import { moduleOf, type RouteName } from './routes';

/** Every route and whose it is, spelt out so that a route that changes hands says so here. */
const OWNERS: Readonly<Record<RouteName, string | null>> = {
  signIn: null,
  signInEmail: null,
  signInNative: null,
  signUp: null,
  invite: null,
  mailStop: null,
  setup: null,
  setupVerify: null,
  home: null,
  workspace: null,
  channel: 'chat',
  questions: 'chat',
  inbox: 'chat',
  search: 'chat',
  saved: 'chat',
  drafts: 'chat',
  unreads: 'chat',
  issues: 'issues',
  welcome: null,
  settingsHome: null,
  settings: null,
  gallery: null,
};

describe('which module a route belongs to', () => {
  test('every route is the core’s or one module’s, as written down here', () => {
    const names = Object.keys(OWNERS) as RouteName[];
    expect(Object.fromEntries(names.map((name) => [name, moduleOf(name)]))).toEqual(OWNERS);
  });
});
