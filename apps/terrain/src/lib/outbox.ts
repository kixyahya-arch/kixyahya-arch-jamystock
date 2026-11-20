import { uuidv7, type FieldAction, type SyncResult } from '@jamystock/domain/browser';
import { db, type OutboxItem } from './db';
import { api, ApiError, deviceId, NetworkError } from './api';

/**
 * File d'envoi ordonnée (§7.5). Chaque geste est écrit localement d'abord, puis envoyé dès qu'un réseau
 * est disponible. Les envois sont idempotents (clé par action) : un double envoi ne crée pas de doublon.
 * Les photos partent après les données, BL et réserves d'abord.
 */
type Listener = (s: OutboxState) => void;
export interface OutboxState {
  pending: number;
  photos: number;
  rejected: number;
  syncing: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
}

const state: OutboxState = { pending: 0, photos: 0, rejected: 0, syncing: false, lastSyncAt: null, lastError: null };
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l({ ...state }));

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  l({ ...state });
  return () => listeners.delete(l);
}

export async function refreshCounts(): Promise<OutboxState> {
  const d = await db();
  state.pending = await d.count('outbox');
  state.photos = await d.count('photos');
  state.rejected = await d.count('rejected');
  emit();
  return { ...state };
}

/** Enregistre une action localement ; renvoie sa clé. L'envoi est tenté aussitôt si le réseau est là. */
export async function enqueue(action: FieldAction, at: Date = new Date()): Promise<string> {
  const key = uuidv7();
  const item = { key, at: at.toISOString(), action, attempts: 0 } as Omit<OutboxItem, 'seq'>;
  await (await db()).add('outbox', item as OutboxItem);
  await refreshCounts();
  void flush();
  return key;
}

export async function enqueuePhoto(photoId: string, blob: Blob, priority = 1): Promise<void> {
  await (await db()).put('photos', { photoId, blob, priority, createdAt: Date.now() });
  await refreshCounts();
}

let flushing: Promise<void> | null = null;
let again = false;

/**
 * Envoie la file. Les erreurs métier sont mises de côté (à montrer au superviseur), le reste est réessayé.
 * Un geste enregistré pendant un envoi en cours est envoyé juste après, sans attendre le prochain cycle.
 */
export function flush(): Promise<void> {
  if (flushing) {
    again = true;
    return flushing;
  }
  flushing = (async () => {
    do {
      again = false;
      await doFlush();
    } while (again && !state.lastError);
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

const BATCH = 50;

async function doFlush(): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  state.syncing = true;
  emit();
  try {
    const d = await db();
    for (;;) {
      const items = (await d.getAll('outbox')).slice(0, BATCH);
      if (!items.length) break;
      const results = await send(items);
      const tx = d.transaction(['outbox', 'rejected'], 'readwrite');
      for (const item of items) {
        const r = results.find((x) => x.key === item.key);
        if (!r) continue;
        await tx.objectStore('outbox').delete(item.seq);
        if (r.status === 'ERROR') {
          await tx.objectStore('rejected').put({ ...item, lastError: { code: r.code, message: r.message }, rejectedAt: Date.now() });
          for (const l of rejectionListeners) l(item, r);
        }
      }
      await tx.done;
      if (items.length < BATCH) break;
    }
    await uploadPhotos();
    state.lastSyncAt = Date.now();
    state.lastError = null;
  } catch (e) {
    state.lastError = e instanceof NetworkError ? 'Hors réseau : envoi dès le retour du réseau' : (e as Error).message;
  } finally {
    state.syncing = false;
    await refreshCounts();
  }
}

const post = (items: OutboxItem[]) =>
  api<{ results: SyncResult[] }>('/field/sync', {
    method: 'POST',
    body: JSON.stringify({ deviceId: deviceId(), deviceTime: new Date().toISOString(), actions: items.map(({ key, at, action }) => ({ key, at, action })) }),
  }).then((r) => r.results);

/**
 * Envoie un lot. Si le serveur rejette le lot entier comme mal formé (400), on renvoie action par action :
 * l'action fautive est mise de côté au lieu de bloquer toute la file derrière elle.
 */
async function send(items: OutboxItem[]): Promise<SyncResult[]> {
  try {
    return await post(items);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 400) throw e;
    const out: SyncResult[] = [];
    for (const item of items) {
      try {
        out.push(...(await post([item])));
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 400) throw err;
        out.push({ key: item.key, status: 'ERROR', code: err.code, message: err.message });
      }
    }
    return out;
  }
}

async function uploadPhotos() {
  const d = await db();
  const photos = (await d.getAll('photos')).sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  for (const p of photos) {
    try {
      await api(`/field/photos/${p.photoId}`, { method: 'PUT', body: p.blob, headers: { 'Content-Type': p.blob.type || 'image/webp' } });
      await d.delete('photos', p.photoId);
    } catch (e) {
      // 404 : l'action qui déclare la photo n'est pas encore passée ; on réessaiera au prochain envoi
      if (e instanceof NetworkError) throw e;
    }
  }
}

type RejectionListener = (item: OutboxItem, r: Extract<SyncResult, { status: 'ERROR' }>) => void;
const rejectionListeners = new Set<RejectionListener>();
export function onRejected(l: RejectionListener): () => void {
  rejectionListeners.add(l);
  return () => rejectionListeners.delete(l);
}

export async function rejectedItems() {
  return (await db()).getAll('rejected');
}
export async function dismissRejected(key: string) {
  await (await db()).delete('rejected', key);
  await refreshCounts();
}

/** Synchronisation automatique : retour du réseau, retour au premier plan, et toutes les 30 s. */
export function startAutoSync(): () => void {
  const kick = () => void flush();
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', kick);
  const timer = window.setInterval(kick, 30_000);
  void refreshCounts().then(kick);
  return () => {
    window.removeEventListener('online', kick);
    document.removeEventListener('visibilitychange', kick);
    window.clearInterval(timer);
  };
}

/** Blocage de la déconnexion tant que la file n'est pas vide (§7.5). */
export async function canLogout(): Promise<boolean> {
  const s = await refreshCounts();
  return s.pending === 0 && s.photos === 0;
}
