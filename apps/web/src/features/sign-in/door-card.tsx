/**
 * The two cards of the screens outside the app — sign-in, sign-up, a sign-in link, an invitation, the native
 * hand-off, the admission and a letter's stop link — said once, so none of them is a different width, corner or
 * padding of the same card.
 *
 * - `DoorCard` is a card with something to do in it: the mark, a heading, and a form or a choice, centred.
 * - `DoorNotice` is a card that only says something — a link that does not open, a step that is done — and offers
 *   the way on: the notice the rest of the product uses (`ui/notice`), framed, with its glyph and no mark, since
 *   a mark above a glyph is two pictures for one sentence.
 */
import type { GlyphName } from '../../components/icon';
import { Notice } from '../../ui/notice';
import { StandaloneCard, StandaloneScreen } from '../shell/standalone';

export const DoorCard = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <StandaloneScreen>
    <section className="flex w-full max-w-dialog flex-col items-center gap-6 rounded-2xl border-hairline border-border-subtle bg-surface-100 px-10 py-12 text-center shadow-float max-narrow:px-6 max-narrow:py-8">
      {children}
    </section>
  </StandaloneScreen>
);

export const DoorNotice = ({
  glyph,
  title,
  body,
  action,
}: {
  readonly glyph: GlyphName;
  readonly title: string;
  readonly body: string;
  readonly action?: React.ReactNode;
}): React.JSX.Element => (
  <StandaloneScreen>
    <StandaloneCard>
      <Notice
        as="h1"
        glyph={glyph}
        title={title}
        body={body}
        {...(action === undefined ? {} : { action })}
      />
    </StandaloneCard>
  </StandaloneScreen>
);
