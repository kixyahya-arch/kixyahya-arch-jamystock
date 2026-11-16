/**
 * Contrat de synchronisation de l'app terrain (§7.5), partagé entre la PWA et l'API.
 *
 * Chaque geste terrain (scan, photo, signature) devient une action enregistrée localement puis envoyée
 * dans une file ordonnée. Une action porte une clé d'idempotence : la renvoyer après une coupure réseau
 * renvoie la même réponse sans rien rejouer.
 */
import { fingerprint } from './ids.js';
import type { ArticleCondition } from './article-state.js';

export interface GpsFix {
  lat: number;
  lng: number;
  /** précision en mètres */
  precision?: number;
}

export interface Signatory {
  nom: string;
  qualite: string;
}

export interface ReserveInput {
  articleId: string;
  type: 'CASSE' | 'RAYURE' | 'MANQUANT' | 'REFUS' | 'AUTRE';
  commentaire?: string;
  photoIds?: string[];
}

export interface PhotoRef {
  /** UUID v7 généré sur le terminal ; le binaire est envoyé ensuite (PUT /field/photos/:id) */
  photoId: string;
}

export type FieldAction =
  | {
      type: 'ARTICLE_CREATE';
      payload: {
        articleId: string;
        qr: string;
        entrepriseId?: string;
        projetId?: string | null;
        commandeId?: string | null;
        libelle: string;
        categorieId?: string | null;
        etat: ArticleCondition;
        description?: string;
        longueurM?: number;
        largeurM?: number;
        hauteurM?: number;
        poidsKg?: number;
        empilable?: boolean;
        photos: PhotoRef[];
      };
    }
  | { type: 'ARTICLE_STORE'; payload: { articleQr: string; locationQr: string; force?: boolean; motif?: string } }
  | { type: 'TRANSFER'; payload: { qr: string; locationQr: string; motif?: string } }
  | { type: 'UM_CREATE'; payload: { umId: string; qr: string; umType: 'PALETTE' | 'CAISSE' | 'RACK'; entrepriseId?: string; longueurM?: number; largeurM?: number } }
  | { type: 'UM_ADD'; payload: { umQr: string; articleQr: string } }
  | { type: 'UM_STORE'; payload: { umQr: string; locationQr: string; force?: boolean; motif?: string } }
  | { type: 'RECEPTION_CLOSE'; payload: { commandeId: string } }
  | { type: 'PICK'; payload: { missionId: string; articleQr: string } }
  | { type: 'PICK_MISSING'; payload: { missionId: string; articleId: string; photoId?: string; commentaire?: string } }
  | { type: 'PICK_COMPLETE'; payload: { missionId: string } }
  | { type: 'LOAD'; payload: { missionId: string; articleQr: string } }
  | { type: 'DEPART'; payload: { missionId: string } }
  | { type: 'ARRIVE'; payload: { missionId: string; gps?: GpsFix } }
  | { type: 'BL_SIGN'; payload: BlSignPayload }
  | { type: 'PICKUP_SIGN'; payload: PickupSignPayload }
  | { type: 'RETURN'; payload: { articleQr: string; locationQr?: string; motif?: string } };

export type FieldActionType = FieldAction['type'];

export interface BlSignPayload {
  missionId: string;
  blId: string;
  livres: string[];
  refuses: string[];
  reserves: ReserveInput[];
  signataire: Signatory;
  signatureSvg: string;
  signedAt: string;
  gps?: GpsFix;
  /** SHA-256 calculé par le terminal sur blContent(...) */
  empreinte: string;
}

export interface PickupSignPayload {
  missionId: string;
  blId: string;
  articles: { articleId: string; qr?: string; libelle: string; categorieId?: string | null; photos: PhotoRef[] }[];
  signataire: Signatory;
  signatureSvg: string;
  signedAt: string;
  gps?: GpsFix;
  empreinte: string;
}

export interface SyncEnvelope {
  key: string;
  /** horodatage du terminal au moment du geste (ISO 8601) */
  at: string;
  action: FieldAction;
}

export interface SyncRequest {
  deviceId: string;
  /** heure du terminal à l'envoi, pour mesurer la dérive d'horloge */
  deviceTime: string;
  actions: SyncEnvelope[];
}

export type SyncResult =
  | { key: string; status: 'OK'; data?: unknown; warnings?: string[]; replayed?: boolean }
  | { key: string; status: 'ERROR'; code: string; message: string; replayed?: boolean };

/** Dérive d'horloge au-delà de laquelle l'horodatage est corrigé et signalé (§7.5). */
export const MAX_CLOCK_SKEW_MS = 2 * 60_000;

/** Contenu signé d'un BL de livraison : ce qui est montré au réceptionnaire et scellé par l'empreinte. */
export function blContent(p: Omit<BlSignPayload, 'empreinte' | 'gps'>) {
  return {
    blId: p.blId,
    missionId: p.missionId,
    livres: [...p.livres].sort(),
    refuses: [...p.refuses].sort(),
    reserves: [...p.reserves]
      .map((r) => ({ articleId: r.articleId, type: r.type, commentaire: r.commentaire ?? '', photoIds: [...(r.photoIds ?? [])].sort() }))
      .sort((a, b) => (a.articleId + a.type < b.articleId + b.type ? -1 : 1)),
    signataire: { nom: p.signataire.nom, qualite: p.signataire.qualite },
    signatureSvg: p.signatureSvg,
    signedAt: p.signedAt,
  };
}

export function blFingerprint(p: Omit<BlSignPayload, 'empreinte' | 'gps'>): string {
  return fingerprint(blContent(p));
}

export function pickupContent(p: Omit<PickupSignPayload, 'empreinte' | 'gps'>) {
  return {
    blId: p.blId,
    missionId: p.missionId,
    articles: [...p.articles]
      .map((a) => ({ articleId: a.articleId, qr: a.qr ?? null, libelle: a.libelle, photoIds: a.photos.map((x) => x.photoId).sort() }))
      .sort((a, b) => (a.articleId < b.articleId ? -1 : 1)),
    signataire: { nom: p.signataire.nom, qualite: p.signataire.qualite },
    signatureSvg: p.signatureSvg,
    signedAt: p.signedAt,
  };
}

export function pickupFingerprint(p: Omit<PickupSignPayload, 'empreinte' | 'gps'>): string {
  return fingerprint(pickupContent(p));
}

/** Tri des prélèvements par chemin dans le dépôt (PRP-01) : Zone > Allée > Emplacement, ordre naturel. */
export function sortByPath<T extends { chemin: string | null }>(items: T[]): T[] {
  const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
  return [...items].sort((a, b) => collator.compare(a.chemin ?? '￿', b.chemin ?? '￿'));
}
