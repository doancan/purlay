/**
 * Syntax highlighting, loaded the first time a code block asks for it (D-36, D-98 §4).
 *
 * The initial bundle must hold no grammar: Shiki's core, its regular-expression engine and
 * every language are `import()`ed on use, each language as a chunk of its own, so a channel
 * with no code in it never downloads any of them and a channel with one block of Go downloads
 * Go. The engine is Shiki's JavaScript one (no WebAssembly to ship or to allow under a
 * content security policy, #112).
 *
 * **The colours are not Shiki's.** It is given its `css-variables` theme, which paints a
 * token with `var(--shiki-token-keyword)` and the like; `index.css` maps each of those to a
 * `--syntax-*` token, so highlighting follows the theme (dark, light) with no second palette
 * and no hex in a component (D-97). A language it does not know — or any failure to load —
 * is `null`, and the caller shows the plain text it already shows while this loads, with the
 * same layout, so nothing moves when the colours arrive.
 *
 * The highlighter is an argument (`Highlighter`), so a test of a code block never loads a
 * grammar and a test of this file loads exactly the ones it names.
 */
import type { HighlighterCore, LanguageRegistration, ThemedToken } from 'shiki/core';

/** One run of text in one colour; a line is a list of them. */
export interface HighlightToken {
  readonly content: string;
  /** A CSS value — always a `var(--shiki-…)` — or null for the default ink. */
  readonly color: string | null;
  readonly italic: boolean;
  readonly bold: boolean;
}

/** Tokens by line, or null when this language is not one it highlights. */
export type Highlighter = (
  code: string,
  language: string,
) => Promise<readonly (readonly HighlightToken[])[] | null>;

type Loader = () => Promise<{ readonly default: LanguageRegistration[] }>;

/** Each grammar is a dynamic import, which is what makes it a chunk of its own. */
export const GRAMMARS = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
} as const satisfies Record<string, Loader>;

export type Grammar = keyof typeof GRAMMARS;

/** The names people put after the fence, and the grammar each one means. */
const ALIASES: Readonly<Record<string, Grammar>> = {
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  javascript: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  python: 'python',
  py: 'python',
  go: 'go',
  golang: 'go',
  rust: 'rust',
  rs: 'rust',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
  yaml: 'yaml',
  yml: 'yaml',
  html: 'html',
  css: 'css',
  markdown: 'markdown',
  md: 'markdown',
};

/** The grammar a fence's language names, or null: unknown means plain, never an error. */
export const grammarFor = (language: string): Grammar | null => {
  const key = language.toLowerCase();
  return Object.hasOwn(ALIASES, key) ? (ALIASES[key] ?? null) : null;
};

const FONT_ITALIC = 1;
const FONT_BOLD = 2;

const asToken = (token: ThemedToken): HighlightToken => ({
  content: token.content,
  color: token.color ?? null,
  italic: ((token.fontStyle ?? 0) & FONT_ITALIC) !== 0,
  bold: ((token.fontStyle ?? 0) & FONT_BOLD) !== 0,
});

const THEME = 'css-variables';

let core: Promise<HighlighterCore> | null = null;

/** One highlighter for the page, made on the first request; its theme is the CSS-variable one. */
const highlighterCore = (): Promise<HighlighterCore> => {
  core ??= (async (): Promise<HighlighterCore> => {
    const [shiki, engine] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    return await shiki.createHighlighterCore({
      themes: [shiki.createCssVariablesTheme({ name: THEME, variablePrefix: '--shiki-' })],
      langs: [],
      engine: engine.createJavaScriptRegexEngine(),
    });
  })();
  return core;
};

/**
 * A highlighter over a set of grammars: Shiki, loaded when first needed, and nothing at all
 * when it cannot be. The grammars are an argument so a test can hand it one that fails to
 * load — the case a real network produces and a real test run does not.
 */
export const createHighlighter = (grammars: Readonly<Record<Grammar, Loader>>): Highlighter => {
  // Per highlighter: what *this* set of grammars has already put into the shared core.
  const loaded = new Set<Grammar>();
  return async (code, language) => {
    const grammar = grammarFor(language);
    if (grammar === null) return null;
    try {
      const highlighter = await highlighterCore();
      if (!loaded.has(grammar)) {
        await highlighter.loadLanguage((await grammars[grammar]()).default);
        loaded.add(grammar);
      }
      return highlighter
        .codeToTokensBase(code, { lang: grammar, theme: THEME })
        .map((line) => line.map(asToken));
    } catch {
      // A chunk that did not arrive is a block that stays plain, not a message that fails.
      return null;
    }
  };
};

export const browserHighlighter: Highlighter = createHighlighter(GRAMMARS);
