/**
 * Which colours must be readable against which, and by how much.
 *
 * This table is the only place a contrast number is written down. The usage notes
 * in `tokens.json` deliberately carry none: a figure in prose is a second copy, and
 * the second copy is the one that goes stale (`CONTRIBUTING.md` §6.1). What a note
 * may say is *where* a colour goes; whether it is legible there is arithmetic, and
 * the arithmetic is `tokens.test.ts` running this table over every theme.
 *
 * Two thresholds, WCAG 2.x:
 *
 * - **4.5** for text, and for anything that carries meaning as text would.
 * - **3** for a boundary or a ring that must be seen to operate a control
 *   (1.4.11): an input's edge, the focus ring.
 *
 * **Completeness is checked the other way too.** Every colour token must appear in
 * a pair or in `EXEMPT` with a reason, so adding a colour without deciding what it
 * has to be readable against fails the build. That is the whole point of a table
 * over a convention.
 */

const TEXT = 4.5;
const BOUNDARY = 3;

export interface Pair {
  /** The colour that is drawn: text, an icon, a border, a ring. */
  readonly foreground: string;
  /** The colour it is drawn on. */
  readonly background: string;
  readonly minimum: number;
  readonly why: string;
}

const cross = (
  foregrounds: readonly string[],
  backgrounds: readonly string[],
  minimum: number,
  why: string,
): readonly Pair[] =>
  foregrounds.flatMap((foreground) =>
    backgrounds.map((background) => ({ foreground, background, minimum, why })),
  );

const SURFACES = ['surface-000', 'surface-050', 'surface-100', 'surface-200'] as const;
const AVATARS = ['avatar-1', 'avatar-2', 'avatar-3', 'avatar-4', 'avatar-5', 'avatar-6'] as const;
const READING = [...SURFACES, 'accent-subtle', 'code-bg'] as const;
const SYNTAX = [
  'syntax-keyword',
  'syntax-string',
  'syntax-number',
  'syntax-comment',
  'syntax-function',
  'syntax-type',
  'syntax-operator',
] as const;

export const PAIRS: readonly Pair[] = [
  ...cross(
    ['ink', 'ink-muted', 'ink-subtle'],
    READING,
    TEXT,
    'message text, secondary text and meta',
  ),
  ...cross(['ink'], AVATARS, TEXT, 'the initials in an avatar'),
  // `accent` is a fill; its words are `accent-text`, on whatever the message sits on,
  // including a mention's tint and the active row (D-110).
  ...cross(
    ['accent-text'],
    [...SURFACES, 'accent-subtle'],
    TEXT,
    'link text, the active row, a count',
  ),
  ...cross(
    ['on-accent'],
    ['accent', 'accent-hover'],
    TEXT,
    'text on a primary button, at rest and hovered',
  ),
  ...cross(['on-status'], ['danger', 'warning', 'success'], TEXT, 'text on a status fill'),
  ...cross(
    ['danger-text', 'warning-text', 'success-text'],
    SURFACES,
    TEXT,
    'status written as text',
  ),
  ...cross(['danger-text'], ['danger-subtle'], TEXT, 'a status pill: failed'),
  ...cross(['warning-text'], ['warning-subtle'], TEXT, 'a status pill: open, Deep Work'),
  ...cross(['success-text'], ['success-subtle'], TEXT, 'a status pill: resolved'),
  ...cross(SYNTAX, ['code-bg'], TEXT, 'code, the usual casualty (UX §9)'),
  ...cross(['border-strong'], READING, BOUNDARY, 'the edge of a control'),
  ...cross(['focus-ring'], READING, BOUNDARY, 'the keyboard focus ring (UX §8)'),
];

/**
 * Colours that are never drawn *as* foreground against a background and so have
 * no ratio of their own — each with the reason, so an exemption is a decision
 * somebody can read and disagree with.
 */
export const EXEMPT: Readonly<Record<string, string>> = {
  'surface-000': 'a background; it is the `background` of the pairs above',
  'surface-050': 'a background; it is the `background` of the pairs above',
  'surface-100': 'a background; it is the `background` of the pairs above',
  'surface-200': 'a background; it is the `background` of the pairs above',
  'avatar-1': 'a background; it is the `background` of the pairs above',
  'avatar-2': 'a background; it is the `background` of the pairs above',
  'avatar-3': 'a background; it is the `background` of the pairs above',
  'avatar-4': 'a background; it is the `background` of the pairs above',
  'avatar-5': 'a background; it is the `background` of the pairs above',
  'avatar-6': 'a background; it is the `background` of the pairs above',
  'code-bg': 'a background; it is the `background` of the pairs above',
  'accent-subtle': 'a background; it is the `background` of the pairs above',
  'danger-subtle': 'a background; it is the `background` of the pairs above',
  'warning-subtle': 'a background; it is the `background` of the pairs above',
  'success-subtle': 'a background; it is the `background` of the pairs above',
  accent: 'a fill; its legibility is `on-accent` on it, and its words are `accent-text`',
  'accent-hover': 'a fill; its legibility is `on-accent` on it',
  'border-subtle': 'decorative: a divider that carries no meaning, so it is allowed to be faint',
  danger:
    'a fill; its legibility is `on-status` on it, and it never carries meaning without a label',
  warning:
    'a fill; its legibility is `on-status` on it, and it never carries meaning without a label',
  success:
    'a fill; its legibility is `on-status` on it, and it never carries meaning without a label',
  scrim: 'translucent, so it has the contrast of what it covers; it dims the page behind a layer',
};
