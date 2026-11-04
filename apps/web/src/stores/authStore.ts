import { create } from 'zustand';
import type { AuthenticatedStaff, TenantSummary } from '@nayaro/shared';
import { setAuthTokenGetter, setUnauthorizedHandler } from '@/services/apiClient';
import { refreshRealtimeAuth, setRealtimeAuthTokenGetter } from '@/services/socket';
import { readStorage, removeStorage, writeStorage } from '@/lib/storage';

/**
 * The signed-in session.
 *
 * Only the bearer token is persisted, in localStorage, so a page reload keeps
 * the cashier signed in. Holding a token proves nothing on its own: the app
 * starts in `verifying` and asks the server who the token belongs to
 * (GET /auth/me). Staff identity, role and tenant come from that answer, never
 * from storage, so editing localStorage cannot grant a role or a restaurant.
 *
 * localStorage is readable by any script running on this origin, which is why
 * the web app ships a strict Content-Security-Policy, renders all data through
 * React's escaping and stores nothing else that is sensitive.
 */
const TOKEN_KEY = 'nayaro.session';
const WORKSPACE_KEY = 'nayaro.workspace';

export type SessionStatus = 'verifying' | 'authenticated' | 'anonymous';

export interface SupportView {
  readonly adminName: string;
  readonly expiresAt: string;
}

interface AuthState {
  token: string | null;
  status: SessionStatus;
  staff: AuthenticatedStaff | null;
  tenant: TenantSummary | null;
  /** Set while Nayaro support is viewing this account read-only. */
  impersonation: SupportView | null;
  /** Shown on the sign-in screen after the server ended the session. */
  notice: string | null;
  setSession: (token: string, staff: AuthenticatedStaff, tenant: TenantSummary) => void;
  confirmSession: (staff: AuthenticatedStaff, tenant: TenantSummary, impersonation?: SupportView | null) => void;
  clearSession: (notice?: string | null) => void;
  clearNotice: () => void;
}

const storedToken = readStorage(TOKEN_KEY);

export const useAuthStore = create<AuthState>((set) => ({
  token: storedToken,
  status: storedToken === null ? 'anonymous' : 'verifying',
  staff: null,
  tenant: null,
  impersonation: null,
  notice: null,
  setSession: (token, staff, tenant) => {
    writeStorage(TOKEN_KEY, token);
    writeStorage(WORKSPACE_KEY, tenant.workspace);
    set({ token, staff, tenant, impersonation: null, status: 'authenticated', notice: null });
  },
  confirmSession: (staff, tenant, impersonation = null) => {
    set({ staff, tenant, impersonation, status: 'authenticated' });
  },
  clearSession: (notice = null) => {
    removeStorage(TOKEN_KEY);
    set({ token: null, staff: null, tenant: null, impersonation: null, status: 'anonymous', notice });
  },
  clearNotice: () => {
    set({ notice: null });
  },
}));

export function lastWorkspace(): string {
  return readStorage(WORKSPACE_KEY) ?? '';
}

const SESSION_ENDED_NOTICES: Readonly<Record<string, string>> = {
  TENANT_SUSPENDED: 'This restaurant’s account is not active. Contact Nayaro Technology for help.',
  SUBSCRIPTION_EXPIRED: 'This restaurant’s subscription has ended. Contact Nayaro Technology to renew.',
};

/**
 * Joins token ownership (this store) to token transmission (the API client and
 * the socket). Called once from main.tsx, which keeps the Authorization header
 * out of every feature.
 */
export function connectAuthStoreToApiClient(): void {
  setAuthTokenGetter(() => useAuthStore.getState().token);
  setUnauthorizedHandler((code) => {
    const { status, clearSession } = useAuthStore.getState();
    const notice =
      (code !== null ? SESSION_ENDED_NOTICES[code] : undefined) ??
      (status === 'authenticated' ? 'Your session has ended. Please sign in again.' : null);
    clearSession(notice);
  });

  setRealtimeAuthTokenGetter(() => useAuthStore.getState().token);
  useAuthStore.subscribe((state, previous) => {
    if (state.token !== previous.token) refreshRealtimeAuth();
  });

  // Another tab signing out (or in) must not leave this one on a stale token.
  window.addEventListener('storage', (event) => {
    if (event.key !== TOKEN_KEY) return;
    const { token, clearSession } = useAuthStore.getState();
    if (event.newValue === null && token !== null) clearSession();
    else if (event.newValue !== null && event.newValue !== token) window.location.reload();
  });
}

/**
 * Opens a support view in this browser: the console hands over a read-only
 * owner token, stored like any session so the restaurant app loads normally.
 */
export function storeSupportViewToken(token: string, workspace: string): void {
  writeStorage(TOKEN_KEY, token);
  writeStorage(WORKSPACE_KEY, workspace);
}
