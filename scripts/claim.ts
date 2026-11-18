/**
 * Take an issue, so that nobody else starts it and the board shows it in progress.
 *
 *   bun run claim <number>             assign it to you; refused if it is taken or collides
 *   bun run claim <number> --release   give it back
 */
import { assign, currentUser, fetchIssue, fetchIssues, unassign } from './board-github';
import { branchHint, claim, release, type ClaimPorts } from './claim-run';

const number = Number(process.argv.slice(2).find((arg) => /^\d+$/.test(arg)));
if (!Number.isInteger(number) || number <= 0) {
  console.error('usage: bun run claim <issue number> [--release]');
  process.exit(2);
}

const ports: ClaimPorts = {
  me: currentUser(),
  all: () => new Map(fetchIssues().map((issue) => [issue.number, issue])),
  one: fetchIssue,
  assign,
  unassign,
};

if (process.argv.includes('--release')) {
  const result = release(number, ports);
  console.log(result.ok ? `#${String(number)} released` : result.reason);
  process.exit(result.ok ? 0 : 1);
}

const result = claim(number, ports);
if (!result.ok) {
  console.error(`not claimed: ${result.reason}`);
  process.exit(1);
}
for (const notice of result.notices) console.log(`note: ${notice}`);
console.log(`#${String(number)} is yours.`);
console.log(`branch: git switch -c ${branchHint(fetchIssue(number))}`);
console.log(
  `Put "Closes #${String(number)}" in the pull request body: that is what moves it to In review.`,
);
