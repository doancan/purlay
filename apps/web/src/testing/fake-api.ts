/**
 * An `Api` a test writes by hand: every method refuses, and the test overrides the
 * ones it expects to be called. A call nobody expected fails the test with the
 * method's name, which is how a screen that reaches for an endpoint it should not
 * is caught.
 */
import type { Api } from '../data/api';

const unexpected = (name: string) => (): never => {
  throw new Error(`the test did not expect api.${name} to be called`);
};

export const anApi = (overrides: Partial<Api> = {}): Api => ({
  me: unexpected('me'),
  workspaces: unexpected('workspaces'),
  createWorkspace: unexpected('createWorkspace'),
  members: unexpected('members'),
  channels: unexpected('channels'),
  createChannel: unexpected('createChannel'),
  joinChannel: unexpected('joinChannel'),
  openDirectMessage: unexpected('openDirectMessage'),
  markRead: unexpected('markRead'),
  messages: unexpected('messages'),
  send: unexpected('send'),
  thread: unexpected('thread'),
  resolve: unexpected('resolve'),
  reopen: unexpected('reopen'),
  unresolved: unexpected('unresolved'),
  react: unexpected('react'),
  unreact: unexpected('unreact'),
  editMessage: unexpected('editMessage'),
  addChannelMember: unexpected('addChannelMember'),
  deleteMessage: unexpected('deleteMessage'),
  signOut: unexpected('signOut'),
  ...overrides,
});
