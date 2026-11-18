/**
 * What to work on next, and who is already working on what: derived, not kept.
 *
 * An issue is in review when an open pull request closes it, in progress when it
 * has an assignee, in the backlog while an issue it is blocked by is open, and
 * ready otherwise. `bun run claim <number>` takes one. The rules are
 * `board-rules.ts`; the GitHub calls are `board-github.ts`.
 *
 *   bun run queue            print the queue
 *   bun run queue --apply    also write Status back to the project board
 */
import { fetchIssues, writeStages } from './board-github';
import { render, stagesFor } from './queue-render';

const issues = fetchIssues();
console.log(render(issues, new Date()));

if (!process.argv.includes('--apply')) {
  console.log('(--apply also writes Status back to the board)');
  process.exit(0);
}
console.log(`board updated: ${String(writeStages(stagesFor(issues)))} items`);
