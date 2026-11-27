/** A formatted editing surface; Markdown remains the draft and transport format. */
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { AllSelection, EditorState, TextSelection, type Command } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import {
  baseKeymap,
  chainCommands,
  lift,
  liftEmptyBlock,
  newlineInCode,
  setBlockType,
  toggleMark,
  wrapIn,
} from 'prosemirror-commands';
import { closeHistory, history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
  undoInputRule,
} from 'prosemirror-inputrules';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { goToNextCell, tableEditing } from 'prosemirror-tables';
import {
  readRichDocument,
  originalRichSource,
  richPosition,
  richOffset,
  richSchema,
  writeRichDocument,
  type RichSource,
} from './rich-document';
import type { ComposerInput, ComposerKeyEvent, ComposerPasteEvent } from './composer-input';
import { editorValue } from './rich-document';
import type { MarkdownKind, Selection } from './composer-text';
import { emoticonEndingAt } from './emoticons';
import { formattingRanges } from '@purlay/markdown';
import { activeFormatting } from './active-formatting';
import {
  clearFormatting,
  emptyRichDraft,
  leaveCode,
  richMessageText,
  selectedLink,
  writeLink,
  type EditorLink,
} from './rich-editing';
export interface RichInput extends ComposerInput {
  readonly element: HTMLElement;
  readonly inCode: boolean;
  readonly selectedText: string;
  readonly empty: boolean;
  format(kind: MarkdownKind): boolean;
  insertText(value: string): void;
  insertLink(label: string, address: string): void;
  forSend(): string;
  finishFace(): void;
  loadSource(text: string, selected: Selection): void;
  clearFormatting(): void;
  currentLink(): EditorLink | null;
  removeLink(): void;
  leaveCode(): void;
}
interface Props {
  readonly value: string;
  readonly input: RefObject<RichInput | null>;
  readonly hidden: boolean;
  readonly autoFocus: boolean;
  readonly label: string;
  readonly description: string;
  readonly placeholder: string;
  readonly taskLabel: string;
  readonly invalid: boolean;
  readonly controls: string | undefined;
  readonly activeDescendant: string | undefined;
  readonly onChange: (text: string, selection: Selection) => void;
  readonly onSelect: (selection: Selection, active: ReadonlySet<MarkdownKind>) => void;
  readonly onKeyDown: (event: ComposerKeyEvent) => void;
  readonly onPaste: (event: ComposerPasteEvent) => void;
  readonly onUseSource: () => void;
  readonly onReady: () => void;
}
const markNames = { bold: 'strong', italic: 'em', strike: 'strike', inlineCode: 'code' } as const;
const markRule = (
  pattern: RegExp,
  name: 'strong' | 'em' | 'strike' | 'code',
  width: number,
): InputRule =>
  new InputRule(pattern, (state, match, start, end) => {
    const whole = match[1];
    const content = match[2];
    if (whole === undefined || content === undefined) return null;
    const from = start + match[0].indexOf(whole);
    const mark = richSchema.mark(name);
    return state.tr
      .delete(from + width + content.length, end)
      .delete(from, from + width)
      .addMark(from, from + content.length, mark)
      .removeStoredMark(mark);
  });
