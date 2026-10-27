/**
 * What a person may change about their own sidebar, and what it then lists (D-195) — as functions, so
 * the rules are testable without a render.
 *
 * The sidebar is the person's to arrange, and arranged by **what is shown**, never by how tightly
 * (D-118 §6: density is in what is drawn, not in compression): a section folds away, shows only what is
 * unread, leaves out what is muted, or is switched off. Nothing here moves a row the person is about to
 * click — the order of a section stays the rule D-160 states unless they chose the other one.
 *
 * Kept in the browser, **per person and per workspace** (`keyFor`): it is a convenience, like the last
 * channel and the theme, so a page without storage simply draws the defaults. It names no one's words and
 * no channel, only which sections are folded or off, so it is not among the keys a sign-out forgets — and
 * the person's id is in the key, so the next person to sign in on this machine finds their own.
 */

import type { Channel } from '@purlay/types';

/** The four sections of the sidebar, as the person folds them. */
type SectionId = 'starred' | 'channels' | 'conversations' | 'people';

/** The sections the person may switch off: the channels they are in are the sidebar's purpose, and what they starred is theirs already. */
type OptionalSection = 'conversations' | 'people';

export type ChannelOrder = 'name' | 'activity';

export interface SidebarPreferences {
  /** Folded sections: only what needs a look stays listed under the heading. */
  readonly collapsed: readonly SectionId[];
  /** Sections switched off altogether. */
  readonly hidden: readonly OptionalSection[];
  /** Everywhere, only what is unread, what mentions the person, and where they are. */
  readonly unreadOnly: boolean;
  /** Channels by name, which keeps a place where it was (D-160), or by what was written in them last. */
  readonly channelOrder: ChannelOrder;
  /** A muted channel is left out unless it mentions the person or is the open one. */
  readonly hideMuted: boolean;
}

export const DEFAULT_PREFERENCES: SidebarPreferences = {
  collapsed: [],
  hidden: [],
  unreadOnly: false,
  channelOrder: 'name',
  hideMuted: false,
};

const SECTIONS: readonly SectionId[] = ['starred', 'channels', 'conversations', 'people'];
const OPTIONAL: readonly OptionalSection[] = ['conversations', 'people'];

/** One line of a section, reduced to what the rules look at. */
export interface SidebarRow {
  readonly id: string;
  readonly unread: boolean;
  readonly mentions: number;
  readonly muted: boolean;
  /** An incident is open in it (D-137): what is on fire is what a glance at a folded section is for. */
  readonly incident: boolean;
}

export interface ShowRules {
  /** The section is folded: only what needs a look stays. */
  readonly collapsed: boolean;
  readonly unreadOnly: boolean;
  readonly hideMuted: boolean;
  /** The row the person is in: never taken away from under them, whatever else is asked. */
  readonly currentId: string | null;
}

/**
 * The rows a section lists, in the order they came. A row stays when every ask lets it:
 * - folded, or only unread: it is unread, mentions the person, has an incident open, or is the open one — what a
 *   glance at a folded section is for, so a fold never hides what is waiting or what is on fire;
 * - without muted: it is not muted, or it mentions the person or has an incident open, or is the open one.
 */
export const shownRows = <T extends SidebarRow>(rows: readonly T[], rules: ShowRules): T[] =>
  rows.filter((entry) => {
    const here = entry.id === rules.currentId;
    const urgent = entry.mentions > 0 || entry.incident;
    if ((rules.collapsed || rules.unreadOnly) && !(entry.unread || urgent || here)) return false;
    if (rules.hideMuted && entry.muted && !urgent && !here) return false;
    return true;
  });

/** The key a person's preferences for one workspace are kept under. */
export const keyFor = (userId: string, workspaceId: string): string =>
  `purlay.sidebar.${userId}.${workspaceId}`;

/** The entries of `allowed` that were saved, once each and in the sidebar's order: nothing else survives. */
const listOf = <T extends string>(value: unknown, allowed: readonly T[]): T[] =>
  Array.isArray(value) ? allowed.filter((entry) => (value as unknown[]).includes(entry)) : [];

/**
 * What was saved, read field by field: one value that is wrong costs that field and not the others, and
 * nothing that cannot be read is an error — it is the defaults, which is what a page that never saved
 * anything draws.
 */
export const parsePreferences = (text: string | null): SidebarPreferences => {
  if (text === null) return DEFAULT_PREFERENCES;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return DEFAULT_PREFERENCES;
  }
  const saved = value as Record<string, unknown>;
  return {
    collapsed: listOf(saved['collapsed'], SECTIONS),
    hidden: listOf(saved['hidden'], OPTIONAL),
    unreadOnly: saved['unreadOnly'] === true,
    channelOrder: saved['channelOrder'] === 'activity' ? 'activity' : 'name',
    hideMuted: saved['hideMuted'] === true,
  };
};

export const serialisePreferences = (preferences: SidebarPreferences): string =>
  JSON.stringify(preferences);

export const isDefault = (preferences: SidebarPreferences): boolean =>
  serialisePreferences(preferences) === serialisePreferences(DEFAULT_PREFERENCES);

/** A list with one entry added if it was not there, and taken out if it was. */
export const withToggled = <T extends string>(list: readonly T[], entry: T): T[] =>
  list.includes(entry) ? list.filter((candidate) => candidate !== entry) : [...list, entry];

/** A channel or a conversation, as the rules see it: what is waiting in it and whether it is muted. */
export const rowOf = (channel: Channel): SidebarRow => ({
  id: channel.id,
  unread: (channel.state?.unreadCount ?? 0) > 0,
  mentions: channel.state?.unreadMentionCount ?? 0,
  muted: channel.notificationLevel === 'none',
  incident: channel.incident !== null,
});
