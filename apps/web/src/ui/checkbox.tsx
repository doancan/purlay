/**
 * The check box and the radio button, drawn in the product's tokens (D-182).
 *
 * Each is the browser's own `<input>` — so the keyboard, the wrapping label, the form and the screen
 * reader are the platform's — made `appearance-none` and drawn by hand: a native one is a light box
 * whatever the theme, a different size in each browser, and sits off the baseline of the words beside it.
 * The tick and the dot are drawn after the input and shown by `peer-checked`, so what is on the screen
 * is the input's own state and cannot disagree with it.
 *
 * The edge is `border-strong`, the colour the contrast gate holds to 3:1 for the edge of a control; the
 * keyboard ring is the global one, inset over the edge like every bordered control's (`index.css`).
 */
import { Icon } from '../components/icon';
import { cn } from './cn';

type InputProps = Omit<React.ComponentPropsWithRef<'input'>, 'type' | 'children'>;

const boxClasses =
  'peer absolute inset-0 m-0 size-full cursor-pointer appearance-none border-hairline border-border-strong bg-surface-100 transition-colors duration-hover ease-standard checked:border-accent checked:bg-accent not-checked:not-disabled:hover:bg-surface-200 disabled:cursor-not-allowed disabled:border-border-subtle disabled:bg-surface-200';

export const Checkbox = ({ className, ...rest }: InputProps): React.JSX.Element => (
  <span className="relative mt-1 inline-flex size-icon-md shrink-0">
    <input {...rest} type="checkbox" className={cn(boxClasses, 'rounded-sm', className)} />
    <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-on-accent opacity-0 peer-checked:opacity-100">
      <Icon name="confirm" size="sm" />
    </span>
  </span>
);

export const Radio = ({ className, ...rest }: InputProps): React.JSX.Element => (
  <span className="relative mt-1 inline-flex size-icon-md shrink-0">
    <input {...rest} type="radio" className={cn(boxClasses, 'rounded-pill', className)} />
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 m-auto size-icon-sm scale-0 rounded-pill bg-on-accent transition-transform duration-hover ease-standard peer-checked:scale-50"
    />
  </span>
);