const FENCE_LINE = /^```([\w-]*)$/;
/**
 * Enter at the end of a line of ``` (and a language) opens the code block a space there would: the hint
 * under the box says ``` starts one, and Enter there used to send the three backticks as a message.
 */
const openFenceOnEnter: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== richSchema.nodes.paragraph) return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  const match = FENCE_LINE.exec($from.parent.textContent);
  const index = $from.index(-1);
  if (
    match === null ||
    !$from.node(-1).canReplaceWith(index, index + 1, richSchema.nodes.code_block)
  )
    return false;
  if (dispatch !== undefined) {
    const tr = state.tr
      .delete($from.start(), $from.pos)
      .setNodeMarkup($from.before(), richSchema.nodes.code_block, {
        language: match[1] === '' ? null : match[1],
      });
    dispatch(tr.scrollIntoView());
  }
  return true;
};
export const RichEditor = (props: Props): React.JSX.Element => {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const current = useRef(props);
  current.current = props;
  const lastText = useRef(props.hidden ? '' : props.value);
  const externalUpdate = useRef<((value: string) => void) | null>(null);
  useLayoutEffect(() => {
    if (host.current === null) return;
    let source: RichSource;
    let applyingExternal = false;
    let madeFace: { from: number; to: number; typed: string; caret: number } | null = null;
    const selection = (state: EditorState): Selection => ({
      start: richOffset(
        source,
        state.selection.from,
        state.selection.empty
          ? (state.storedMarks ?? state.selection.$from.marks())
          : state.selection.$from.marks(),
      ),
      end: richOffset(
        source,
        state.selection.to,
        state.selection.empty
          ? (state.storedMarks ?? state.selection.$to.marks())
          : state.selection.$to.marks(),
      ),
    });
    const announce = (): void => {
      if (current.current.hidden) return;
      const { state } = view;
      const active = new Set<MarkdownKind>();
      for (const kind of ['bold', 'italic', 'strike', 'inlineCode'] as const) {
        const name = markNames[kind];
        const mark = richSchema.marks[name];
        let selected =
          mark.isInSet(state.storedMarks ?? state.selection.$from.marks()) !== undefined;
        if (!state.selection.empty) {
          const spans: boolean[] = [];
          state.doc.nodesBetween(state.selection.from, state.selection.to, (child) => {
            if (child.isInline) spans.push(mark.isInSet(child.marks) !== undefined);
          });
          selected = spans.length > 0 && spans.every(Boolean);
        }
        if (selected) active.add(kind);
      }
      const ancestors = new Set<string>();
      let itemSeen = false;
      let listSeen = false;
      let task = false;
      for (let depth = state.selection.$from.depth; depth > 0; depth--) {
        const parent = state.selection.$from.node(depth);
        ancestors.add(parent.type.name);
        if (!itemSeen && parent.type.name === 'list_item') {
          task = parent.attrs['checked'] !== null;
          itemSeen = true;
        }
        if (
          !listSeen &&
          (parent.type.name === 'ordered_list' || parent.type.name === 'bullet_list')
        ) {
          active.add(task ? 'tasks' : parent.type.name === 'ordered_list' ? 'numbers' : 'bullets');
          listSeen = true;
        }
      }
      if (ancestors.has('code_block')) active.add('code');
      if (ancestors.has('blockquote')) active.add('quote');
      if (!state.selection.empty) {
        const whole = activeFormatting(
          source.text,
          formattingRanges(source.text),
          selection(state),
        );
        for (const kind of ['bullets', 'numbers', 'tasks', 'quote', 'code'] as const) {
          active.delete(kind);
          if (whole.has(kind)) active.add(kind);
        }
      }
      current.current.onSelect(selection(state), active);
    };
    const view = new EditorView(host.current, {
      state: EditorState.create({
        doc: readRichDocument(current.current.hidden ? '' : current.current.value),
        plugins: [
          history(),
          inputRules({
            rules: [
              markRule(/(?:^|\s)(\*\*([^*]+)\*\*)$/, 'strong', 2),
              markRule(/(?:^|\s)(\*([^*]+)\*)$/, 'em', 1),
              markRule(/(?:^|\s)(_([^_]+)_)$/, 'em', 1),
              markRule(/(?:^|\s)(~~([^~]+)~~)$/, 'strike', 2),
              markRule(/(?:^|\s)(`([^`]+)`)$/, 'code', 1),
              new InputRule(/(?:^|\s)\S{1,8} $/, (state, match, start, end) => {
                const face = emoticonEndingAt(match[0], match[0].length - 1);
                return face === null
                  ? null
                  : state.tr.insertText(face.emoji + ' ', start + face.start, end);
              }),
              wrappingInputRule(/^\s*>\s$/, richSchema.nodes.blockquote),
              wrappingInputRule(/^\s*([-+*])\s$/, richSchema.nodes.bullet_list),
              wrappingInputRule(/^(\d+)\.\s$/, richSchema.nodes.ordered_list, (match) => ({
                order: Number(match[1]),
              })),
              textblockTypeInputRule(/^```([\w-]*)\s$/, richSchema.nodes.code_block, (match) => ({
                language: match[1] === '' ? null : match[1],
              })),
              textblockTypeInputRule(/^(#{1,3})\s$/, richSchema.nodes.heading, (match) => ({
                level: editorValue(match[1]).length,
              })),
            ],
          }),
          keymap({
            'Mod-z': undo,
            'Mod-Shift-z': redo,
            'Mod-y': redo,
            Backspace: undoInputRule,
            Enter: chainCommands(
              splitListItem(richSchema.nodes.list_item),
              editorValue(baseKeymap['Enter']),
            ),
            'Shift-Enter': chainCommands(
              newlineInCode,
              splitListItem(richSchema.nodes.list_item),
              liftEmptyBlock,
              (state, dispatch) => {
                for (let depth = state.selection.$from.depth; depth > 0; depth--) {
                  if (state.selection.$from.node(depth).type.name !== 'table') continue;
                  const position = state.selection.$from.after(depth);
                  const tr = state.tr.insert(position, richSchema.node('paragraph'));
                  dispatch?.(
                    tr.setSelection(TextSelection.create(tr.doc, position + 1)).scrollIntoView(),
                  );
                  return true;
                }
                dispatch?.(
                  state.tr.replaceSelectionWith(richSchema.node('hard_break')).scrollIntoView(),
                );
                return true;
              },
            ),
            Tab: chainCommands(goToNextCell(1), sinkListItem(richSchema.nodes.list_item)),
            'Shift-Tab': chainCommands(goToNextCell(-1), liftListItem(richSchema.nodes.list_item)),
          }),
          keymap(baseKeymap),
          tableEditing(),
        ],
      }),
      attributes: (state): Record<string, string> => ({
        role: 'textbox',
        tabindex: '0',
        'aria-multiline': 'true',
        'data-composer': '',
        class: 'purlay-rich-editor outline-none',
        'data-empty': String(
          state.doc.childCount === 1 &&
            state.doc.firstChild?.type === richSchema.nodes.paragraph &&
            state.doc.firstChild.content.size === 0,
        ),
      }),
      dispatchTransaction(transaction): void {
        const state = view.state.apply(transaction);
        view.updateState(state);
        if (madeFace !== null) {
          if (applyingExternal) madeFace = null;
          else {
            madeFace.from = transaction.mapping.map(madeFace.from, -1);
            madeFace.to = transaction.mapping.map(madeFace.to, -1);
            madeFace.caret = state.selection.from;
          }
        }
        if (transaction.docChanged) {
          source = writeRichDocument(state.doc);
          lastText.current = source.text;
          if (!applyingExternal) current.current.onChange(source.text, selection(state));
        }
        announce();
      },
      handleDOMEvents: {
        click: (_view, event): boolean => {
          const target = event.target;
          if (
            !(target instanceof HTMLElement) ||
            !target.hasAttribute('data-task-box') ||
            target.parentElement === null
          )
            return false;
          const position = view.posAtDOM(target.parentElement, 0);
          const resolved = view.state.doc.resolve(position);
          for (let depth = resolved.depth; depth > 0; depth--) {
            const item = resolved.node(depth);
            if (item.type.name !== 'list_item') continue;
            event.preventDefault();
            view.dispatch(
              view.state.tr.setNodeMarkup(resolved.before(depth), undefined, {
                checked: !item.attrs['checked'],
              }),
            );
            view.focus();
            return true;
          }
          return false;
        },
        keydown: (_view, event): boolean => {
          const made = madeFace;
          madeFace = null;
          if (
            event.key === 'Backspace' &&
            made !== null &&
            view.state.selection.empty &&
            view.state.selection.from === made.caret
          ) {
            event.preventDefault();
            const tr = view.state.tr.insertText(made.typed, made.from, made.to);
            view.dispatch(
              tr
                .setSelection(TextSelection.create(tr.doc, tr.mapping.map(made.caret)))
                .scrollIntoView(),
            );
            return true;
          }
          if (
            event.target instanceof HTMLElement &&
            event.target.hasAttribute('data-task-box') &&
            (event.key === ' ' || event.key === 'Enter')
          ) {
            event.preventDefault();
            event.target.click();
            return true;
          }
          if (
            event.key === 'Enter' &&
            !event.isComposing &&
            !event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            openFenceOnEnter(view.state, view.dispatch)
          ) {
            event.preventDefault();
            return true;
          }
          const input = current.current.input.current;
          if (input === null) return false;
          current.current.onKeyDown({
            currentTarget: input,
            nativeEvent: event,
            key: event.key,
            code: event.code,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            preventDefault: () => {
              event.preventDefault();
            },
            stopPropagation: () => {
              event.stopPropagation();
            },
          });
          return event.defaultPrevented;
        },
        paste: (_view, event): boolean => {
          const input = current.current.input.current;
          if (input === null || event.clipboardData === null) return false;
          current.current.onPaste({
            currentTarget: input,
            clipboardData: event.clipboardData,
            preventDefault: () => {
              event.preventDefault();
            },
          });
          // Let ProseMirror insert plain words, never unsanitised clipboard HTML. Rich conversions
          // already passed through the composer's existing clipboard policy above.
          if (!event.defaultPrevented) {
            event.preventDefault();
            input.insertText(event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'));
          }
          return true;
        },
      },
    });
    viewRef.current = view;
    const initialSource = originalRichSource(
      view.state.doc,
      current.current.hidden ? '' : current.current.value,
    );
    source = initialSource ?? writeRichDocument(view.state.doc);
    if (initialSource === null) current.current.onUseSource();
    const run = (command: Command): boolean => {
      const result = command(view.state, view.dispatch, view);
      view.focus();
      return result;
    };
    const input: RichInput = {
      get value() {
        return source.text;
      },
      get selectionStart() {
        return selection(view.state).start;
      },
      get selectionEnd() {
        return selection(view.state).end;
      },
      get element() {
        return view.dom;
      },
      get inCode() {
        return view.state.selection.$from.parent.type.name === 'code_block';
      },
      get selectedText() {
        return view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, '\n');
      },
      get empty() {
        return emptyRichDraft(view.state.doc);
      },
      focus: () => {
        view.focus();
      },
      blur: () => {
        view.dom.blur();
      },
      setSelectionRange: (start, end) => {
        const from = richPosition(source, start);
        const to = richPosition(source, end);
        const selected = TextSelection.between(
          view.state.doc.resolve(from),
          view.state.doc.resolve(to),
        );
        const tr = view.state.tr.setSelection(selected);
        if (start === end) {
          const edge = source.edges.get(from)?.find((candidate) => candidate.offset === start);
          if (edge !== undefined) {
            const available = [
              ...selected.$from.marks(),
              ...(selected.$from.nodeBefore?.marks ?? []),
              ...(selected.$from.nodeAfter?.marks ?? []),
            ];
            const marks = available.filter(
              (mark, index) =>
                edge.marks.includes(mark.type.name) &&
                available.findIndex((other) => other.type === mark.type) === index,
            );
            tr.setStoredMarks(marks);
          }
        }
        view.dispatch(tr);
      },
      insertText: (value) => {
        view.dispatch(view.state.tr.insertText(value).scrollIntoView());
        view.focus();
      },
      insertLink: (label, address) => {
        run(writeLink(label, address));
      },
      loadSource: (value, selected) => {
        if (value !== source.text) externalUpdate.current?.(value);
        input.setSelectionRange(selected.start, selected.end);
      },
      clearFormatting: () => {
        run(clearFormatting);
      },
      currentLink: () => {
        const link = selectedLink(view.state);
        if (link !== null)
          view.dispatch(
            view.state.tr.setSelection(TextSelection.create(view.state.doc, link.from, link.to)),
          );
        return link;
      },
      removeLink: () => {
        const link = selectedLink(view.state);
        if (link === null) return;
        view.dispatch(
          closeHistory(
            view.state.tr.removeMark(link.from, link.to, richSchema.marks.link).setStoredMarks([]),
          ).scrollIntoView(),
        );
        view.focus();
      },
      leaveCode: () => {
        run(leaveCode);
      },
      forSend: () => {
        return richMessageText(view.state, source.text);
      },
      finishFace: () => {
        const { state } = view;
        if (!state.selection.empty) return;
        const position = state.selection.$from;
        if (
          position.parent.type.name === 'code_block' ||
          richSchema.marks.code.isInSet(position.marks()) !== undefined
        )
          return;
        const prefix = position.parent.textBetween(0, position.parentOffset, '\n', '\n');
        const face = emoticonEndingAt(prefix, prefix.length);
        if (face === null) return;
        const from = position.start() + face.start;
        const tr = state.tr.insertText(face.emoji, from, position.start() + face.end);
        view.dispatch(tr);
        madeFace = {
          from,
          to: from + face.emoji.length,
          typed: face.typed,
          caret: tr.selection.from,
        };
      },
      format: (kind) => {
        switch (kind) {
          case 'bold':
          case 'italic':
          case 'strike':
          case 'inlineCode':
            return run(toggleMark(richSchema.marks[markNames[kind]]));
          case 'code':
            return run(setBlockType(richSchema.nodes.code_block));
          case 'quote':
            return run(
              view.state.selection.$from.depth > 1 &&
                view.state.selection.$from.node(1).type.name === 'blockquote'
                ? lift
                : wrapIn(richSchema.nodes.blockquote),
            );
          case 'bullets':
          case 'numbers':
          case 'tasks': {
            if (view.state.selection instanceof AllSelection) {
              view.dispatch(
                view.state.tr.setSelection(
                  TextSelection.between(
                    view.state.doc.resolve(0),
                    view.state.doc.resolve(view.state.doc.content.size),
                  ),
                ),
              );
            }
            const type =
              kind === 'numbers' ? richSchema.nodes.ordered_list : richSchema.nodes.bullet_list;
            const { $from } = view.state.selection;
            if ($from.depth >= 2 && $from.node($from.depth - 1).type.name === 'list_item') {
              const item = $from.node($from.depth - 1);
              const list = $from.node($from.depth - 2);
              const already =
                list.type === type && (kind === 'tasks') === (item.attrs['checked'] !== null);
              if (already) return run(liftListItem(richSchema.nodes.list_item));
              const listPosition = $from.before($from.depth - 2);
              const tr = view.state.tr.setNodeMarkup(
                listPosition,
                type,
                kind === 'numbers' ? { order: 1 } : undefined,
              );
              list.forEach((_child, offset) => {
                tr.setNodeMarkup(listPosition + 1 + offset, undefined, {
                  checked: kind === 'tasks' ? false : null,
                });
              });
              view.dispatch(tr);
              view.focus();
              return true;
            }
            const result = run(wrapInList(type));
            if (result && kind === 'tasks') {
              const tr = view.state.tr;
              view.state.doc.nodesBetween(
                view.state.selection.from,
                view.state.selection.to,
                (child, position) => {
                  if (child.type === richSchema.nodes.list_item)
                    tr.setNodeMarkup(position, undefined, { checked: false });
                },
              );
              view.dispatch(tr);
            }
            return result;
          }
          case 'table':
          case 'link':
          case 'mention':
            return false;
        }
      },
    };
    current.current.input.current = input;
    const updateExternal = (value: string): void => {
      applyingExternal = true;
      const doc = readRichDocument(value);
      const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
      tr.setSelection(TextSelection.atEnd(tr.doc));
      view.dispatch(tr);
      applyingExternal = false;
      const original = originalRichSource(view.state.doc, value);
      if (original === null) current.current.onUseSource();
      else source = original;
      lastText.current = value;
      announce();
    };
    externalUpdate.current = updateExternal;
    view.dispatch(view.state.tr.setSelection(TextSelection.atEnd(view.state.doc)));
    if (current.current.autoFocus && !current.current.hidden) view.focus();
    current.current.onReady();
    return (): void => {
      current.current.input.current = null;
      viewRef.current = null;
      externalUpdate.current = null;
      view.destroy();
    };
  }, []);
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dom.setAttribute('aria-label', props.label);
    view.dom.setAttribute('aria-describedby', props.description);
    view.dom.setAttribute('data-placeholder', props.placeholder);
    view.dom.setAttribute('aria-invalid', String(props.invalid));
    if (props.hidden) view.dom.removeAttribute('data-composer');
    else view.dom.setAttribute('data-composer', '');
    for (const checkbox of view.dom.querySelectorAll<HTMLElement>('[data-task-box]')) {
      const words = checkbox.parentElement?.textContent.replace(/^[☑☐]/, '').trim() ?? '';
      checkbox.setAttribute('aria-label', `${props.taskLabel}: ${words}`);
    }
    for (const [key, value] of [
      ['aria-controls', props.controls],
      ['aria-activedescendant', props.activeDescendant],
    ] as const) {
      if (value === undefined) view.dom.removeAttribute(key);
      else view.dom.setAttribute(key, value);
    }
    if (props.hidden || props.value === lastText.current) return;
    externalUpdate.current?.(props.value);
  }, [
    props.value,
    props.hidden,
    props.label,
    props.description,
    props.placeholder,
    props.taskLabel,
    props.invalid,
    props.controls,
    props.activeDescendant,
  ]);
  useLayoutEffect(() => {
    const element = host.current;
    if (element === null) return;
    const fit = (): void => {
      const line = parseFloat(getComputedStyle(element).lineHeight) || 24;
      const viewport = window.visualViewport?.height ?? window.innerHeight;
      element.style.minHeight = `${String(line * 2)}px`;
      element.style.maxHeight = `${String(Math.max(line * 2, Math.min(line * 12, viewport * 0.4)))}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    window.visualViewport?.addEventListener('resize', fit);
    return (): void => {
      window.removeEventListener('resize', fit);
      window.visualViewport?.removeEventListener('resize', fit);
    };
  }, []);
  return (
    <div
      ref={host}
      hidden={props.hidden}
      className="min-w-0 flex-1 overflow-y-auto text-body text-ink max-narrow:text-title max-narrow:font-normal scrollbar-thin"
    />
  );
};
