/** Client HTTP de l'API JAMYSTOCK pour l'Espace Client, avec renouvellement transparent du jeton d'accès (15 min). */
const BASE = '/api/v1';

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** CLI-02 : session ouverte par le support JAMYSTOCK, en lecture seule, limitée à cet onglet. */
  support?: boolean;
  user?: { id: string; nom: string; role: string; email: string; entrepriseId?: string | null; entrepriseNom?: string | null; support?: { par: string | null; expireLe: string } | null };
}

const KEY = 'jamystock.client.session';
const SUPPORT_KEY = 'jamystock.client.support';

export function loadSession(): Session | null {
  try {
    const support = sessionStorage.getItem(SUPPORT_KEY);
    if (support) return JSON.parse(support) as Session;
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function saveSession(s: Session | null) {
  try {
    // la session de support vit dans l'onglet seulement : elle ne remplace jamais celle du client sur cet appareil
    if (s?.support) sessionStorage.setItem(SUPPORT_KEY, JSON.stringify(s));
    else if (current?.support) sessionStorage.removeItem(SUPPORT_KEY);
    else if (s) localStorage.setItem(KEY, JSON.stringify(s));
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
  if (current.support) {
    // pas de renouvellement en mode support : la session s'arrête à l'expiration du jeton (30 min)
    saveSession(null);
    return false;
  }
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

/** ADM-03 : activation d'un compte invité ; ouvre directement la session. */
export async function acceptInvitation(token: string, password: string): Promise<Session> {
  const res = await raw('/auth/invitation/accept', { method: 'POST', body: JSON.stringify({ token, password, deviceId: deviceId() }) });
  const t = await parse<Session>(res);
  saveSession(t);
  const me = await api<Session['user']>('/auth/me');
  const s = { ...t, user: me };
  saveSession(s);
  return s;
}

/** Lecture sans session (page d'invitation). */
export async function publicGet<T>(path: string): Promise<T> {
  return parse<T>(await raw(path));
}

/** CLI-02 : ouvre la session de support reçue du Back-Office (jeton court, lecture seule). */
export async function startSupport(token: string): Promise<Session> {
  saveSession({ accessToken: token, refreshToken: '', support: true });
  try {
    const me = await api<Session['user']>('/auth/me');
    if (!me?.support) throw new ApiError(401, 'UNAUTHORIZED', 'Lien de support invalide');
    const s: Session = { accessToken: token, refreshToken: '', support: true, user: me };
    saveSession(s);
    return s;
  } catch (e) {
    if (current?.support) saveSession(null);
    throw e;
  }
}

export async function logout(): Promise<void> {
  const s = current;
  saveSession(null);
  if (s?.support) return;
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
export const put = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

/** Fichier binaire (PDF, ZIP) avec la session. */
export async function apiBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  let res = await raw(path, init, current?.accessToken);
  if (res.status === 401 && (await refresh())) res = await raw(path, init, current?.accessToken);
  if (!res.ok) await parse(res);
  return res.blob();
}

/** Enregistre un fichier sur l'appareil (lien de téléchargement temporaire). */
export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * SUI-01 : écoute un flux d'évènements (SSE) de l'API. `fetch` plutôt qu'EventSource, pour envoyer le jeton
 * dans l'en-tête et jamais dans l'adresse. Se reconnecte seul (le serveur ferme le flux toutes les 10 min,
 * le réseau peut tomber) ; renvoie de quoi arrêter l'écoute.
 */
export function listen(path: string, onEvent: (data: unknown) => void): () => void {
  let stopped = false;
  let ctrl: AbortController | null = null;
  const run = async () => {
    while (!stopped) {
      ctrl = new AbortController();
      try {
        let res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${current?.accessToken ?? ''}` }, signal: ctrl.signal });
        if (res.status === 401 && (await refresh())) {
          res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${current?.accessToken ?? ''}` }, signal: ctrl.signal });
        }
        if (!res.ok || !res.body) throw new Error(String(res.status));
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = block.split('\n').find((l) => l.startsWith('data: '));
            if (data) {
              try {
                onEvent(JSON.parse(data.slice(6)));
              } catch {
                /* évènement illisible : ignoré */
              }
            }
          }
        }
      } catch {
        /* coupure : on retente plus bas */
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 5000));
    }
  };
  void run();
  return () => {
    stopped = true;
    ctrl?.abort();
  };
}
