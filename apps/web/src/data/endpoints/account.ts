// The signed-in person: ways in, passwords and two-step verification, sessions, profile.
import {
  AuthMethods,
  BackupCodes,
  DeviceSessionList,
  EmailSignInPreview,
  MeResponse,
  MySignIn,
  NativeAuthorizeResponse,
  PasswordSignInAnswer,
  Profile,
  TwoFactorEnrolment,
  type EmailSignInRequest,
  type NativeAuthorizeRequest,
  type UpdateProfileRequest,
} from '@purlay/types';
import type { Http } from '../http';
import { at, options } from './request';

export interface AccountApi {
  readonly me: (signal?: AbortSignal) => Promise<MeResponse>;
  /** Which ways in this server offers: GitHub always, email when mail is configured (D-138 §6). */
  readonly authMethods: (signal?: AbortSignal) => Promise<AuthMethods>;
  /** The signed-in person says yes to the native application: the address to send the browser to (D-191). */
  readonly authorizeNative: (input: NativeAuthorizeRequest) => Promise<NativeAuthorizeResponse>;
  /** Asks for a sign-in link; `202` whatever the address (D-138 §1). */
  readonly requestEmailSignIn: (input: EmailSignInRequest) => Promise<void>;
  /** Password sign-in, the library's route; a refusal is a `LibraryFailure`. The session cookie is set. */
  /**
   * The library's password sign-in: `signed-in` with the session cookie set, or `second-step` when the account
   * asks for a code too (D-236) — no session yet, only the challenge's cookie. A refusal is a `LibraryFailure`.
   */
  readonly signInWithPassword: (input: {
    email: string;
    password: string;
  }) => Promise<'signed-in' | 'second-step'>;
  /** The second step of a password sign-in: a code from the app, or a backup code; sets the session (D-236). */
  readonly verifySignInCode: (input: { code: string; kind: 'app' | 'backup' }) => Promise<void>;
  /** Starts turning two-step verification on: the password, then the key and the backup codes (D-236). */
  readonly startTwoFactor: (password: string) => Promise<TwoFactorEnrolment>;
  /** Turns it on with the first right code from the app; the session stays the same (D-236). */
  readonly confirmTwoFactor: (code: string) => Promise<void>;
  /** Turns it off, with the password (D-236). */
  readonly stopTwoFactor: (password: string) => Promise<void>;
  /** New backup codes, with the password; the old ones are spent (D-236). */
  readonly newBackupCodes: (password: string) => Promise<BackupCodes>;
  /** Change the caller's password, ending every other session; a refusal is a `LibraryFailure`. */
  readonly changePassword: (input: {
    currentPassword: string;
    newPassword: string;
  }) => Promise<void>;
  /** The address a link was sent to, without spending it (D-138 §4). */
  readonly previewEmailSignIn: (token: string, signal?: AbortSignal) => Promise<EmailSignInPreview>;
  /** Spends the link; the answer sets the session cookie. */
  readonly consumeEmailSignIn: (token: string, invitation?: string) => Promise<void>;
  /** The ways the caller signs in: their address, and the GitHub account linked to it, if any (D-176, D-179 §5). */
  readonly mySignIn: (signal?: AbortSignal) => Promise<MySignIn>;
  /** Where the caller is signed in, the one used last first (D-193). */
  readonly mySessions: (signal?: AbortSignal) => Promise<DeviceSessionList>;
  /** Ends one of the caller's sessions by its id; one already ended is `SESSION_NOT_FOUND` (D-193 §2). */
  readonly endMySession: (sessionId: string) => Promise<void>;
  readonly signOut: () => Promise<void>;
  /** Ends every session the person holds, this one with them (D-11). */
  readonly signOutEverywhere: () => Promise<void>;
  /** The caller's own title, time zone and status line (D-131). */
  readonly updateProfile: (input: UpdateProfileRequest) => Promise<Profile>;
}

export const createAccountApi = (http: Http): AccountApi => ({
  me: (signal) => http.request('GET', '/api/me', MeResponse, options({}, signal)),
  authMethods: (signal) =>
    http.request('GET', '/api/auth/methods', AuthMethods, options({}, signal)),
  authorizeNative: (input) =>
    http.request(
      'POST',
      '/api/native/authorize',
      NativeAuthorizeResponse,
      options({ body: input }),
    ),
  requestEmailSignIn: (input) => http.send('POST', '/auth/email', options({ body: input })),
  signInWithPassword: async (input) =>
    (await http.libraryRequest('/auth/sign-in/email', PasswordSignInAnswer, input))
      .twoFactorRedirect === true
      ? 'second-step'
      : 'signed-in',
  verifySignInCode: ({ code, kind }) =>
    http.library(
      kind === 'app' ? '/auth/two-factor/verify-totp' : '/auth/two-factor/verify-backup-code',
      { code },
    ),
  startTwoFactor: (password) =>
    http.libraryRequest('/auth/two-factor/enable', TwoFactorEnrolment, { password }),
  confirmTwoFactor: (code) => http.library('/auth/two-factor/verify-totp', { code }),
  stopTwoFactor: (password) => http.library('/auth/two-factor/disable', { password }),
  newBackupCodes: (password) =>
    http.libraryRequest('/auth/two-factor/generate-backup-codes', BackupCodes, { password }),
  changePassword: (input) =>
    http.library('/auth/change-password', { ...input, revokeOtherSessions: true }),
  previewEmailSignIn: (token, signal) =>
    http.request(
      'POST',
      '/auth/email/preview',
      EmailSignInPreview,
      options({ body: { token } }, signal),
    ),
  consumeEmailSignIn: (token, invitation) =>
    http.send(
      'POST',
      '/auth/email/consume',
      options({ body: { token, ...(invitation === undefined ? {} : { invitation }) } }),
    ),
  mySignIn: (signal) => http.request('GET', '/api/me/sign-in', MySignIn, options({}, signal)),
  mySessions: (signal) =>
    http.request('GET', '/api/me/sessions', DeviceSessionList, options({}, signal)),
  endMySession: (sessionId) => http.send('DELETE', `/api/me/sessions/${at(sessionId)}`, options()),
  signOut: () => http.send('POST', '/auth/logout', options()),
  signOutEverywhere: () => http.send('POST', '/auth/logout-all', options()),
  updateProfile: (input) =>
    http.request('PATCH', '/api/me/profile', Profile, options({ body: input })),
});
