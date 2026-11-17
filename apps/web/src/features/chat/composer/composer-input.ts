/** The text and selection shared by the Markdown field and the formatted editor. */
export interface ComposerInput {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  focus(): void;
  blur(): void;
  setSelectionRange(start: number, end: number): void;
}

export type ComposerKeyEvent = Pick<
  React.KeyboardEvent,
  | 'key'
  | 'code'
  | 'shiftKey'
  | 'metaKey'
  | 'ctrlKey'
  | 'altKey'
  | 'nativeEvent'
  | 'preventDefault'
  | 'stopPropagation'
> & { readonly currentTarget: ComposerInput };

export type ComposerPasteEvent = Pick<React.ClipboardEvent, 'clipboardData' | 'preventDefault'> & {
  readonly currentTarget: ComposerInput;
};
