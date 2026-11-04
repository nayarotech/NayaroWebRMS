import { create } from 'zustand';
import type {
  PlatformActivityResponse,
  PlatformAdminDto,
  PlatformImpersonationResponse,
  PlatformLoginResponse,
  PlatformOverview,
  PlatformPendingSignup,
  PlatformTenantAction,
  PlatformTenantDetail,
  PlatformTenantsResponse,
} from '@nayaro/shared';
import { API_BASE_URL } from '@/config/env';
import { ApiRequestError } from '@/services/apiClient';
import { readStorage, removeStorage, writeStorage } from '@/lib/storage';

/**
 * The Nayaro console's own session, separate from any restaurant session in
 * the same browser: its own token, its own storage key, its own client. A
 * console 401 signs out of the console only.
 */
const TOKEN_KEY = 'nayaro.platform.session';

interface PlatformState {
  token: string | null;
  admin: PlatformAdminDto | null;
  setSession: (token: string, admin: PlatformAdminDto) => void;
  setAdmin: (admin: PlatformAdminDto) => void;
  clear: () => void;
}

export const usePlatformStore = create<PlatformState>((set) => ({
  token: readStorage(TOKEN_KEY),
  admin: null,
  setSession: (token, admin) => {
    writeStorage(TOKEN_KEY, token);
    set({ token, admin });
  },
  setAdmin: (admin) => {
    set({ admin });
  },
  clear: () => {
    removeStorage(TOKEN_KEY);
    set({ token: null, admin: null });
  },
}));

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const token = usePlatformStore.getState().token;
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause: unknown) {
    throw new ApiRequestError('network', 'Could not reach Nayaro RMS. Check your connection.', { cause });
  }
  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
    if (response.status === 401 && token !== null) usePlatformStore.getState().clear();
    throw new ApiRequestError('http', error?.message ?? 'Request failed.', {
      status: response.status,
      ...(error?.code === undefined ? {} : { code: error.code }),
    });
  }
  return parsed as T;
}

export const platformApi = {
  login: (email: string, password: string) =>
    request<PlatformLoginResponse>('POST', '/platform/auth/login', { email, password }),
  me: () => request<{ admin: PlatformAdminDto }>('GET', '/platform/auth/me'),
  logout: () => request<void>('POST', '/platform/auth/logout'),
  overview: () => request<PlatformOverview>('GET', '/platform/overview'),
  tenants: () => request<PlatformTenantsResponse>('GET', '/platform/tenants'),
  tenant: (id: string) => request<PlatformTenantDetail>('GET', `/platform/tenants/${encodeURIComponent(id)}`),
  act: (id: string, action: PlatformTenantAction) =>
    request<PlatformTenantDetail>('POST', `/platform/tenants/${encodeURIComponent(id)}/actions`, action),
  supportView: (id: string) =>
    request<PlatformImpersonationResponse>('POST', `/platform/tenants/${encodeURIComponent(id)}/support-view`),
  signups: () => request<{ signups: PlatformPendingSignup[] }>('GET', '/platform/signups'),
  activity: (before?: string) =>
    request<PlatformActivityResponse>(
      'GET',
      `/platform/activity${before === undefined ? '' : `?before=${encodeURIComponent(before)}`}`,
    ),
};
