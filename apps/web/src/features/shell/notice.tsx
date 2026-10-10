/**
 * What a screen with nothing to show, or nowhere to go, looks like in the new identity (D-100):
 * centred in its card, a tile that says what kind of moment this is, a title, one sentence and,
 * where there is one, the next action. It is the shape `UX.md` §8 asks of an empty state — an
 * invitation to act — drawn so none of them reads as a page that forgot its content.
 *
 * `LogoMark` is the product's one drawn object: a tile of the accent with the letter that
 * starts its name. It is built from the tokens, so it is right in both themes, and it is the
 * same tile on the sign-in card and in the empty states that belong to the product rather than
 * to a missing channel.
 */
import { Icon, type GlyphName } from '../../components/icon';

type Heading = 'h1' | 'h2';

export const LogoMark = (): React.JSX.Element => (
  <span
    aria-hidden="true"
    className="inline-flex size-avatar-lg shrink-0 items-center justify-center rounded-md bg-accent text-title text-on-accent"
  >
    P
  </span>
);

interface NoticeProps {
  readonly glyph: GlyphName;
  readonly title: string;
  readonly body: string;
  readonly action?: React.ReactNode;
  readonly as?: Heading;
}

export const Notice = ({
  glyph,
  title,
  body,
  action,
  as: Title = 'h2',
}: NoticeProps): React.JSX.Element => (
  <section className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
    <span
      aria-hidden="true"
      className="inline-flex size-avatar-lg items-center justify-center rounded-md bg-surface-200 text-ink-muted"
    >
      <Icon name={glyph} size="lg" />
    </span>
    <Title className="text-title text-ink">{title}</Title>
    <p className="max-w-dialog text-body text-ink-muted">{body}</p>
    {action}
  </section>
);
