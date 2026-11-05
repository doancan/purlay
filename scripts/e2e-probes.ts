/**
 * The browser tests' one rule about looking (`CONTRIBUTING.md` §6.3): a question that the page answers for the
 * instant it is asked — `isVisible()`, `isHidden()` — is not a thing to choose a path by. Asked a moment before
 * a toggle is drawn, or a moment after an overlay closed, it answers `false` for a page that is merely not done,
 * and the test takes the other branch on some machines and some runs. A path is chosen by what is known without
 * looking (the window's width), and a state is waited for with `expect(…).toBeVisible()`.
 *
 * Nothing is allowed: a call in a spec or its helpers is a finding, whether in an `if`, a loop or a poll.
 */
const INSTANT_PROBE = /\.\s*(isVisible|isHidden)\s*\(/;

/** The lines of a source text that ask the page an instant question, numbered from 1. */
export const instantProbes = (source: string): number[] =>
  source
    .split('\n')
    .flatMap((line, index) => (INSTANT_PROBE.test(line.replace(/\/\/.*$/, '')) ? [index + 1] : []));
