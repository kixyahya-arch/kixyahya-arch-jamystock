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
  referenceInterne: string | null;
  categorieClient: string | null;
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
  reference_interne: string | null;
  categorie_client: string | null;
  note_client: string | null;
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
  /** CMD-09 : nombre de biens de l'UM (palette) où l'article est rangé */
  umTotal?: number | null;
  aDegrouper?: boolean;
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
  depotSansSignature?: boolean;
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

/** INV-07 : demande de photo ou de constat sur un bien. */
export interface ArticleRequest {
  id: string;
  statut: 'A_AFFECTER' | 'AFFECTEE' | 'EN_COURS' | 'TERMINEE';
  demande: 'PHOTO' | 'CONSTAT';
  message: string;
  demandeeLe: string;
  traiteeLe: string | null;
  commentaire: string | null;
}

/** INV-05 : export PDF préparé en tâche de fond. */
export interface InventoryExport {
  id: string;
  statut: 'EN_COURS' | 'PRET' | 'ECHEC';
  nbArticles: number | null;
  creeLe: string;
  pretLe: string | null;
  expireLe: string;
}

/** ADM-02 : estimation de la prochaine facture. */
export interface BillingEstimate {
  mois: string;
  calculeLe: string;
  emissionPrevue: string;
  surfaceActuelle: number;
  factures: {
    periodeDebut: string;
    periodeFin: string;
    m2Inclus: number;
    modeSurface: string;
    m2Factures: number;
    joursReleves: number;
    joursProjetes: number;
    lignes: { type: string; libelle: string; quantite: number; unite: string; prixUnitaireHtCents: number; totalHtCents: number }[];
    totalHtCents: number;
    tvaCents: number;
    totalTtcCents: number;
  }[];
  totalHtCents: number;
  tvaCents: number;
  totalTtcCents: number;
}

/** CMD-08 : modèle de panier */
export interface CartTemplate {
  id: string;
  nom: string;
  projetId: string | null;
  projet: string | null;
  auteur: string | null;
  creeLe: string;
  utiliseLe: string | null;
  nbArticles: number;
  nbDisponibles: number;
  supprimable: boolean;
}

export interface PhotoLinks {
  id: string;
  vignette: string;
  moyenne: string;
  originale: string;
}

/** SUI-04 : signalement après livraison */
export interface Dispute {
  id: string;
  numero: string;
  motif: 'CASSE' | 'RAYURE' | 'MANQUANT' | 'ERREUR' | 'AUTRE';
  description: string;
  articles: { id: string; libelle: string }[];
  photos: PhotoLinks[];
  statut: 'OUVERT' | 'EN_COURS' | 'RESOLU' | 'REJETE';
  reponse: string | null;
  gesteCents: number | null;
  creeLe: string;
  traiteLe: string | null;
  auteur: string | null;
}

export interface Delivery {
  livraison: {
    blId: string;
    numero: string;
    nonSigne: boolean;
    le: string | null;
    lieuDepot: string | null;
    signataire: string | null;
    photos: PhotoLinks[];
    articles: { id: string; libelle: string }[];
    signalementJusquau: string | null;
    signalementPossible: boolean;
  } | null;
  litiges: Dispute[];
}
