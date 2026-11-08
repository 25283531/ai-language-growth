export const AUTH_API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? '/api/v1';

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  membershipTier: string;
};

function token(): string {
  return typeof window === 'undefined' ? '' : window.localStorage.getItem('alg_access_token') ?? '';
}

export async function authRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', 'application/json');
  const accessToken = token();
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  const response = await fetch(`${AUTH_API_BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'message' in body ? String(body.message) : `请求失败（${response.status}）`;
    throw new Error(message);
  }
  return body as T;
}

export function saveAuth(result: { accessToken: string }) {
  window.localStorage.setItem('alg_access_token', result.accessToken);
}

export function clearAuth() {
  window.localStorage.removeItem('alg_access_token');
}
