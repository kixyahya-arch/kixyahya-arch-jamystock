export interface Ctx {
  entreprise: { id: string; nom: string; type: 'B2B' | 'B2C' };
  projets: { id: string; nom: string; statut: string }[];
  categories: { id: string; nom: string }[];
  depots: { id: string; nom: string }[];
}

export interface Article {
  id: string;
  qrCode: string;
  libelle: string;
  nomClient: string | null;
  statut: string;
  etat: string;
  projetId: string | null;
  categorie: string | null;
  localisation: string | null;
  dateEntree: string | null;
  vignette: string | null;
  engage: boolean;
}

export interface Page<T> {
  total: number;
  items: T[];
  suivant: string | null;
}

export interface Photo {
  id: string;
  contexte: string;
  priseLe: string;
  disponible: boolean;
  vignette?: string;
  moyenne?: string;
  originale?: string;
}

export interface ArticleDetail extends Record<string, unknown> {
  id: string;
  libelle: string;
  nom_client: string | null;
  description: string | null;
  qr_code: string;
  statut: string;
  etat: string;
  categorie: string | null;
  projet: string | null;
  projet_id: string | null;
  localisation: string | null;
  longueur_m: number | null;
  largeur_m: number | null;
  hauteur_m: number | null;
  poids_kg: number | null;
  empilable: boolean;
  date_entree: string | null;
  photos: Photo[];
  mouvements: { id: string; type: string; le: string; statut: string | null; motif: string | null }[];
}

export interface Surface {
  perimetre: 'ENTREPRISE' | 'PROJETS';
  m2Occupes: number;
  m2Inclus: number | null;
  taux: number | null;
  niveau: 'OK' | 'ATTENTION' | 'DEPASSEMENT' | null;
  nbArticles: number;
  parProjet: { projetId: string; nom: string; nbArticles: number; m2: number }[];
  calculeLe: string;
}

export interface OrderLine {
  id: string;
  articleId: string | null;
  descriptionLibre: string | null;
  statutLigne: string;
  libelle: string | null;
  qrCode: string | null;
  disponible?: boolean;
}

export interface Order {
  id: string;
  numero: string | null;
  type: 'LIVRAISON' | 'RETRAIT' | 'COLLECTE';
  statut: string;
  projetId: string | null;
  dateSouhaitee: string | null;
  dateConfirmee: string | null;
  creneauConfirme: string | null;
  dateContreProposee: string | null;
  motifRefus: string | null;
  adresse: { libelle: string } | null;
  contactSite: { nom: string; telephone: string } | null;
  historique: { statut: string; le: string; par?: string }[];
  nbArticles: number;
  volumeM3: number;
  vehiculeSuggere: string | null;
  lignes: OrderLine[];
}

export interface OrderSummary {
  id: string;
  numero: string;
  type: Order['type'];
  statut: string;
  projetId: string | null;
  dateSouhaitee: string | null;
  dateConfirmee: string | null;
  creeLe: string;
  nbArticles: number;
}

export interface Cart extends Partial<Order> {
  lignes: OrderLine[];
  nbArticles: number;
  volumeM3: number;
  vehiculeSuggere: string | null;
  estimation: {
    datePlusTot: string;
    livraison: { libelle: string; prixHtCents: number } | null;
    livraisonsIncluses: number;
    livraisonsIncluseRestantes: number;
    retraitHtCents: number;
  };
}

export const ARTICLE_STATUS: Record<string, string> = {
  ATTENDU: 'Attendu',
  EN_RECEPTION: 'En réception',
  EN_STOCK: 'En stock',
  RESERVE: 'Réservé',
  EN_PREPARATION: 'En préparation',
  EN_TRANSIT: 'En transit',
  RESTITUE: 'Restitué',
  PERDU: 'Perdu',
  DETRUIT: 'Détruit',
};

export const CONDITION: Record<string, string> = { NEUF: 'Neuf', BON: 'Bon état', USE: 'Usé', ENDOMMAGE: 'Endommagé' };

export const ORDER_STATUS: Record<string, string> = {
  BROUILLON: 'Panier',
  EN_ATTENTE_VALIDATION: 'À valider',
  SOUMISE: 'Envoyée',
  REFUSEE: 'Refusée',
  PLANIFIEE: 'Planifiée',
  EN_PREPARATION: 'En préparation',
  PRETE: 'Prête',
  EN_LIVRAISON: 'En livraison',
  RETIREE: 'Retirée',
  LIVREE: 'Livrée',
  LIVREE_AVEC_RESERVES: 'Livrée avec réserves',
  ECHEC_LIVRAISON: 'Échec de livraison',
  COLLECTEE: 'Collectée',
  STOCKEE: 'En stock',
  ANNULEE: 'Annulée',
  CLOTUREE: 'Clôturée',
};

export const ORDER_TYPE: Record<string, string> = { LIVRAISON: 'Livraison', RETRAIT: 'Retrait au dépôt', COLLECTE: 'Collecte' };

export const MOVE_TYPE: Record<string, string> = {
  RECEPTION: 'Arrivée au dépôt',
  RANGEMENT: 'Rangé',
  TRANSFERT: 'Déplacé dans le dépôt',
  PREPARATION: 'Préparé pour une commande',
  CHARGEMENT: 'Chargé',
  LIVRAISON: 'Livré',
  RETOUR: 'Retour au dépôt',
  AJUSTEMENT: 'Correction d’inventaire',
};

/** Statuts où le client peut encore modifier ou annuler (CMD-07) */
export const EDITABLE = ['BROUILLON', 'EN_ATTENTE_VALIDATION', 'SOUMISE'];

export const euros = (cents: number) => (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
export const dateFr = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';
