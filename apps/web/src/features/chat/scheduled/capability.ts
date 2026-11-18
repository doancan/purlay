/**
 * Whether this server holds messages for later (`capabilities.scheduledMessages`, `API.md`).
 *
 * The browser never asks the public `GET /api/client` (D-248), so it reads the flag from what it
 * already has: the server advertises it "only where chat runs", and the session says what the server
 * runs. This is that same fact, read from the session — one place to change if the flag ever stops
 * following the module.
 */
import { useRuns } from '../../session/session';

export const useCanScheduleMessages = (): boolean => useRuns('chat');
