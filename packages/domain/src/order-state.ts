/**
 * Cycle de vie d'une commande (§6.4). Toute transition non listée est refusée.
 */
export const ORDER_TYPES = ['LIVRAISON', 'RETRAIT', 'COLLECTE'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_STATUSES = [
  'BROUILLON',
  'EN_ATTENTE_VALIDATION',
  'SOUMISE',
  'REFUSEE',
  'PLANIFIEE',
  'EN_PREPARATION',
  'PRETE',
  'EN_LIVRAISON',
  'RETIREE',
  'LIVREE',
  'LIVREE_AVEC_RESERVES',
  'ECHEC_LIVRAISON',
  'COLLECTEE',
  'STOCKEE',
  'ANNULEE',
  'CLOTUREE',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Libellés affichés au client (frise SUI-01). */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  BROUILLON: 'Panier',
  EN_ATTENTE_VALIDATION: 'En attente de votre validation interne',
  SOUMISE: 'Demande reçue',
  REFUSEE: 'Refusée',
  PLANIFIEE: 'Confirmée',
  EN_PREPARATION: 'En préparation',
  PRETE: 'Prête à partir',
  EN_LIVRAISON: 'En cours de livraison',
  RETIREE: 'Retirée au dépôt',
  LIVREE: 'Livré',
  LIVREE_AVEC_RESERVES: 'Livré avec réserves',
  ECHEC_LIVRAISON: 'Livraison non effectuée',
  COLLECTEE: 'Collecté',
  STOCKEE: 'Stocké',
  ANNULEE: 'Annulée',
  CLOTUREE: 'Clôturée',
};

type TransitionTable = Partial<Record<OrderStatus, readonly OrderStatus[]>>;

const COMMON: TransitionTable = {
  BROUILLON: ['SOUMISE', 'EN_ATTENTE_VALIDATION'],
  EN_ATTENTE_VALIDATION: ['SOUMISE', 'REFUSEE'],
  SOUMISE: ['PLANIFIEE', 'ANNULEE'],
};

const TRANSITIONS: Record<OrderType, TransitionTable> = {
  LIVRAISON: {
    ...COMMON,
    PLANIFIEE: ['EN_PREPARATION', 'ANNULEE'],
    EN_PREPARATION: ['PRETE'],
    PRETE: ['EN_LIVRAISON'],
    EN_LIVRAISON: ['LIVREE', 'LIVREE_AVEC_RESERVES', 'ECHEC_LIVRAISON'],
    LIVREE: ['CLOTUREE'],
    LIVREE_AVEC_RESERVES: ['CLOTUREE'],
    ECHEC_LIVRAISON: ['PLANIFIEE'],
  },
  RETRAIT: {
    ...COMMON,
    PLANIFIEE: ['EN_PREPARATION', 'ANNULEE'],
    EN_PREPARATION: ['PRETE'],
    PRETE: ['RETIREE'],
    RETIREE: ['CLOTUREE'],
  },
  COLLECTE: {
    ...COMMON,
    PLANIFIEE: ['COLLECTEE', 'ANNULEE'],
    // un transfert de site à site est « livré » sur le site de destination au lieu d'être stocké
    COLLECTEE: ['STOCKEE', 'LIVREE'],
    STOCKEE: ['CLOTUREE'],
    LIVREE: ['CLOTUREE'],
  },
};

export function allowedTransitions(type: OrderType, from: OrderStatus): readonly OrderStatus[] {
  return TRANSITIONS[type][from] ?? [];
}

export function canTransition(type: OrderType, from: OrderStatus, to: OrderStatus): boolean {
  return allowedTransitions(type, from).includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly type: OrderType,
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`Transition refusée pour une commande ${type} : ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(type: OrderType, from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(type, from, to)) throw new InvalidTransitionError(type, from, to);
}

/**
 * Statuts « actifs » : un article ne peut appartenir qu'à une seule commande active (§5.2).
 * Le panier (BROUILLON) n'est pas actif : il ne bloque pas l'article tant qu'il n'est pas soumis.
 */
export const ACTIVE_ORDER_STATUSES: readonly OrderStatus[] = [
  'EN_ATTENTE_VALIDATION',
  'SOUMISE',
  'PLANIFIEE',
  'EN_PREPARATION',
  'PRETE',
  'EN_LIVRAISON',
  'ECHEC_LIVRAISON',
];

export function isActiveOrder(status: OrderStatus): boolean {
  return ACTIVE_ORDER_STATUSES.includes(status);
}

/** CMD-07 : modification libre par le client jusqu'au statut « Planifiée » (exclu). */
export function isClientEditable(status: OrderStatus): boolean {
  return status === 'BROUILLON' || status === 'EN_ATTENTE_VALIDATION' || status === 'SOUMISE';
}
