import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthenticatedStaff, LoginResponse, TenantSummary } from '@nayaro/shared';
import { ApiRequestError } from '@/services/apiClient';
import { useAuthStore } from '@/stores/authStore';
import * as authApi from '../api/auth.api';

export interface UseAuth {
  readonly staff: AuthenticatedStaff | null;
  readonly tenant: TenantSummary | null;
  readonly isAuthenticated: boolean;
  readonly isSigningIn: boolean;
  readonly error: string | null;
  /**
   * `identifier` is an email or a username. An email signs in on its own; a
   * username also needs the workspace code.
   */
  signIn: (identifier: string, workspace: string, password: string) => Promise<boolean>;
  /** Stores a session the server has already issued, e.g. at the end of sign-up. */
  completeSignIn: (result: LoginResponse) => void;
  signOut: () => Promise<void>;
  clearError: () => void;
}

/**
 * Sign-in and sign-out. The visible failure is deliberately generic: the
 * server returns one error for an unknown workspace, an unknown user and a
 * wrong password, and the screen does not try to tell them apart.
 */
export function useAuth(): UseAuth {
  const staff = useAuthStore((state) => state.staff);
  const tenant = useAuthStore((state) => state.tenant);
  const status = useAuthStore((state) => state.status);
  const setSession = useAuthStore((state) => state.setSession);
  const clearSession = useAuthStore((state) => state.clearSession);
  const queryClient = useQueryClient();

  const [isSigningIn, setIsSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(
    async (identifier: string, workspace: string, password: string): Promise<boolean> => {
      setIsSigningIn(true);
      setError(null);
      const id = identifier.trim();
      try {
        const result = await authApi.login(
          isEmail(id)
            ? { email: id.toLowerCase(), password, deviceLabel: describeDevice() }
            : {
                workspace: workspace.trim().toLowerCase(),
                username: id,
                password,
                deviceLabel: describeDevice(),
              },
        );
        queryClient.clear();
        setSession(result.token, result.staff, result.tenant);
        return true;
      } catch (cause: unknown) {
        if (cause instanceof ApiRequestError && cause.kind !== 'http') {
          setError('Cannot reach Nayaro RMS. Check your internet connection and try again.');
        } else if (
          cause instanceof ApiRequestError &&
          (cause.code === 'TOO_MANY_ATTEMPTS' ||
            cause.code === 'TENANT_SUSPENDED' ||
            cause.code === 'SUBSCRIPTION_EXPIRED' ||
            cause.code === 'RATE_LIMITED')
        ) {
          setError(cause.message);
        } else {
          setError(
            isEmail(id) ? 'Incorrect email or password.' : 'Incorrect workspace, username or password.',
          );
        }
        return false;
      } finally {
        setIsSigningIn(false);
      }
    },
    [queryClient, setSession],
  );

  const signOut = useCallback(async (): Promise<void> => {
    try {
      await authApi.logout();
    } catch {
      // The server session may already be gone; signing out locally still applies.
    } finally {
      clearSession();
      queryClient.clear();
    }
  }, [clearSession, queryClient]);

  const completeSignIn = useCallback(
    (result: LoginResponse): void => {
      queryClient.clear();
      setSession(result.token, result.staff, result.tenant);
    },
    [queryClient, setSession],
  );

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    staff,
    tenant,
    isAuthenticated: status === 'authenticated',
    isSigningIn,
    error,
    signIn,
    completeSignIn,
    signOut,
    clearError,
  };
}

/** A readable label for the sessions list, e.g. "Chrome on Windows". */
function describeDevice(): string {
  const agent = navigator.userAgent;
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Chrome\//.test(agent)
      ? 'Chrome'
      : /Firefox\//.test(agent)
        ? 'Firefox'
        : /Safari\//.test(agent)
          ? 'Safari'
          : 'Browser';
  const platform = /Android/.test(agent)
    ? 'Android'
    : /iPhone|iPad/.test(agent)
      ? 'iOS'
      : /Windows/.test(agent)
        ? 'Windows'
        : /Mac OS/.test(agent)
          ? 'macOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : 'device';
  return `${browser} on ${platform}`;
}

/** Enough to tell an email from a username, which may not contain "@". */
export function isEmail(value: string): boolean {
  return value.includes('@');
}
