import { api, NetworkError } from './api';
import { cacheGet, cacheSet } from './db';

/** Référentiels et missions pré-chargés à la prise de poste (§7.5), relus depuis le cache hors réseau. */
export interface Bootstrap {
  serverTime: string;
  missions: MissionSummary[];
  emplacements: { id: string; code: string; chemin: string; qrCode: string; statut: string; typeZone: string }[];
  categories: { id: string; nom: string; icone: string | null; longueurM: number | null; largeurM: number | null; hauteurM: number | null; empilable: boolean }[];
}

export interface MissionSummary {
  id: string;
  type: 'PREPARATION' | 'LIVRAISON' | 'COLLECTE' | 'RETRAIT' | 'INVENTAIRE' | 'PHOTO' | 'DEGROUPAGE';
  statut: string;
  ordre: number | null;
  debutPrevu: string | null;
  commandeId: string | null;
  numero: string | null;
  adresse: { libelle?: string; lat?: number; lng?: number } | null;
  contraintesAcces: Record<string, unknown> | null;
  contactSite: { nom: string; telephone: string } | null;
  creneau: string | null;
  /** mission « Photo » : bien concerné */
  articleLibelle?: string | null;
}

export interface MissionLine {
  id: string;
  articleId: string | null;
  statutLigne: string;
  descriptionLibre: string | null;
  qrCode: string | null;
  libelle: string | null;
  statut: string | null;
  chemin: string | null;
  emplacementCode: string | null;
  vignette: string | null;
  /** CMD-09 : palette (UM) d'où sortir le bien avant préparation */
  umADegrouper?: string | null;
  resteSurUm?: boolean;
}

export interface MissionDetail {
  id: string;
  type: MissionSummary['type'];
  statut: string;
  commande: {
    id: string;
    numero: string;
    type: string;
    statut: string;
    adresse: { libelle?: string; lat?: number; lng?: number } | null;
    contraintesAcces: Record<string, unknown> | null;
    contactSite: { nom: string; telephone: string } | null;
    dateConfirmee: string | null;
    creneau: string | null;
    /** LIV-05 : le client autorise le dépôt si personne n'est là */
    depotSansSignature?: boolean;
  } | null;
  lignes: MissionLine[];
  /** INV-07 : bien à photographier et demande du client (missions « Photo ») */
  demande?: {
    type: 'PHOTO' | 'CONSTAT';
    message: string | null;
    article: { id: string; qrCode: string; libelle: string; nomClient: string | null; etat: string; chemin: string | null; client: string | null; vignette: string | null };
  } | null;
}

export interface Reception {
  commandeId: string;
  numero: string;
  client: string;
  projet: string | null;
  nbArticles: number;
  nbRanges: number;
  articles: { id: string; qrCode: string; libelle: string; statut: string }[];
}

/** Réseau d'abord, cache en repli ; renvoie aussi la provenance pour l'afficher. */
async function cached<T>(key: string, path: string): Promise<{ data: T | undefined; offline: boolean }> {
  try {
    const data = await api<T>(path);
    await cacheSet(key, data);
    return { data, offline: false };
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    return { data: await cacheGet<T>(key), offline: true };
  }
}

export async function loadBootstrap() {
  const res = await cached<Bootstrap>('bootstrap', '/field/bootstrap');
  if (!res.offline && res.data) {
    // pré-chargement des missions du jour pour travailler sans réseau
    await Promise.all(res.data.missions.map((m) => loadMission(m.id).catch(() => undefined)));
  }
  return res;
}

export const loadMission = (id: string) => cached<MissionDetail>(`mission:${id}`, `/field/missions/${id}`);
export const loadReceptions = () => cached<Reception[]>('receptions', '/field/receptions');
