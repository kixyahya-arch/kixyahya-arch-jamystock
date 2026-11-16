/** Client HTTP de l'API JAMYSTOCK pour l'Espace Client, avec renouvellement transparent du jeton d'accès (15 min). */
const BASE = '/api/v1';

export interface Session {
  accessToken: string;
  refreshToken: string;
  user?: { id: string; nom: string; role: string; email: string; entrepriseId?: string | null };
}

const KEY = 'jamystock.client.session';

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function saveSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* stockage indisponible : la session reste en mémoire */
  }
  current = s;
  for (const l of sessionListeners) l(s);
}

const sessionListeners = new Set<(s: Session | null) => void>();
/** Prévient l'appli quand la session change (connexion, expiration du renouvellement, déconnexion). */
export function onSessionChange(l: (s: Session | null) => void): () => void {
  sessionListeners.add(l);
  return () => sessionListeners.delete(l);
}

let current: Session | null = loadSession();
export const getSession = () => current;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Erreur réseau (hors-ligne, timeout) : l'action reste en file. */
export class NetworkError extends Error {}

async function raw(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  try {
    return await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...(init.body && !(init.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
    });
  } catch (e) {
    throw new NetworkError((e as Error).message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'HTTP', body?.error?.message ?? `Erreur ${res.status}`);
  return body as T;
}

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  if (!current) return false;
  refreshing ??= (async () => {
    try {
      const res = await raw('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: current!.refreshToken }) });
      if (!res.ok) {
        if (res.status === 401) saveSession(null);
        return false;
      }
      const t = (await res.json()) as Session;
      saveSession({ ...current!, accessToken: t.accessToken, refreshToken: t.refreshToken });
      return true;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await raw(path, init, current?.accessToken);
  if (res.status === 401 && (await refresh())) res = await raw(path, init, current?.accessToken);
  return parse<T>(res);
}

export async function login(email: string, password: string, mfaCode?: string): Promise<Session> {
  const res = await raw('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, mfaCode, deviceId: deviceId() }) });
  const t = await parse<Session>(res);
  saveSession(t);
  const me = await api<Session['user']>('/auth/me');
  const s = { ...t, user: me };
  saveSession(s);
  return s;
}

export async function logout(): Promise<void> {
  const s = current;
  saveSession(null);
  if (s) await raw('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: s.refreshToken }) }).catch(() => undefined);
}

/** Identifiant de l'appareil (§7.3 : sessions révocables par appareil). */
export function deviceId(): string {
  try {
    let id = localStorage.getItem('jamystock.client.device');
    if (!id) {
      id = `web-${crypto.randomUUID()}`;
      localStorage.setItem('jamystock.client.device', id);
    }
    return id;
  } catch {
    return 'web-ephemere';
  }
}

/** Raccourcis JSON */
export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });
