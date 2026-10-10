/**
 * What the demo workspace says, as data.
 *
 * A demo that has to be believed is a team that has been talking for two days: code
 * that was pasted, questions that got answered and questions that did not, a channel
 * with two hundred deploys in it so that scrolling back is real pagination, and a few
 * people who are quiet until somebody names them. This file is only that conversation —
 * who says what, how long after the last thing — so the seed can send it through the
 * real send path and a test can read it without a database.
 *
 * Everything here is deterministic: the same script every run, so a visual snapshot of
 * a seeded screen is a snapshot of the same screen.
 */

export type PersonaKey = 'dogancan' | 'alice' | 'bob' | 'carol';

export const PERSONAS: Readonly<
  Record<PersonaKey, { readonly displayName: string; readonly githubId: number }>
> = {
  dogancan: { displayName: 'Doğancan', githubId: 9_000_001 },
  alice: { displayName: 'Alice Chen', githubId: 9_000_002 },
  bob: { displayName: 'Bob Okafor', githubId: 9_000_003 },
  carol: { displayName: 'Carol Reyes', githubId: 9_000_004 },
};

interface Reply {
  readonly who: PersonaKey;
  readonly text: string;
  readonly gapMinutes: number;
}

export interface Step {
  readonly who: PersonaKey;
  readonly text: string;
  /** Minutes since the previous step in the same channel. */
  readonly gapMinutes: number;
  /** A name the seed reports the message's id under, for tests that need to find it. */
  readonly key?: string;
  readonly reactions?: readonly { readonly emoji: string; readonly by: readonly PersonaKey[] }[];
  readonly replies?: readonly Reply[];
  /** Resolves the thread after its last reply. */
  readonly resolvedBy?: PersonaKey;
  /** The viewer has read up to and including this message when the seed ends. */
  readonly readUpTo?: boolean;
}

const fence = (lang: string, code: string): string => `\`\`\`${lang}\n${code}\n\`\`\``;

