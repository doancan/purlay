/**
 * What a push says of issues' notices (D-286 §9): who, and why it needs the person, never the title. The words are the web's
 * `issues.*` voice for the same fact, and the notice lands on the issues screen.
 */
import type { NoticeWords } from '../../modules/push/notices';

const ASSIGNED = {
  en: '{name} assigned an issue to you',
  tr: '{name} sana bir sorun atadı',
} as const;

export const issuesNoticeWords: NoticeWords = (kind, locale, actor) =>
  kind === 'issue_assigned'
    ? { body: ASSIGNED[locale].replace('{name}', actor), path: 'issues' }
    : undefined;
