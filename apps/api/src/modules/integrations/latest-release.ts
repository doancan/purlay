/**
 * The newest release of Purlay, as the server asks GitHub for it so that a signed-in person can be told whether
 * the version they run is the newest (`GET /api/releases/latest`, D-248).
 *
 * The browser cannot ask: its policy allows only its own origin (D-39). So the server does, once for everybody
 * and rarely: a good answer is kept six hours, a failure ten minutes — long enough not to be a retry loop against
 * a GitHub that is down, short enough that an outage is not kept all day — and callers arriving together share one
 * call. Nothing of this instance is sent: the request is GitHub's public one, anonymous, with the same headers
 * every call of the App makes.
 *
 * It never throws. What cannot be known is `null`: a limit, a `5xx`, a redirect, no answer in time, a body that
 * is not a release, a tag that is not three numbers, a page that is not this tag's page in this repository, a
 * draft or a pre-release. A failure after a good answer does not take it back: the last good answer is served on
 * and GitHub is asked again after the failure window; only a server that has never had one answers `null`. The
 * reason goes to the log, without the body. With the check turned off by the operator it makes no call at all.
 */
import { Type } from '@sinclair/typebox';
import { type LatestRelease, RELEASE_REPOSITORY, RELEASE_TAG, releasePage } from '@purlay/types';
import { HOUR_MS, type Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logging';
import {
  GitHubRateLimited,
  GitHubUnavailable,
  githubAppCaller,
  readChecked,
  type GitHubAppFetch,
} from '../../platform/github-app-api';

/** How long a good answer is kept, and a failure. */
const RELEASE_KEPT_MS = 6 * HOUR_MS;
const RELEASE_FAILURE_KEPT_MS = 10 * 60 * 1000;
/** The longest a limit GitHub names is waited out: past it a person would be told nothing for hours. */
const RELEASE_LIMIT_KEPT_MAX_MS = HOUR_MS;

/** What of GitHub's release is read: the rest is not looked at. */
const ReleaseBody = Type.Object({
  tag_name: Type.String({ maxLength: 64 }),
  // Not bounded: it is only ever compared with the page this tag has, which is short.
  html_url: Type.String(),
  published_at: Type.String({ format: 'date-time' }),
  draft: Type.Optional(Type.Boolean()),
  prerelease: Type.Optional(Type.Boolean()),
});

export interface ReleaseCheckDependencies {
  /** `UPDATE_CHECK`: off, and GitHub is never called. */
  readonly enabled: boolean;
  /** `GITHUB_API_URL`, without a trailing slash. */
  readonly apiUrl: string;
  readonly fetch: GitHubAppFetch;
  readonly clock: Clock;
  readonly log: Logger;
  /** How long GitHub has to answer; the shared caller's ten seconds when absent. A test shortens it. */
  readonly timeoutMs?: number;
}

export interface ReleaseCheck {
  readonly latest: () => Promise<Newest>;
}

/** What the check knows: the newest release, or none. The version this server runs is the route's to add. */
interface Newest {
  readonly latest: LatestRelease | null;
}

const NOTHING: Newest = { latest: null };

export const latestReleaseCheck = (dependencies: ReleaseCheckDependencies): ReleaseCheck => {
  const { enabled, apiUrl, clock, log } = dependencies;
  const caller = githubAppCaller(dependencies.fetch, () => clock.now(), dependencies.timeoutMs);
  // What is served until `until`; `good` is the last release GitHub named, which a failure does not take back.
  let kept: { readonly answer: Newest; readonly until: number } | undefined;
  let good: Newest | undefined;
  let inFlight: Promise<Newest> | undefined;

  const ask = async (): Promise<LatestRelease> => {
    const response = await caller.call(`${apiUrl}/repos/${RELEASE_REPOSITORY}/releases/latest`, {
      method: 'GET',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GitHubUnavailable(
        `GitHub answered the newest release with ${String(response.status)}`,
      );
    }
    const body = await readChecked(response, ReleaseBody, 'the newest release');
    if (body.draft === true || body.prerelease === true) {
      throw new GitHubUnavailable('the newest release is a draft or a pre-release');
    }
    if (!RELEASE_TAG.test(body.tag_name) || body.html_url !== releasePage(body.tag_name)) {
      throw new GitHubUnavailable('the newest release has a tag or a page that is not Purlay’s');
    }
    const release: LatestRelease = {
      version: body.tag_name.slice(1),
      url: releasePage(body.tag_name),
      publishedAt: new Date(body.published_at).toISOString(),
    };
    return release;
  };

  const refresh = async (): Promise<Newest> => {
    try {
      const answer = { latest: await ask() };
      good = answer;
      kept = { answer, until: clock.now().getTime() + RELEASE_KEPT_MS };
      return answer;
    } catch (error) {
      log.warn('the release check failed', {
        reason:
          error instanceof GitHubRateLimited || error instanceof GitHubUnavailable
            ? error.message
            : 'an unexpected failure',
        ...(error instanceof GitHubRateLimited || error instanceof GitHubUnavailable
          ? {}
          : { errorName: error instanceof Error ? error.name : typeof error }),
      });
      // A failure does not take back what was learned: the last good answer is served on, and GitHub is
      // asked again after the failure window — ten minutes, or a limit's own wait up to an hour.
      const wait =
        error instanceof GitHubRateLimited
          ? Math.min(
              Math.max(error.retryAfterSeconds * 1000, RELEASE_FAILURE_KEPT_MS),
              RELEASE_LIMIT_KEPT_MAX_MS,
            )
          : RELEASE_FAILURE_KEPT_MS;
      const answer = good ?? NOTHING;
      kept = { answer, until: clock.now().getTime() + wait };
      return answer;
    }
  };

  return {
    latest: async (): Promise<Newest> => {
      if (!enabled) return NOTHING;
      if (kept !== undefined && clock.now().getTime() < kept.until) return kept.answer;
      inFlight ??= refresh().finally(() => {
        inFlight = undefined;
      });
      return await inFlight;
    },
  };
};
