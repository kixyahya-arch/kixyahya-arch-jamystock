import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { FieldAction, SyncEnvelope } from '@jamystock/domain/browser';

/**
 * Base locale du terminal (§7.5) : l'app fonctionne d'abord en local, le réseau est un bonus.
 *  - outbox : actions en attente d'envoi, ordonnées par horodatage terminal
 *  - photos : binaires compressés en attente de téléversement (après les données)
 *  - cache : référentiels et missions pré-chargés en début de journée
 *  - marks : état local des écrans (articles prélevés, chargés, pointés…)
 */
export interface OutboxItem extends SyncEnvelope {
  seq: number;
  attempts: number;
  lastError?: { code: string; message: string };
}

export interface PhotoItem {
  photoId: string;
  blob: Blob;
  /** 0 = BL et réserves (prioritaires), 1 = réception */
  priority: number;
  createdAt: number;
}

interface TerrainDB extends DBSchema {
  outbox: { key: number; value: OutboxItem; indexes: { byKey: string } };
  photos: { key: string; value: PhotoItem };
  cache: { key: string; value: { key: string; value: unknown; savedAt: number } };
  marks: { key: string; value: { key: string; value: unknown } };
  rejected: { key: string; value: OutboxItem & { rejectedAt: number } };
}

let dbp: Promise<IDBPDatabase<TerrainDB>> | null = null;

export function db(): Promise<IDBPDatabase<TerrainDB>> {
  dbp ??= openDB<TerrainDB>('jamystock-terrain', 1, {
    upgrade(d) {
      const o = d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
      o.createIndex('byKey', 'key', { unique: true });
      d.createObjectStore('photos', { keyPath: 'photoId' });
      d.createObjectStore('cache', { keyPath: 'key' });
      d.createObjectStore('marks', { keyPath: 'key' });
      d.createObjectStore('rejected', { keyPath: 'key' });
    },
  });
  return dbp;
}

/** Pour les tests : repartir d'une base vide. */
export async function resetDb(): Promise<void> {
  if (dbp) (await dbp).close();
  dbp = null;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('jamystock-terrain');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('cache', key))?.value as T | undefined;
}
export async function cacheSet(key: string, value: unknown): Promise<void> {
  await (await db()).put('cache', { key, value, savedAt: Date.now() });
}
export async function markGet<T>(key: string, fallback: T): Promise<T> {
  return ((await (await db()).get('marks', key))?.value as T | undefined) ?? fallback;
}
export async function markSet(key: string, value: unknown): Promise<void> {
  await (await db()).put('marks', { key, value });
}

export type { FieldAction };
