import type {
  CreateAreaRequest,
  CreateTableRequest,
  FloorResponse,
  UpdateAreaRequest,
  UpdateTableRequest,
} from '@nayaro/shared';
import { apiClient } from '@/services/apiClient';

/**
 * Floor endpoints.
 *
 * Note what is NOT sent: restaurantId. The server takes it from the session,
 * and the renderer has no way to name another restaurant even if it wanted to.
 *
 * Every mutation returns the whole floor rather than the row it changed. For a
 * board of a few dozen tables that is a small payload, and it removes an entire
 * class of bug: the client never has to merge a partial result into a cached
 * tree and hope the two agree.
 */
export function fetchFloor(options: { includeInactive?: boolean } = {}): Promise<FloorResponse> {
  const query = options.includeInactive === true ? '?includeInactive=true' : '';
  return apiClient.get<FloorResponse>(`/floor${query}`);
}

export function createArea(request: CreateAreaRequest): Promise<FloorResponse> {
  return apiClient.post<FloorResponse>('/floor/areas', request);
}

export function updateArea(areaId: string, request: UpdateAreaRequest): Promise<FloorResponse> {
  return apiClient.patch<FloorResponse>(`/floor/areas/${areaId}`, request);
}

export function createTable(request: CreateTableRequest): Promise<FloorResponse> {
  return apiClient.post<FloorResponse>('/floor/tables', request);
}

export function updateTable(tableId: string, request: UpdateTableRequest): Promise<FloorResponse> {
  return apiClient.patch<FloorResponse>(`/floor/tables/${tableId}`, request);
}
