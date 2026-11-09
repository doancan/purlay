/**
 * The setup in the browser (D-179 §4): not under `/api`, since there is no session yet.
 */
import { clientAddress, peerOf } from '../client-address';
import {
  choosePolicyOf,
  claimTheSetup,
  confirmAddress,
  finishTheSetup,
  followAddressLink,
  inviteDone,
  makeAdministrator,
  makeTheFirstWorkspace,
  readSetupState,
  readSetupStatus,
  tryGitHubApp,
  tryMailRelay,
  type SetupDependencies,
} from '../setup';
import { Elysia, type AnyElysia } from 'elysia';
import type { RouteContext } from '../route-context';
import { answerSetup } from '../route-answers';

export const setupRoutes = (context: RouteContext, setup: SetupDependencies): AnyElysia => {
  const { dependencies } = context;

  return new Elysia()
    .get('/setup/status', async () => await readSetupStatus(setup))
    .post('/setup/claim', async ({ body, set }) =>
      answerSetup(set, await claimTheSetup(setup, body)),
    )
    .get('/setup/state', async ({ request, set }) =>
      answerSetup(set, await readSetupState(setup, request)),
    )
    .post('/setup/address', async ({ request, body, set }) =>
      answerSetup(set, await confirmAddress(setup, request, body)),
    )
    .post('/setup/admin', async ({ request, body, set, server }) =>
      answerSetup(
        set,
        await makeAdministrator(
          setup,
          request,
          body,
          clientAddress(peerOf(server, request), request.headers, dependencies.config.TRUST_PROXY),
        ),
      ),
    )
    .post('/setup/policy', async ({ request, body, set }) =>
      answerSetup(set, await choosePolicyOf(setup, request, body)),
    )
    .post('/setup/github', async ({ request, body, set }) =>
      answerSetup(set, await tryGitHubApp(setup, request, body)),
    )
    .post('/setup/smtp', async ({ request, body, set }) =>
      answerSetup(set, await tryMailRelay(setup, request, body)),
    )
    .post('/setup/workspace', async ({ request, body, set }) =>
      answerSetup(set, await makeTheFirstWorkspace(setup, request, body)),
    )
    .post('/setup/invite', async ({ request, set }) =>
      answerSetup(set, await inviteDone(setup, request)),
    )
    .post('/setup/finish', async ({ request, set }) =>
      answerSetup(set, await finishTheSetup(setup, request)),
    )
    .post('/setup/verify', async ({ body }) => await followAddressLink(setup, body));
};
