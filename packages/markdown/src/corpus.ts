/**
 * The inputs of the conformance corpus (D-192, `docs/DECISIONS.md`).
 *
 * `readMarkdown` is the definition of what a message means (D-101), and the macOS application reads with a
 * different parser. A client is right to the extent it produces the same narrowed tree, so the contract bundle
 * carries these inputs with the tree this engine produces for each, and the client's own tests run them. The
 * expected trees are never written here: they are what the engine says, so the definition stays one thing.
 *
 * What each case is for is in its name (`group/what`). The bounds are built from the bounds themselves, so a
 * change to a limit moves the case with it. `corpus.test.ts` holds the corpus to being worth running: it
 * reaches every kind of node, every bound on both sides, and both sides of the rule about addresses.
 */
import { MARKDOWN_DEPTH_MAX } from './parse';
import { MARKDOWN_DELIMITERS_MAX, MARKDOWN_NESTING_MAX, MARKDOWN_RUN_MAX } from './scan';
import { SafeHref } from './href';
import type { Reading } from './parse';

export interface CorpusCase {
  /** `group/what`. */
  readonly name: string;
  readonly input: string;
}

const OUTLINE_LEVELS = (levels: number): string =>
  Array.from({ length: levels }, (_, level) => `${'  '.repeat(level)}- a`).join('\n');