/** `#api`: about forty roots and nine replies over two days, three threads, mentions of the viewer. */
export const apiChannel = (): readonly Step[] => [
  {
    who: 'alice',
    gapMinutes: 0,
    text: 'Morning. The rate-limit fix is merged; deploying to staging now.',
  },
  {
    who: 'alice',
    gapMinutes: 2,
    text: 'Staging is green. Smoke tests pass.',
    key: 'staging-green',
  },
  {
    who: 'bob',
    gapMinutes: 9,
    text: 'Nice. What is the backoff now? I read the diff but the constant moved.',
    key: 'backoff-question',
    reactions: [{ emoji: '👀', by: ['carol', 'dogancan'] }],
    replies: [
      {
        who: 'alice',
        gapMinutes: 3,
        text: 'The retry backoff is 4s because the upstream rate-limits at 15/min.',
      },
      { who: 'bob', gapMinutes: 2, text: 'Is that documented anywhere?' },
      { who: 'alice', gapMinutes: 4, text: 'Only in the incident postmortem. Linking it here.' },
      { who: 'carol', gapMinutes: 6, text: 'Can we make it configurable per workspace?' },
    ],
  },
  {
    who: 'carol',
    gapMinutes: 15,
    text: `Pasting the shape the client expects, so nobody has to guess:\n${fence(
      'ts',
      'export interface RetryPolicy {\n  /** Milliseconds before the first retry. */\n  readonly backoffMs: number;\n  readonly maxAttempts: number;\n}\n\nexport const defaultPolicy: RetryPolicy = { backoffMs: 4_000, maxAttempts: 5 };',
    )}`,
    reactions: [{ emoji: '👍', by: ['alice', 'bob', 'dogancan'] }],
  },
  { who: 'bob', gapMinutes: 22, text: 'Lunch. Back in 40.' },
  {
    who: 'alice',
    gapMinutes: 55,
    text: 'Do we still need the legacy `/v1/messages` route?',
    key: 'legacy-route',
    replies: [
      { who: 'bob', gapMinutes: 4, text: 'Only the desktop beta calls it.' },
      { who: 'carol', gapMinutes: 5, text: 'Beta moved to `/v2` last week.' },
      { who: 'alice', gapMinutes: 3, text: 'Then we remove it in the next release.' },
    ],
    resolvedBy: 'alice',
  },
  {
    who: 'dogancan',
    gapMinutes: 30,
    text:
      'Reproduced the flaky reconnect locally:\n' +
      fence(
        'bash',
        'bun run dev:api &\nfor i in $(seq 1 20); do kill -STOP $(pgrep -f "bun.*api") && sleep 1 && kill -CONT $(pgrep -f "bun.*api"); done',
      ),
  },
  {
    who: 'carol',
    gapMinutes: 12,
    text: 'That is a nasty one. Does it replay from the cursor or from the start?',
  },
  {
    who: 'dogancan',
    gapMinutes: 4,
    text: 'From the cursor. The gap is the interesting part — I will write it up.',
  },
  {
    who: 'bob',
    gapMinutes: 40,
    text: 'PR is up for the pool size change: https://github.com/purlay/purlay/pull/482',
    reactions: [{ emoji: '🚀', by: ['alice'] }],
  },
  {
    who: 'alice',
    gapMinutes: 18,
    text: 'Left two comments. The `DATABASE_POOL_MAX` default is the one I would argue about.',
  },
  {
    who: 'carol',
    gapMinutes: 70,
    text: 'Heads up: I am rotating the staging credentials after standup tomorrow.',
  },
  { who: 'bob', gapMinutes: 25, text: 'Ack.' },
  { who: 'alice', gapMinutes: 160, text: 'Evening. Anything blocking the release?' },
  { who: 'carol', gapMinutes: 8, text: 'Nothing on my side.' },
  {
    who: 'bob',
    gapMinutes: 14,
    text:
      'Migration dry run is clean. Output below.\n' +
      fence(
        'json',
        '{\n  "applied": 2,\n  "locks": { "max_wait_ms": 41, "tables": ["channel_members"] },\n  "validated": true\n}',
      ),
  },
  { who: 'alice', gapMinutes: 5, text: 'Great. Shipping in the morning.' },

  // Day two.
  {
    who: 'carol',
    gapMinutes: 840,
    text: 'Morning. Staging credentials rotated; if anything 401s, that is me.',
  },
  { who: 'alice', gapMinutes: 11, text: 'Deploying the release to production now.' },
  {
    who: 'alice',
    gapMinutes: 9,
    text: 'Production is up. Watching error rates.',
    reactions: [{ emoji: '🎉', by: ['bob', 'carol', 'dogancan'] }],
  },
  { who: 'bob', gapMinutes: 20, text: 'Error rate flat, p95 down 18 ms.' },
  { who: 'dogancan', gapMinutes: 12, text: 'Nice work, all of you.' },
  {
    who: 'bob',
    gapMinutes: 35,
    text:
      'The diff for the reconnect fix, for anyone reviewing on a phone:\n' +
      fence(
        'diff',
        '--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -12,7 +12,7 @@\n-const backoff = 1_000;\n+const backoff = 4_000;\n   return attempt * backoff;',
      ),
  },
  { who: 'carol', gapMinutes: 17, text: 'Looks right. The unit test for it?' },
  { who: 'bob', gapMinutes: 6, text: 'In the same commit, `retry.test.ts`.' },
  { who: 'alice', gapMinutes: 44, text: 'Standup notes are in the wiki.' },
  {
    who: 'carol',
    gapMinutes: 28,
    text: 'Do we want keyboard-only thread navigation before the first dogfood week?',
    key: 'keyboard-question',
    replies: [
      { who: 'bob', gapMinutes: 5, text: 'I would say yes. Half of us never touch the mouse.' },
      { who: 'alice', gapMinutes: 7, text: 'Agreed, as long as the focus ring stays visible.' },
    ],
  },
  {
    who: 'bob',
    gapMinutes: 38,
    text: 'Who owns the connection-pool limits once we move to two replicas?',
    key: 'pool-question',
    readUpTo: true,
  },
  // Unread for the viewer from here on.
  {
    who: 'alice',
    gapMinutes: 52,
    text: '@dogancan can you review the migration before the deploy window? It is small.',
    key: 'mention-review',
  },
  { who: 'carol', gapMinutes: 9, text: 'I can take the second half if @dogancan takes the first.' },
  { who: 'bob', gapMinutes: 21, text: 'Reminder: no deploys Friday after 15:00.' },
  {
    who: 'alice',
    gapMinutes: 33,
    text: 'Anyone seen `ECONNRESET` from the socket in staging in the last hour?',
  },
  { who: 'carol', gapMinutes: 10, text: 'Two, both while I was rotating credentials. Expected.' },
  {
    who: 'bob',
    gapMinutes: 27,
    text: 'Closing out my part of the release checklist. Thanks for the reviews.',
    reactions: [{ emoji: '✅', by: ['alice', 'carol'] }],
  },
  {
    who: 'alice',
    gapMinutes: 19,
    text: 'Thanks @dogancan — the notes on the reconnect gap were exactly what I needed.',
    reactions: [{ emoji: '❤️', by: ['dogancan'] }],
  },
  {
    who: 'carol',
    gapMinutes: 14,
    text: 'Also: the `ts` snippet from yesterday is now the README example.',
  },
  {
    who: 'alice',
    gapMinutes: 6,
    text: 'Last call for the changelog. @dogancan, yours is the only entry missing.',
  },
];

