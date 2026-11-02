/**
 * The renderer reuses the wire contracts from @nayaro/shared rather than
 * redeclaring them, so a change to the API breaks the build here instead of
 * failing silently at runtime.
 */
export type {
  AuthenticatedStaff,
  LoginRequest,
  LoginResponse,
  MeResponse,
  StaffRole,
} from '@nayaro/shared';
