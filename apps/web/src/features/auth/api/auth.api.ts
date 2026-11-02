import type {
  LoginRequest,
  LoginResponse,
  MeResponse,
  RegisterTenantRequest,
  RegisterTenantResponse,
  WorkspaceLookupResponse,
} from '@nayaro/shared';
import { apiClient } from '@/services/apiClient';

export function login(request: LoginRequest): Promise<LoginResponse> {
  return apiClient.post<LoginResponse>('/auth/login', request);
}

export function fetchCurrentSession(): Promise<MeResponse> {
  return apiClient.get<MeResponse>('/auth/me');
}

export function logout(): Promise<void> {
  return apiClient.post<void>('/auth/logout');
}

export function registerTenant(request: RegisterTenantRequest): Promise<RegisterTenantResponse> {
  return apiClient.post<RegisterTenantResponse>('/tenants/register', request);
}

export function lookupWorkspace(workspace: string): Promise<WorkspaceLookupResponse> {
  return apiClient.get<WorkspaceLookupResponse>(
    `/tenants/lookup?workspace=${encodeURIComponent(workspace)}`,
  );
}
