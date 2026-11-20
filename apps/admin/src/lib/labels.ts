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

export const MISSION_TYPE: Record<string, string> = {
  PREPARATION: 'Préparation',
  LIVRAISON: 'Livraison',
  COLLECTE: 'Collecte',
  RETRAIT: 'Retrait au dépôt',
  INVENTAIRE: 'Inventaire',
  PHOTO: 'Photo',
  DEGROUPAGE: 'Dégroupage',
};
export const MISSION_STATUS: Record<string, string> = {
  A_AFFECTER: 'À affecter',
  AFFECTEE: 'Affectée',
  EN_COURS: 'En cours',
  TERMINEE: 'Terminée',
  ANNULEE: 'Annulée',
  ANOMALIE: 'Anomalie',
};
export const ROLE: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  DISPATCHER: 'Dispatcher',
  OPERATOR: 'Opérateur',
  DRIVER: 'Chauffeur',
  B2B_ADMIN: 'Admin client',
  B2B_USER: 'Utilisateur client',
  B2C: 'Particulier',
};
export const USER_STATUS: Record<string, string> = { INVITE: 'Invité', ACTIF: 'Actif', DESACTIVE: 'Désactivé' };

/** Une mission de transport va à un chauffeur, les autres à un opérateur (FLX-03). */
export const roleFor = (missionType: string) => (['LIVRAISON', 'COLLECTE'].includes(missionType) ? 'DRIVER' : 'OPERATOR');

export const dateShort = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) : '—';
export const timeFr = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '';

/** Ajoute n jours à une date AAAA-MM-JJ, sans fuseau. */
export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const INVOICE_STATUS: Record<string, string> = {
  BROUILLON: 'Brouillon',
  EMISE: 'Émise',
  PAYEE: 'Payée',
  EN_RETARD: 'En retard',
  ANNULEE: 'Annulée par avoir',
};
export const LINE_TYPE: Record<string, string> = { ABONNEMENT: 'Forfait', DEPASSEMENT_M2: 'Dépassement', PRESTATION: 'Prestation' };
export const SNAPSHOT_SOURCE: Record<string, string> = { AUTO: 'Calcul de 23 h 59', RATTRAPAGE: 'Rattrapage', CORRECTION: 'Correction manuelle' };
export const AUDIT_ACTION: Record<string, string> = {
  BROUILLONS_GENERES: 'Brouillon généré',
  LIGNE_AJOUTEE: 'Ligne ajoutée',
  LIGNE_RETIREE: 'Ligne retirée',
  FACTURE_BLOQUEE: 'Bloquée',
  FACTURE_DEBLOQUEE: 'Débloquée',
  FACTURE_EMISE: 'Émise',
  AVOIR_EMIS: 'Avoir émis',
  AVOIR_CREE: 'Avoir créé',
  FACTURE_PAYEE: 'Paiement reçu',
  RELANCE_MANUELLE: 'Relance envoyée',
};

/** « 1 800,50 » ou « 1800.5 » → centimes ; null si illisible. */
export function parseEuros(v: string): number | null {
  const s = v.replace(/[\s\u202f\u00a0€]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}
export const m2 = (n: number | null | undefined) => (n == null ? '—' : `${n.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} m²`);
export const monthFr = (month: string) => new Date(`${month}-15T12:00:00`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
/** Mois précédant une date AAAA-MM-JJ. */
export function previousMonth(iso: string): string {
  const d = new Date(`${iso.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 7);
}
