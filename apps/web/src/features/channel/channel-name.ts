/**
 * A channel's name as the contract and the sidebar want it: lowercase letters, numbers and hyphens,
 * starting with a letter or a number, at most `CHANNEL_NAME_MAX` (D-123). People type names the way they say them —
 * "Genel Sohbet", "İstanbul Ekibi" — so the field turns what is typed into that form as it is typed,
 * rather than refusing it after the fact.
 *
 * Accents and the Turkish letters fold to their plain letter (ç→c, ğ→g, ı→i, İ→i, ö→o, ş→s, ü→u):
 * a letter's marks are taken off rather than the letter dropped, and the dotless ı, which has no mark
 * to take off, is spelled. Anything else that is not a letter or a number becomes one hyphen.
 */
import { CHANNEL_NAME_MAX } from '@purlay/types';

/**
 * The spelling this client gives a channel, once: what the field checks before it sends. Stricter than
 * the contract, whose `name` format refuses only what cannot be shown safely; the server takes either.
 */
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * What is typed, as it is typed. A trailing hyphen is kept, or the separator a person has just typed
 * would vanish before the next word; `finishedChannelName` takes it off when the name is sent.
 */
export const toChannelName = (typed: string): string =>
  typed
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, CHANNEL_NAME_MAX);

/** The name to send: the typed form, without a hyphen left at its end. */
export const finishedChannelName = (typed: string): string =>
  toChannelName(typed).replace(/-+$/, '');
