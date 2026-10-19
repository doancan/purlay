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
  ArrowLeft,
  AtSign,
  Bell,
  Bookmark,
  BookmarkCheck,
  Star,
  Pin,
  PinOff,
  Bold,
  BellOff,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Code,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  Clock,
  Download,
  History,
  Quote,
  Copy,
  WrapText,
  Ellipsis,
  ExternalLink,
  File,
  GitMerge,
  GitPullRequest,
  Hash,
  Inbox,
  Info,
  Keyboard,
  KeyRound,
  Languages,
  Link2,
  Lock,
  LogOut,
  Menu,
  MessagesSquare,
  Monitor,
  Plug,
  Paperclip,
  Moon,
  Pencil,
  Plus,
  Reply,
  ScrollText,
  Search,
  SendHorizontal,
  Settings,
  Settings2,
  SmilePlus,
  Square,
  SquareCheck,
  Sun,
  Trash2,
  TriangleAlert,
  User,
  Users,
  X,
} from 'lucide-react';

/**
 * GitHub's mark, which the icon set does not carry (it dropped brand marks): drawn filled, at the
 * set's 24-unit grid, taking the same props a glyph of the set takes. Only where GitHub is named —
 * signing in with it.
 */
const GitHubMark = (props: React.SVGProps<SVGSVGElement>): React.JSX.Element => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
    <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.8 1.19 1.83 1.19 3.08 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
  </svg>
);

/** Meaning → glyph. The vocabulary of the interface's icons, in one place. */
const glyphs = {
  channel: Hash,
  channels: MessagesSquare,
  inbox: Inbox,
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
  preferences: Settings2,
  notifications: Bell,
  star: Star,
  save: Bookmark,
  saved: BookmarkCheck,
  pin: Pin,
  unpin: PinOff,
  'deep-work': BellOff,
  expand: ChevronRight,
  collapse: ChevronDown,
  'pull-request': GitPullRequest,
  merged: GitMerge,
  'open-question': CircleHelp,
  copy: Copy,
  wrap: WrapText,
  quote: Quote,
  bold: Bold,
  code: Code,
  mention: AtSign,
  edit: Pencil,
  delete: Trash2,
  file: File,
  attach: Paperclip,
  'task-done': SquareCheck,
  'task-open': Square,
  switch: ChevronsUpDown,
  light: Sun,
  dark: Moon,
  system: Monitor,
  language: Languages,
  'sign-out': LogOut,
  person: User,
  /** The workspace's people, as a list to manage — not one person. */
  people: Users,
  /** Who did which administrative thing: a record to read. */
  audit: ScrollText,
  /** How long the workspace keeps what was said. */
  history: History,
  /** Something that leaves the instance as a file. */
  download: Download,
  /** The thing itself, in a tab of its own: an image's original (D-159). */
  external: ExternalLink,
  /** One back and one on, in a sequence: the image viewer's pictures (D-159). */
  previous: ChevronLeft,
  next: ChevronRight,
  shortcuts: Keyboard,
  warning: TriangleAlert,
  info: Info,
  /** Back to where one came from: settings back to the conversation (D-146). */
  back: ArrowLeft,
  /** A link that lets somebody in: an invitation (D-115). */
  invite: Link2,
  /** What signs a person in, and the end of an account: sessions and erasure. */
  lock: KeyRound,
  /** Another service connected to the workspace: GitHub (D-23). */
  integration: Plug,
  /** GitHub itself: the sign-in button's mark. */
  github: GitHubMark,
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
