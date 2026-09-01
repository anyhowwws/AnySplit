import type {
  ApiError,
  Bill,
  FinaliseRequest,
  FinaliseResponse,
  GetBillResponse,
  PatchBillRequest,
} from '../../../shared/types.ts';
import { webApp } from './telegram.ts';

/**
 * API Gateway base URL, injected at build time from the Terraform output.
 * Empty string means same-origin, which is only true in local dev with a proxy.
 */
const API_BASE: string = import.meta.env['VITE_API_BASE'] ?? '';

export class ApiRequestError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const initData = webApp?.initData ?? '';

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        // Every authenticated request carries initData; the backend verifies the
        // HMAC and takes the user id from there, never from the body.
        authorization: `tma ${initData}`,
        ...init?.headers,
      },
    });
  } catch {
    // fetch only rejects for transport-level failures — no connection, DNS, or a
    // blocked CORS preflight. There is no status to report, and letting this
    // bubble up untyped previously surfaced as "Could not load this bill",
    // which points at the wrong thing entirely.
    throw new ApiRequestError("Couldn't reach the server. Check your connection and try again.");
  }

  if (!response.ok) {
    let message = `request failed (${response.status})`;
    try {
      const body = (await response.json()) as ApiError;
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body; keep the status-based message.
    }
    if (response.status === 401) message = 'Telegram could not verify this session. Reopen the app.';
    if (response.status === 404) message = 'This bill no longer exists. It may have expired.';
    throw new ApiRequestError(message);
  }

  try {
    return (await response.json()) as T;
  } catch {
    // A 200 that isn't JSON usually means the request never reached the API and
    // CloudFront served index.html instead — its SPA rewrite turns any unknown
    // path into a 200 HTML page.
    throw new ApiRequestError('The server sent an unexpected response.');
  }
}

export function fetchBill(billId: string): Promise<GetBillResponse> {
  return request<GetBillResponse>(`/api/bills/${encodeURIComponent(billId)}`);
}

export function patchBill(billId: string, body: PatchBillRequest): Promise<{ bill: Bill }> {
  return request<{ bill: Bill }>(`/api/bills/${encodeURIComponent(billId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function finaliseBill(billId: string, body: FinaliseRequest): Promise<FinaliseResponse> {
  return request<FinaliseResponse>(`/api/bills/${encodeURIComponent(billId)}/finalise`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
