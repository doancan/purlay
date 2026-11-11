/**
 * The mutations `bun run mutate` applies (`scripts/mutate.ts`, `CONTRIBUTING.md` §5).
 *
 * Each is something a reviewer could plausibly let through, written against the code
 * as it is: when the code moves, the entry goes stale and the run says so.
 *
 * An entry goes in the file of the area `areaOf` names for the file it mutates
 * (`areas.ts`), at the place its id sorts: never at the end of a file, so two pull requests
 * rarely edit the same lines. `mutations.test.ts` refuses an entry in the wrong file or out of order,
 * and a file this list does not import. A new area is a line in `areas.ts`, a new file, and one
 * import and one line here.
 */
import type { Mutation } from '../mutate';
import type { AreaName } from './areas';
import { API_CHAT } from './api-chat';
import { API_CHAT_SHARED } from './api-chat-shared';
import { API_CHAT_CHANNELS } from './api-chat-channels';
import { API_CHAT_GUEST_EXPIRY } from './api-chat-guest-expiry';
import { API_CHAT_INTEGRATIONS } from './api-chat-integrations';
import { API_CHAT_MESSAGES } from './api-chat-messages';
import { API_CHAT_NOTIFICATIONS } from './api-chat-notifications';
import { API_CLI } from './api-cli';
import { API_INGRESS_HTTP } from './api-ingress-http';
import { API_INGRESS_HTTP_AUTH } from './api-ingress-http-auth';
import { API_INGRESS_HTTP_SETUP } from './api-ingress-http-setup';
import { API_INGRESS_WS } from './api-ingress-ws';
import { API_ISSUES } from './api-issues';
import { API_MODULES_ADMINISTRATION } from './api-modules-administration';
import { API_MODULES_ATTACHMENTS } from './api-modules-attachments';
import { API_MODULES_AUDIT } from './api-modules-audit';
import { API_MODULES_AUTH } from './api-modules-auth';
import { API_MODULES_AUTH_BETTER_AUTH } from './api-modules-auth-better-auth';
import { API_MODULES_ENTITLEMENTS } from './api-modules-entitlements';
import { API_MODULES_EXPORT } from './api-modules-export';
import { API_MODULES_FIND } from './api-modules-find';
import { API_MODULES_IMAGES } from './api-modules-images';
import { API_MODULES_INBOX } from './api-modules-inbox';
import { API_MODULES_JOBS } from './api-modules-jobs';
import { API_MODULES_PUSH } from './api-modules-push';
import { API_MODULES_SETUP } from './api-modules-setup';
import { API_MODULES_SETUP_PROBES } from './api-modules-setup-probes';
import { API_MODULES_SETUP_RUNTIME } from './api-modules-setup-runtime';
import { API_MODULES_SETUP_SETTINGS } from './api-modules-setup-settings';
import { API_MODULES_SETUP_SETUP } from './api-modules-setup-setup';
import { API_MODULES_USERS } from './api-modules-users';
import { API_MODULES_WORKERS } from './api-modules-workers';
import { API_MODULES_WORKSPACES } from './api-modules-workspaces';
import { API_PLATFORM } from './api-platform';
import { API_REALTIME } from './api-realtime';
import { API_ROOT } from './api-root';
import { PACKAGES_DB } from './packages-db';
import { PACKAGES_MARKDOWN } from './packages-markdown';
import { PACKAGES_TOKENS } from './packages-tokens';
import { PACKAGES_TYPES } from './packages-types';
import { REPO } from './repo';
import { SCRIPTS } from './scripts';
import { WEB_CORE } from './web-core';
import { WEB_FEATURES } from './web-features';
import { WEB_FEATURES_SHARED } from './web-features-shared';
import { WEB_FEATURES_CHANNEL } from './web-features-channel';
import { WEB_FEATURES_COMPOSER } from './web-features-composer';
import { WEB_FEATURES_CONTENT } from './web-features-content';
import { WEB_FEATURES_FOLLOWED } from './web-features-followed';
import { WEB_FEATURES_SETTINGS } from './web-features-settings';
import { WEB_FEATURES_SIDEBAR } from './web-features-sidebar';
import { WEB_REALTIME } from './web-realtime';

export const MUTATIONS_BY_AREA: Readonly<Record<AreaName, readonly Mutation[]>> = {
  repo: REPO,
  scripts: SCRIPTS,
  'packages-db': PACKAGES_DB,
  'packages-markdown': PACKAGES_MARKDOWN,
  'packages-tokens': PACKAGES_TOKENS,
  'packages-types': PACKAGES_TYPES,
  'api-root': API_ROOT,
  'api-cli': API_CLI,
  'api-chat': API_CHAT,
  'api-chat-shared': API_CHAT_SHARED,
  'api-chat-channels': API_CHAT_CHANNELS,
  'api-chat-guest-expiry': API_CHAT_GUEST_EXPIRY,
  'api-chat-integrations': API_CHAT_INTEGRATIONS,
  'api-chat-messages': API_CHAT_MESSAGES,
  'api-chat-notifications': API_CHAT_NOTIFICATIONS,
  'api-issues': API_ISSUES,
  'api-ingress-http': API_INGRESS_HTTP,
  'api-ingress-http-auth': API_INGRESS_HTTP_AUTH,
  'api-ingress-http-setup': API_INGRESS_HTTP_SETUP,
  'api-ingress-ws': API_INGRESS_WS,
  'api-modules-administration': API_MODULES_ADMINISTRATION,
  'api-modules-attachments': API_MODULES_ATTACHMENTS,
  'api-modules-audit': API_MODULES_AUDIT,
  'api-modules-auth': API_MODULES_AUTH,
  'api-modules-auth-better-auth': API_MODULES_AUTH_BETTER_AUTH,
  'api-modules-entitlements': API_MODULES_ENTITLEMENTS,
  'api-modules-export': API_MODULES_EXPORT,
  'api-modules-find': API_MODULES_FIND,
  'api-modules-images': API_MODULES_IMAGES,
  'api-modules-inbox': API_MODULES_INBOX,
  'api-modules-jobs': API_MODULES_JOBS,
  'api-modules-push': API_MODULES_PUSH,
  'api-modules-setup': API_MODULES_SETUP,
  'api-modules-setup-probes': API_MODULES_SETUP_PROBES,
  'api-modules-setup-runtime': API_MODULES_SETUP_RUNTIME,
  'api-modules-setup-settings': API_MODULES_SETUP_SETTINGS,
  'api-modules-setup-setup': API_MODULES_SETUP_SETUP,
  'api-modules-users': API_MODULES_USERS,
  'api-modules-workers': API_MODULES_WORKERS,
  'api-modules-workspaces': API_MODULES_WORKSPACES,
  'api-platform': API_PLATFORM,
  'api-realtime': API_REALTIME,
  'web-core': WEB_CORE,
  'web-realtime': WEB_REALTIME,
  'web-features': WEB_FEATURES,
  'web-features-shared': WEB_FEATURES_SHARED,
  'web-features-channel': WEB_FEATURES_CHANNEL,
  'web-features-composer': WEB_FEATURES_COMPOSER,
  'web-features-content': WEB_FEATURES_CONTENT,
  'web-features-followed': WEB_FEATURES_FOLLOWED,
  'web-features-settings': WEB_FEATURES_SETTINGS,
  'web-features-sidebar': WEB_FEATURES_SIDEBAR,
};

export const MUTATIONS: readonly Mutation[] = Object.values(MUTATIONS_BY_AREA).flat();
