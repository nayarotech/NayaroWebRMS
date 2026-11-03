import type {
  LoginRequest,
  LoginResponse,
  MeResponse,
  PendingRegistrationResponse,
  RegisterTenantRequest,
  VerifyRegistrationRequest,
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

/** Sign-up step 1: validates the form and emails a 6-digit code. */
export function startRegistration(request: RegisterTenantRequest): Promise<PendingRegistrationResponse> {
  return apiClient.post<PendingRegistrationResponse>('/tenants/register/start', request);
}

export function resendRegistrationCode(email: string): Promise<PendingRegistrationResponse> {
  return apiClient.post<PendingRegistrationResponse>('/tenants/register/resend', { email });
}

/** Sign-up step 2: the code creates the restaurant and signs the owner in. */
export function verifyRegistration(request: VerifyRegistrationRequest): Promise<LoginResponse> {
  return apiClient.post<LoginResponse>('/tenants/register/verify', request);
}

export function lookupWorkspace(workspace: string): Promise<WorkspaceLookupResponse> {
  return apiClient.get<WorkspaceLookupResponse>(
    `/tenants/lookup?workspace=${encodeURIComponent(workspace)}`,
  );
}