export const CORPUS: readonly CorpusCase[] = [
  { name: 'paragraph/plain', input: 'Hello, world' },
  { name: 'paragraph/two-lines', input: 'line one\nline two' },
  { name: 'paragraph/blank-line-separates', input: 'one\n\ntwo' },
  { name: 'paragraph/hard-break-spaces', input: 'one  \ntwo' },
  { name: 'paragraph/hard-break-backslash', input: 'one\\\ntwo' },
  { name: 'paragraph/crlf', input: 'one\r\n\r\ntwo' },
  { name: 'paragraph/cr-only', input: 'one\rtwo' },
  { name: 'paragraph/tabs', input: 'a\tb' },
  { name: 'paragraph/leading-spaces', input: '   indented three' },
  { name: 'paragraph/trailing-spaces', input: 'end   ' },
  { name: 'paragraph/unicode-turkish', input: "İstanbul'da ışık ışıl ışıl, ĞÜŞİÖÇ ğüşıöç" },
  { name: 'paragraph/rtl', input: 'مرحبا بالعالم שלום עולם' },
  { name: 'paragraph/emoji', input: '👍 ok 🎉 family 👨\u200d👩\u200d👧\u200d👦 flag 🇹🇷' },
  { name: 'paragraph/combining', input: 'e\u0301 (combining acute) cafe\u0301' },
  { name: 'paragraph/zero-width', input: 'a\u200bb\u200dc' },
  { name: 'paragraph/escapes', input: '\\*not emphasis\\* and \\_x\\_ and \\# no heading' },
  { name: 'paragraph/entities', input: '&amp; &lt;b&gt; &copy; &#35; &#x1F600;' },
  { name: 'paragraph/html-inline-dropped', input: 'text <b>bold</b> and <span class="x">y</span>' },
  { name: 'paragraph/html-block-dropped', input: '<div>block</div>\n\nafter' },
  { name: 'paragraph/html-comment', input: 'a <!-- hidden --> b' },
  { name: 'paragraph/image-dropped', input: '![alt](https://example.com/a.png) after' },
  { name: 'paragraph/image-reference', input: '![alt][ref]\n\n[ref]: https://example.com/a.png' },
  { name: 'paragraph/reference-definition-not-parsed', input: '[a]: https://example.com\n\ntext' },
  { name: 'paragraph/footnote-not-parsed', input: 'text[^1]\n\n[^1]: note' },
  { name: 'paragraph/mention-text', input: 'ping @ada and @bob-2, not @ here' },
  {
    name: 'paragraph/long-word',
    input:
      'xyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
  },
  { name: 'paragraph/quotes-and-dashes', input: '"quoted" -- and --- and ... \'single\'' },
  { name: 'emphasis/asterisk', input: '*em*' },
  { name: 'emphasis/underscore', input: '_em_' },
  { name: 'strong/asterisk', input: '**strong**' },
  { name: 'strong/underscore', input: '__strong__' },
  { name: 'strong-emphasis/triple', input: '***both***' },
  { name: 'emphasis/nested', input: '*a **b** c*' },
  { name: 'emphasis/intraword-underscore', input: 'snake_case_word and 2*3*4' },
  { name: 'emphasis/intraword-asterisk', input: 'un*frigging*believable' },
  { name: 'emphasis/unclosed', input: '*open' },
  { name: 'emphasis/rule-of-three', input: '***foo** bar*' },
  { name: 'emphasis/whitespace-flanking', input: 'a * b * c' },
  { name: 'emphasis/punctuation-flanking', input: '*(a)* and **"b"**' },
  { name: 'emphasis/across-lines', input: '*a\nb*' },
  { name: 'strike/double', input: '~~gone~~' },
  { name: 'strike/single-tilde', input: '~gone~' },
  { name: 'strike/triple-tilde-inline', input: 'a ~~~b~~~ c' },
  { name: 'strike/nested-in-strong', input: '**~~both~~**' },
  { name: 'strike/unclosed', input: '~~open' },
  { name: 'inline-code/simple', input: '`code`' },
  { name: 'inline-code/double-backtick', input: '``a ` b``' },
  { name: 'inline-code/padding', input: '` `` `' },
  { name: 'inline-code/with-emphasis-chars', input: '`*not* _em_`' },
  { name: 'inline-code/unclosed', input: '`open' },
  { name: 'inline-code/newline', input: '`a\nb`' },
  { name: 'inline-code/empty-run', input: 'a `` b' },
  { name: 'code/fence-lang', input: '```ts\nconst x = 1;\n```' },
  { name: 'code/fence-no-lang', input: '```\nplain\n```' },
  { name: 'code/fence-info-words', input: '```js title="x" highlight\nlet a\n```' },
  { name: 'code/fence-tilde', input: '~~~py\nprint(1)\n~~~' },
  { name: 'code/fence-unclosed', input: '```\nnever closed\n more' },
  { name: 'code/fence-longer-close', input: '````\n```\ninside\n```\n````' },
  { name: 'code/fence-in-list', input: '- item\n\n  ```\n  code\n  ```' },
  { name: 'code/fence-in-quote', input: '> ```\n> q\n> ```' },
  { name: 'code/indented-not-code', input: '    four spaces' },
  { name: 'code/fence-empty', input: '```\n```' },
  { name: 'code/fence-info-with-spaces', input: '```  rust  \nfn x(){}\n```' },
  { name: 'code/fence-backtick-in-info', input: '```a`b\nx\n```' },
  { name: 'code/fence-blank-lines', input: '```\na\n\n\nb\n```' },
  { name: 'code/fence-crlf', input: '```ts\r\nx\r\n```' },
  { name: 'code/diff', input: '```diff\n- old\n+ new\n```' },
  { name: 'code/fence-then-text', input: '```sh\nls\n```\nafter the fence' },
  {
    name: 'code/fence-with-markup-inside',
    input: '```\n**bold** [l](https://example.com) <b>\n```',
  },
  { name: 'code/fence-uppercase-lang', input: '```TypeScript\nx\n```' },
  { name: 'code/fence-indented-three', input: '   ```\n   x\n   ```' },
  { name: 'heading/atx-1', input: '# level 1' },
  { name: 'heading/atx-2', input: '## level 2' },
  { name: 'heading/atx-3', input: '### level 3' },
  { name: 'heading/atx-4', input: '#### level 4' },
  { name: 'heading/atx-5', input: '##### level 5' },
  { name: 'heading/atx-6', input: '###### level 6' },
  { name: 'heading/seven-hashes-not', input: '####### no' },
  { name: 'heading/setext-1', input: 'Title\n=====' },
  { name: 'heading/setext-2', input: 'Sub\n---' },
  { name: 'heading/atx-closing', input: '## closed ##' },
  { name: 'heading/emphasis-in', input: '# a *b*' },
  { name: 'heading/no-space-not', input: '#nospace' },
  { name: 'heading/after-paragraph', input: 'text\n# heading' },
  { name: 'rule/dashes', input: 'a\n\n---\n\nb' },
  { name: 'rule/asterisks', input: '***' },
  { name: 'rule/underscores', input: '___' },
  { name: 'rule/spaced', input: '- - -' },
  { name: 'quote/simple', input: '> quoted' },
  { name: 'quote/multi', input: '> a\n> b' },
  { name: 'quote/lazy', input: '> a\nlazy' },
  { name: 'quote/nested', input: '> a\n>> b\n>>> c' },
  { name: 'quote/with-list', input: '> - x\n> - y' },
  { name: 'quote/with-code', input: '> ```\n> code\n> ```' },
  { name: 'quote/empty', input: '>' },
  { name: 'quote/two-quotes', input: '> a\n\n> b' },
  { name: 'list/bullet-dash', input: '- a\n- b' },
  { name: 'list/bullet-star', input: '* a\n* b' },
  { name: 'list/bullet-plus', input: '+ a\n+ b' },
  { name: 'list/ordered', input: '1. a\n2. b' },
  { name: 'list/ordered-start', input: '3. x\n4. y' },
  { name: 'list/ordered-paren', input: '1) a\n2) b' },
  { name: 'list/ordered-zero', input: '0. a' },
  { name: 'list/ordered-all-ones', input: '1. a\n1. b\n1. c' },
  { name: 'list/loose', input: '- a\n\n- b' },
  { name: 'list/nested', input: '- a\n  - b\n    - c' },
  { name: 'list/mixed-nested', input: '1. a\n   - b' },
  { name: 'list/task', input: '- [ ] todo\n- [x] done\n- [X] done2' },
  { name: 'list/task-ordered', input: '1. [ ] a' },
  { name: 'list/task-not', input: '- [] nope\n- [ x] nope' },
  { name: 'list/item-with-paragraphs', input: '- a\n\n  b' },
  { name: 'list/change-marker-new-list', input: '- a\n+ b' },
  { name: 'list/interrupt-paragraph', input: 'text\n- a' },
  { name: 'list/ordered-interrupt-only-one', input: 'text\n2. a' },
  { name: 'list/empty-item', input: '-\n- b' },
  { name: 'list/nine-digits', input: '123456789. x' },
  { name: 'list/ten-digits-not', input: '1234567890. x' },
  { name: 'list/emphasis-in-item', input: '- *a* and `b`' },
  { name: 'list/item-with-quote', input: '- a\n  > q' },
  { name: 'list/dash-without-space-not', input: '-a' },
  { name: 'list/starts-after-blank', input: 'a\n\n- b' },
  { name: 'table/simple', input: '| a | b |\n|---|---|\n| 1 | 2 |' },
  { name: 'table/aligned', input: '| l | c | r | n |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |' },
  { name: 'table/no-outer-pipes', input: 'a | b\n--|--\n1 | 2' },
  { name: 'table/escaped-pipe', input: '| a | b |\n|---|---|\n| x \\| y | 2 |' },
  { name: 'table/pipe-in-code', input: '| a |\n|---|\n| `x|y` |' },
  { name: 'table/ragged-short', input: '| a | b |\n|---|---|\n| 1 |' },
  { name: 'table/ragged-long', input: '| a |\n|---|\n| 1 | 2 |' },
  {
    name: 'table/inline-formatting',
    input: '| *a* | **b** |\n|---|---|\n| [l](https://example.com) | `c` |',
  },
  { name: 'table/header-only', input: '| a | b |\n|---|---|' },
  { name: 'table/delimiter-mismatch-not-table', input: '| a | b |\n|---|\n| 1 | 2 |' },
  { name: 'table/interrupts-paragraph', input: 'para\n| a |\n|---|\n| 1 |' },
  { name: 'table/empty-cells', input: '| | |\n|---|---|\n| | x |' },
  { name: 'table/in-quote', input: '> | a |\n> |---|\n> | 1 |' },
  { name: 'table/wide-delimiters', input: '| a |\n|-----------|\n| 1 |' },
  { name: 'link/inline-https', input: '[t](https://example.com/a?b=1#c)' },
  { name: 'link/inline-http', input: '[t](http://example.com)' },
  { name: 'link/mailto', input: '[m](mailto:a@example.com)' },
  { name: 'link/title', input: '[t](https://example.com "title")' },
  { name: 'link/angle', input: '<https://example.com>' },
  { name: 'link/angle-email', input: '<a@example.com>' },
  { name: 'link/autolink-literal-www', input: 'see www.example.com now' },
  { name: 'link/autolink-literal-https', input: 'https://example.com/x, then' },
  { name: 'link/autolink-literal-email', input: 'mail a@example.com.' },
  { name: 'link/autolink-trailing-punctuation', input: '(https://example.com/a).' },
  { name: 'link/autolink-in-code', input: '`https://example.com`' },
  { name: 'link/autolink-underscores', input: 'https://example.com/a_b_c' },
  { name: 'link/javascript', input: '[x](javascript:alert(1))' },
  { name: 'link/data', input: '[x](data:text/html,<b>)' },
  { name: 'link/vbscript', input: '[x](vbscript:msgbox)' },
  { name: 'link/file', input: '[x](file:///etc/passwd)' },
  { name: 'link/ftp', input: '[x](ftp://example.com)' },
  { name: 'link/relative-path', input: '[x](/path)' },
  { name: 'link/relative-up', input: '[x](../up)' },
  { name: 'link/fragment', input: '[x](#frag)' },
  { name: 'link/protocol-relative', input: '[x](//evil.test)' },
  { name: 'link/tel', input: '[x](tel:+900000)' },
  { name: 'link/uppercase-scheme', input: '[x](HTTPS://EXAMPLE.COM)' },
  { name: 'link/mixed-case-javascript', input: '[x](JaVaScRiPt:alert(1))' },
  { name: 'link/entity-obfuscated', input: '[x](&#106;avascript:alert(1))' },
  { name: 'link/label-emphasis', input: '[*a* **b**](https://example.com)' },
  { name: 'link/reference-not-parsed', input: '[t][r]\n\n[r]: https://example.com' },
  { name: 'link/nested-brackets', input: '[a [b] c](https://example.com)' },
  { name: 'link/space-in-destination', input: '[x](https://example.com/a b)' },
  { name: 'link/idn-host', input: '[x](https://İstanbul.example)' },
  { name: 'link/default-port', input: '[x](https://example.com:443/)' },
  { name: 'link/uppercase-host-and-path', input: '[x](https://EXAMPLE.com/A/B)' },
  { name: 'link/empty-label', input: '[](https://example.com)' },
  { name: 'link/userinfo', input: '[x](https://user:pass@example.com/)' },
  { name: 'link/localhost', input: '[x](http://localhost:3000/a)' },
  {
    name: 'mixed/code-with-underscores',
    input: '```py\nfoo_bar_baz = __init__\n```\nand __bold__',
  },
  {
    name: 'mixed/stack-trace',
    input: 'Error: x\n    at foo (file.js:1:2)\n    at bar (file.js:3:4)',
  },
  { name: 'mixed/every-inline', input: 'a *b* **c** ~~d~~ `e` [f](https://example.com) g  \nh' },
  { name: 'mixed/quote-list-code', input: '> 1. step\n>    ```sh\n>    make\n>    ```' },
  {
    name: 'mixed/message-with-mention-and-link',
    input: '@ada the deploy is **green**: https://example.com/runs/42',
  },
  { name: 'edge/empty', input: '' },
  { name: 'edge/spaces-only', input: '   ' },
  { name: 'edge/newlines-only', input: '\n\n' },
  { name: 'edge/single-char', input: 'x' },
  { name: 'edge/null-byte', input: 'a\u0000b' },
  { name: 'edge/bom', input: '\ufeffhello' },
  { name: 'edge/line-separator', input: 'a\u2028b' },
  // The bounds, built from the bounds: just inside is formatted, just past is shown as typed.
  { name: 'bounds/nesting-at-limit', input: `${'> '.repeat(MARKDOWN_NESTING_MAX)}x` },
  { name: 'bounds/nesting', input: `${'> '.repeat(MARKDOWN_NESTING_MAX + 1)}x` },
  { name: 'bounds/delimiters', input: '*a'.repeat(MARKDOWN_DELIMITERS_MAX + 1) },
  {
    name: 'bounds/delimiters-in-code',
    input: `\`\`\`\n${'*a'.repeat(MARKDOWN_DELIMITERS_MAX + 1)}\n\`\`\``,
  },
  { name: 'bounds/run-at-limit', input: 'a'.repeat(MARKDOWN_RUN_MAX) },
  { name: 'bounds/run', input: 'a'.repeat(MARKDOWN_RUN_MAX + 1) },
  {
    name: 'bounds/depth-just-under',
    input: OUTLINE_LEVELS(Math.floor(MARKDOWN_DEPTH_MAX / 2) - 2),
  },
  { name: 'bounds/depth', input: OUTLINE_LEVELS(MARKDOWN_DEPTH_MAX) },
];

/**
 * A reading as a client reads it from the bundle: the tree with each safe address as the string the browser
 * would read (`SafeHref.href`, the WHATWG URL's own spelling — a client compares addresses by their parts or
 * normalises as that does, not by the characters typed), or `null` and the reason it was shown as typed. The
 * engine's own error, which only a defect carries, is never part of it.
 */
export const serialiseReading = (reading: Reading | undefined): unknown => {
  if (reading === undefined) return { tree: null, reason: 'unread' };
  if (reading.tree === null) return { tree: null, reason: reading.reason };
  const plain = (value: unknown): unknown => {
    if (value instanceof SafeHref) return value.href;
    if (Array.isArray(value)) return value.map(plain);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plain(inner)]));
    }
    return value;
  };
  return { tree: plain(reading.tree) };
};
