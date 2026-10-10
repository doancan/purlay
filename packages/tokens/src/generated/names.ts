// Generated from tokens.json by `bun run tokens:generate`. Do not edit: the build
// regenerates it and fails on a difference (D-97).

/** The theme `:root` carries when nothing chose one: the first in tokens.json. */
export const defaultTheme = 'dark';

export const themes = [
  'dark',
  'light',
] as const;

export const colorTokens = [
  'surface-000',
  'canvas',
  'surface-100',
  'surface-200',
  'code-bg',
  'border-subtle',
  'border-strong',
  'ink',
  'ink-muted',
  'accent',
  'on-accent',
  'accent-subtle',
  'avatar-1',
  'avatar-2',
  'avatar-3',
  'avatar-4',
  'avatar-5',
  'avatar-6',
  'focus-ring',
  'danger',
  'warning',
  'success',
  'on-status',
  'danger-text',
  'warning-text',
  'success-text',
  'scrim',
  'syntax-keyword',
  'syntax-string',
  'syntax-number',
  'syntax-comment',
  'syntax-function',
  'syntax-type',
  'syntax-operator',
] as const;

export const spacingTokens = [
  'space-0',
  'space-1',
  'space-2',
  'space-3',
  'space-4',
  'space-5',
  'space-6',
  'space-8',
] as const;

export const radiusTokens = [
  'radius-sm',
  'radius-md',
  'radius-lg',
  'radius-pill',
] as const;

export const shadowTokens = [
  'shadow-card',
  'shadow-float',
] as const;

export const sizeTokens = [
  'size-sidebar',
  'size-members',
  'size-feed-max',
  'size-narrow',
  'size-control',
  'size-touch',
  'size-header',
  'size-badge',
  'size-dot',
  'size-code-clamp',
  'size-dialog',
  'size-palette',
  'size-palette-list',
  'size-toast',
  'size-focus-offset',
  'size-icon-sm',
  'size-icon-md',
  'size-icon-lg',
  'size-avatar',
  'size-avatar-sm',
  'size-avatar-lg',
] as const;

export const zIndexTokens = [
  'z-sticky',
  'z-overlay',
  'z-popover',
  'z-palette',
  'z-toast',
] as const;

export const borderWidthTokens = [
  'stroke-hairline',
  'stroke-focus',
  'stroke-marker',
  'stroke-icon',
] as const;

export const durationTokens = [
  'duration-collapse',
  'duration-bar',
] as const;

export const easingTokens = [
  'easing-standard',
] as const;

export const textStyles = [
  'display',
  'title',
  'heading',
  'body',
  'label',
  'caption',
  'code',
] as const;

/** Every token that is a CSS custom property, by name (type styles are `text-*` utilities). */
export type TokenName =
  | (typeof colorTokens)[number]
  | (typeof spacingTokens)[number]
  | (typeof radiusTokens)[number]
  | (typeof shadowTokens)[number]
  | (typeof sizeTokens)[number]
  | (typeof zIndexTokens)[number]
  | (typeof borderWidthTokens)[number]
  | (typeof durationTokens)[number]
  | (typeof easingTokens)[number];
