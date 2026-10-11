/**
 * The icons, and the only door to them.
 *
 * **One set, one weight, sized from the type scale** (D-52, D-97). Each of those is
 * enforced by there being exactly one way to draw an icon:
 *
 * - *one set* — `lucide-react` is imported here and nowhere else (lint refuses it
 *   elsewhere), and a screen asks for a glyph by what it *means* (`channel`,
 *   `resolved`), not by what the library calls it. Swapping the set is a change to
 *   this file; adding a glyph is a line in `glyphs`, which is where a reviewer sees
 *   the vocabulary grow;
 * - *one weight* — the line is `icon-stroke`, a token, applied here. `Icon` takes no
 *   `strokeWidth`, so no caller can have a second weight;
 * - *sized from the type scale* — the three sizes are `size-icon-sm|md|lg`, which
 *   sit beside the caption/label, body and title text styles. `Icon` takes no pixel
 *   size.
 *
 * An icon is decorative unless it is given a `label`: a glyph that stands alone
 * (an icon-only button) must say what it is, and one beside text must not say it
 * twice. Colour is `currentColor`, so the surrounding text colour — a token — is
 * the icon's colour, and meaning is never carried by colour alone (`UX.md` §9).
 */
import {
  Bell,
  BellOff,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock,
  Copy,
  Ellipsis,
  GitMerge,
  GitPullRequest,
  Hash,
  Info,
  Keyboard,
  Languages,
  Lock,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Plus,
  Reply,
  Search,
  SendHorizontal,
  Settings,
  SmilePlus,
  Square,
  SquareCheck,
  Sun,
  TriangleAlert,
  User,
  X,
} from 'lucide-react';

/** Meaning → glyph. The vocabulary of the interface's icons, in one place. */
const glyphs = {
  channel: Hash,
  'private-channel': Lock,
  search: Search,
  reply: Reply,
  send: SendHorizontal,
  resolved: CircleCheck,
  failed: CircleAlert,
  sending: Clock,
  menu: Menu,
  'ci-failed': CircleX,
  confirm: Check,
  close: X,
  add: Plus,
  more: Ellipsis,
  react: SmilePlus,
  settings: Settings,
  notifications: Bell,
  'deep-work': BellOff,
  expand: ChevronRight,
  collapse: ChevronDown,
  'pull-request': GitPullRequest,
  merged: GitMerge,
  'open-question': CircleHelp,
  copy: Copy,
  'task-done': SquareCheck,
  'task-open': Square,
  switch: ChevronsUpDown,
  light: Sun,
  dark: Moon,
  system: Monitor,
  language: Languages,
  'sign-out': LogOut,
  person: User,
  shortcuts: Keyboard,
  warning: TriangleAlert,
  info: Info,
} as const;

export type GlyphName = keyof typeof glyphs;

/** Every glyph, for the test that draws each and for a future catalogue page. */
export const glyphNames = Object.keys(glyphs) as readonly GlyphName[];

/** The three sizes, each a token, each the height of a text style's line. */
const iconClasses = {
  sm: 'size-icon-sm icon-stroke shrink-0',
  md: 'size-icon-md icon-stroke shrink-0',
  lg: 'size-icon-lg icon-stroke shrink-0',
} as const;

type IconSize = keyof typeof iconClasses;

interface IconProps {
  readonly name: GlyphName;
  readonly size?: IconSize;
  /** What the icon says, when nothing beside it does. Without it the icon is hidden from assistive technology. */
  readonly label?: string;
}

export const Icon = ({ name, size = 'md', label }: IconProps): React.JSX.Element => {
  const Glyph = glyphs[name];
  return label === undefined ? (
    <Glyph className={iconClasses[size]} aria-hidden="true" focusable="false" />
  ) : (
    <Glyph className={iconClasses[size]} role="img" aria-label={label} focusable="false" />
  );
};
