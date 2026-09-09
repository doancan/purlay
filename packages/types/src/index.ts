/**
 * `@purlay/types` — the contract.
 *
 * Models, WebSocket frames and HTTP request/response shapes are defined here and
 * nowhere else. A shape defined in two places will diverge, so an app never
 * declares its own. (ARCHITECTURE.md §1, CONTRIBUTING.md §1.4)
 */
export type {
  AppErrorBody,
  ErrorCode,
  ErrorResponse,
  HttpStatus,
  ValidationDetails,
} from './errors';
export { ERROR_STATUS, statusFor } from './errors';