/** `#deploys`: a long, ordinary channel — two hundred notices, the viewer read up to the 120th. */
export const deploysChannel = (count = 200): readonly Step[] => {
  const people: readonly PersonaKey[] = ['alice', 'bob', 'carol'];
  const services = ['api', 'worker', 'web', 'migrations'] as const;
  const targets = ['staging', 'staging', 'production'] as const;
  const steps: Step[] = [];
  let state = 1_337;
  const next = (modulo: number): number => {
    // A small linear congruential step: the same numbers every run, no dice to inject.
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % modulo;
  };
  for (let index = 0; index < count; index++) {
    const who = people[index % people.length] ?? 'alice';
    const service = services[next(services.length)] ?? 'api';
    const target = targets[next(targets.length)] ?? 'staging';
    const hash = (1_048_576 + next(15_000_000)).toString(16).padStart(7, '0');
    const seconds = 20 + next(160);
    steps.push({
      who,
      gapMinutes: 1 + next(10),
      text: `Deployed \`${service}\` \`${hash}\` to ${target} in ${String(seconds)}s.`,
      ...(index === 119 ? { readUpTo: true, key: 'deploys-read' } : {}),
    });
  }
  return steps;
};

/** `#incidents`: one open thread that names the viewer, and a few notes around it. */
export const incidentsChannel = (): readonly Step[] => [
  {
    who: 'carol',
    gapMinutes: 0,
    text: 'Elevated 429s from the upstream since 09:05. Investigating.',
  },
  { who: 'alice', gapMinutes: 8, text: 'Confirmed. Backoff was too short; the fix is in review.' },
  {
    who: 'carol',
    gapMinutes: 11,
    text: '@dogancan can you confirm the status page text before we post it?',
    key: 'incident-open',
    replies: [
      {
        who: 'dogancan',
        gapMinutes: 3,
        text: 'Reads fine to me. Say what users see, not what we did.',
      },
      {
        who: 'alice',
        gapMinutes: 2,
        text: 'Rewritten: "Some messages were delayed for 25 minutes."',
      },
      {
        who: 'carol',
        gapMinutes: 4,
        text: 'Posting it. Did the alert threshold change after the March postmortem, or only the runbook?',
      },
    ],
  },
  {
    who: 'bob',
    gapMinutes: 18,
    text: 'Can we get a status page that is not hosted on our own infra?',
  },
  { who: 'alice', gapMinutes: 7, text: 'All clear as of 09:41. Postmortem on Thursday.' },
];

export const securityChannel = (): readonly Step[] => [
  {
    who: 'alice',
    gapMinutes: 0,
    text: 'Rotated the signing key; old sessions stay valid until they expire.',
  },
  {
    who: 'bob',
    gapMinutes: 12,
    text: 'Noted. Dependabot flagged two advisories; neither is reachable.',
  },
  { who: 'alice', gapMinutes: 9, text: 'Good. Closing the ticket.' },
];

/** The viewer's direct messages with Alice: two of them are unread. */
export const directMessages = (): readonly Step[] => [
  { who: 'alice', gapMinutes: 0, text: 'Do you have ten minutes to pair on the reconnect gap?' },
  { who: 'dogancan', gapMinutes: 6, text: 'Yes — after standup.', readUpTo: true },
  { who: 'alice', gapMinutes: 2, text: 'Perfect. I will bring the trace.' },
  { who: 'alice', gapMinutes: 55, text: 'Also, are you free Thursday for the postmortem?' },
];

/** A note to self: a direct message with one member. */
export const selfNotes = (): readonly Step[] => [
  {
    who: 'dogancan',
    gapMinutes: 0,
    text: 'Write up the reconnect gap: cursor vs. start, and the 60 s window.',
  },
  {
    who: 'dogancan',
    gapMinutes: 90,
    text: 'Check `DATABASE_POOL_MAX` against two replicas before Friday.',
  },
];

/** Every message a step list produces, replies included: what the seed will send. */
export const messageCount = (steps: readonly Step[]): number =>
  steps.reduce((total, step) => total + 1 + (step.replies?.length ?? 0), 0);
