/**
 * Text for a screen reader that is not drawn.
 *
 * Radix's, re-exported under one name: the clip-and-collapse recipe is easy to get
 * subtly wrong (a `display: none` is hidden from assistive technology too; a
 * `1px` box with the wrong overflow still takes focus), and it is also a set of
 * literal lengths the token vocabulary rightly refuses to let a component write.
 */
export { Root as VisuallyHidden } from '@radix-ui/react-visually-hidden';
