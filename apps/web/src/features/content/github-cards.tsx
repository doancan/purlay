/**
 * GitHub pull requests and issues a message links to, as cards under its words (D-2, D-23,
 * `ARCHITECTURE.md` §8.3, `UX.md` §3): the kind, `owner/repo#number`, the state, the title as a link,
 * and who opened it.
 *
 * - **With a pull request's checks and reviews** when GitHub said them (#423), in words and a glyph.
 * - **The links are read from the words with the same engine as everything else** (`metadataOf`,
 *   D-101), so the client and the server agree on what counts and on the cap.
 * - **A card is a decoration of a link that is already there.** Until it arrives, and when there is
 *   none — no token, nothing at that address, GitHub not answering, the request failing — nothing is
 *   drawn and the link stays a link. Nothing is said about it: the server has already written down
 *   why, and a missing card costs the reader nothing they cannot click.
 * - **No avatar.** GitHub's avatar is an image on another host, and drawing it would hand every
 *   reader's address to GitHub; external images wait for the proxy (#110). The login is shown.
 * - One request per link and workspace, shared by every message and screen that shows it, and kept
 *   for the server's own five minutes.
 */
import { useQueries } from '@tanstack/react-query';
import { metadataOf } from '@purlay/markdown';
import type { GitHubCardMetadata, UnfurlResponse } from '@purlay/types';
import { Icon, type GlyphName } from '../../components/icon';
import { useApi } from '../../data/api-provider';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { cn } from '../../ui/cn';
import { useWorkspace } from '../shell/workspace';
import { readBody } from './render-content';

/** The server keeps a card this long (`ARCHITECTURE.md` §8.3); asking sooner would get the same one. */
const CARD_FRESH_MS = 5 * 60 * 1000;

const glyphOf = (card: GitHubCardMetadata): GlyphName =>
  card.type === 'issue' ? 'open-question' : card.state === 'merged' ? 'merged' : 'pull-request';

const stateClasses: Readonly<Record<GitHubCardMetadata['state'], string>> = {
  open: 'bg-success-subtle text-success-text',
  closed: 'bg-danger-subtle text-danger-text',
  merged: 'bg-accent-subtle text-accent-text',
};

type CiStatus = NonNullable<GitHubCardMetadata['ciStatus']>;

const ciGlyph: Readonly<Record<CiStatus, GlyphName>> = {
  success: 'confirm',
  failure: 'ci-failed',
  pending: 'sending',
};

const ciClasses: Readonly<Record<CiStatus, string>> = {
  success: 'text-success-text',
  failure: 'text-danger-text',
  pending: 'text-ink-muted',
};

const Card = ({
  url,
  card,
}: {
  readonly url: string;
  readonly card: GitHubCardMetadata;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <article
      data-github-card=""
      className="flex max-w-feed flex-col gap-1 rounded-xl border-hairline border-border-subtle bg-surface-100 px-3 py-2 shadow-card"
    >
      <div className="flex items-center gap-2 text-caption text-ink-muted">
        <Icon name={glyphOf(card)} size="sm" />
        <span className="min-w-0 truncate font-mono">{`${card.repo}#${String(card.number)}`}</span>
        <span className={cn('rounded-pill px-2 font-medium', stateClasses[card.state])}>
          {t(`github.state.${card.state}`)}
        </span>
      </div>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-body font-medium text-ink hover:underline"
      >
        {card.title}
      </a>
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-muted">
        <span>
          {t(card.type === 'pr' ? 'github.openedPr' : 'github.openedIssue', {
            login: card.author.login,
          })}
        </span>
        {card.ciStatus !== undefined && (
          <span className={cn('inline-flex items-center gap-1', ciClasses[card.ciStatus])}>
            <Icon name={ciGlyph[card.ciStatus]} size="sm" />
            {t(`github.ci.${card.ciStatus}`)}
          </span>
        )}
        {card.reviewDecision !== undefined && (
          <span>{t(`github.review.${card.reviewDecision}`)}</span>
        )}
      </span>
    </article>
  );
};

const Cards = ({ links }: { readonly links: readonly string[] }): React.JSX.Element | null => {
  const api = useApi();
  const { workspace } = useWorkspace();
  const answers = useQueries({
    queries: links.map((url) => ({
      queryKey: keys.unfurl(workspace.id, url),
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<UnfurlResponse> =>
        await api.unfurl(workspace.id, url, signal),
      staleTime: CARD_FRESH_MS,
      // A card is decoration: one that did not come is not asked for again and again.
      retry: false,
    })),
  });
  const drawn = links.flatMap((url, index) => {
    const card = answers[index]?.data;
    return card === undefined || card === null ? [] : [{ url, card }];
  });
  if (drawn.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-2">
      {drawn.map(({ url, card }) => (
        <Card key={url} url={url} card={card} />
      ))}
    </div>
  );
};

/** The cards of a message's words; nothing at all when they link to no pull request or issue. */
export const GitHubCards = ({
  content,
}: {
  readonly content: string;
}): React.JSX.Element | null => {
  const links = metadataOf(readBody(content).tree).githubLinks ?? [];
  return links.length === 0 ? null : <Cards links={links} />;
};
