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

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root to mount into');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
