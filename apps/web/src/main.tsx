/**
 * The client entry point.
 *
 * `apps/web` imports only from `packages/*` — the database never reaches the
 * browser, and lint enforces it (`ARCHITECTURE.md` §4).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './app/app';
import { browserInvitationPorts, captureInvitation } from './features/invitations/pending';

// Before anything routes or asks who is signed in: an invitation's token leaves the address now,
// and waits in the tab through sign-in (D-115).
captureInvitation(window.location, browserInvitationPorts());

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root to mount into');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
