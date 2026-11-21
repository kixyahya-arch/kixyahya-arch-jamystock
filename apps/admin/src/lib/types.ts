export interface BoContext {
  depots: { id: string; nom: string; code: string }[];
  clients: { id: string; nom: string; type: 'B2B' | 'B2C' }[];
  today: string;
}

export interface Summary {
  aConfirmer: number;
  contrePropositions: number;
  urgentes: number;
  missionsAAffecter: number;
  missionsDuJour: number;
  articlesEnStock: number;
  clients: number;
}

export interface OrderRow {
  id: string;
  numero: string;
  type: string;
  statut: string;
  clientId: string;
  client: string;
  typeClient: 'B2B' | 'B2C';
  projet: string | null;
  depot: string | null;
  dateSouhaitee: string | null;
  creneauSouhaite: string | null;
  dateConfirmee: string | null;
  creneauConfirme: string | null;
  dateContreProposee: string | null;
  adresse: string | null;
  volumeM3: number | null;
  creeLe: string;
  nbLignes: number;
  missionsAAffecter: number;
  urgent: boolean;
}

export interface Mission {
  id: string;
  type: string;
  statut: string;
  debutPrevu: string | null;
  ordre: number | null;
  assigneA: string | null;
  assigneNom: string | null;
  vehiculeId: string | null;
  vehicule: string | null;
  commandeId: string | null;
  numero: string | null;
  typeCommande: string | null;
  statutCommande: string | null;
  client: string | null;
  adresse: string | null;
  creneau: string | null;
  volumeM3: number | null;
  poidsKg: number | null;
  vehiculeSuggere: string | null;
  nbLignes: number;
  /** INV-07 : mission « Photo » demandée par le client */
  demande?: 'PHOTO' | 'CONSTAT' | null;
  demandeMessage?: string | null;
  articleId?: string | null;
  articleLibelle?: string | null;
  /** WMS-05 : mission de comptage d'un inventaire tournant */
  inventaireId?: string | null;
  inventaireNumero?: string | null;
  inventaireZone?: string | null;
  inventaireEmplacements?: number | null;
}

export interface OrderDetail extends Omit<OrderRow, 'urgent' | 'missionsAAffecter' | 'nbLignes' | 'adresse'> {
  demandeur: string;
  demandeurEmail: string;
  adresse: { libelle?: string } | null;
  contraintesAcces: { etage?: number; ascenseur?: unknown; accesPL?: boolean; hauteurLimiteM?: number; horairesChantier?: string; consignes?: string } | null;
  contactSite: { nom: string; telephone: string } | null;
  messageDispatcher: string | null;
  motifRefus: string | null;
  poidsKg: number | null;
  vehiculeSuggere: string | null;
  descriptionCollecte: string | null;
  /** CMD-06 : photos prises par le client en demandant la collecte */
  photosCollecte?: { id: string; vignette: string; moyenne: string; originale: string }[];
  depotSansSignature?: boolean;
  natureCollecte?: 'NOUVEAUX' | 'RETOUR' | 'TRANSFERT';
  destination?: { libelle?: string } | null;
  historique: { statut: string; le: string; par: string }[];
  lignes: {
    id: string;
    statutLigne: string;
    descriptionLibre: string | null;
    quantite: number | null;
    articleId: string | null;
    libelle: string | null;
    qrCode: string | null;
    statutArticle: string | null;
    localisation: string | null;
    vignette: string | null;
  }[];
  missions: Mission[];
}

export interface Resource {
  id: string;
  nom: string;
  role: 'DRIVER' | 'OPERATOR';
}
export interface Vehicle {
  id: string;
  immatriculation: string;
  type: string;
  volumeM3: number;
  chargeUtileKg: number;
}
export interface Planning {
  date: string;
  missions: Mission[];
  ressources: Resource[];
  vehicules: Vehicle[];
}

export interface ClientRow {
  id: string;
  nom: string;
  type: 'B2B' | 'B2C';
  siret: string | null;
  statut: string;
  nbProjets: number;
  nbUtilisateurs: number;
  demandesEnCours: number;
  nbArticles: number;
  m2Occupes: number;
  m2Inclus: number | null;
  taux: number | null;
  niveau: string | null;
}

export interface ClientDetail {
  id: string;
  nom: string;
  type: 'B2B' | 'B2C';
  siret: string | null;
  tvaIntracom: string | null;
  adresseFacturation: { libelle?: string } | null;
  conditionsPaiement: string | null;
  statut: string;
  creeLe: string;
  emailFacturation: string | null;
  bonDeCommande: string | null;
  moyenPaiement: 'CARTE' | 'SEPA' | 'VIREMENT' | null;
  moyenDetail: { type: string; marque?: string; derniers4: string; expire?: string } | null;
  projets: { id: string; nom: string; statut: string; nbArticles: number }[];
  utilisateurs: { id: string; nom: string; email: string; role: string; statut: string; derniereConnexion: string | null }[];
  forfait: {
    m2Inclus: number;
    prixMensuelCents: number;
    prixM2DepassementCents: number;
    prestationsIncluses: Record<string, number>;
    dateDebut: string;
    engagementMois: number | null;
    grille: string;
  } | null;
  surface: { m2Occupes: number; m2Inclus: number | null; taux: number | null; niveau: string | null; nbArticles: number; parProjet: { projetId: string; nom: string; nbArticles: number; m2: number }[] };
}

export interface StockItem {
  id: string;
  qrCode: string;
  libelle: string;
  nomClient: string | null;
  client: string | null;
  statut: string;
  etat: string;
  categorie: string | null;
  localisation: string | null;
  dateEntree: string | null;
  vignette: string | null;
  engage: boolean;
}
