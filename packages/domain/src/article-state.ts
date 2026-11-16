/**
 * Statuts d'article (§5.1) et effets des mouvements (§5 : la position et l'état d'un article
 * sont la conséquence de ses mouvements).
 */
export const ARTICLE_STATUSES = [
  'ATTENDU',
  'EN_RECEPTION',
  'EN_STOCK',
  'RESERVE',
  'EN_PREPARATION',
  'EN_TRANSIT',
  'RESTITUE',
  'PERDU',
  'DETRUIT',
] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

export const ARTICLE_CONDITIONS = ['NEUF', 'BON', 'USE', 'ENDOMMAGE'] as const;
export type ArticleCondition = (typeof ARTICLE_CONDITIONS)[number];

export const MOVEMENT_TYPES = [
  'RECEPTION',
  'RANGEMENT',
  'TRANSFERT',
  'PREPARATION',
  'CHARGEMENT',
  'LIVRAISON',
  'RETOUR',
  'AJUSTEMENT',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/** Statuts qui ne comptent pas dans la surface facturée (RG-M2-04). */
export const NON_BILLABLE_ARTICLE_STATUSES: readonly ArticleStatus[] = [
  'ATTENDU',
  'EN_RECEPTION',
  'EN_TRANSIT',
  'RESTITUE',
  'PERDU',
  'DETRUIT',
];

export function isBillableStatus(status: ArticleStatus): boolean {
  return !NON_BILLABLE_ARTICLE_STATUSES.includes(status);
}

/** Article encore « actif » : son QR code ne peut pas être réattribué (RG-STK-02). */
export function isActiveArticle(status: ArticleStatus): boolean {
  return status !== 'RESTITUE' && status !== 'PERDU' && status !== 'DETRUIT';
}

export interface ArticleProjection {
  status: ArticleStatus;
  locationId: string | null;
  unitId: string | null;
}

export interface MovementInput {
  type: MovementType;
  toLocationId?: string | null;
  /** Pour AJUSTEMENT : statut cible explicite (PERDU, DETRUIT, EN_STOCK...). */
  targetStatus?: ArticleStatus;
}

export class MovementRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MovementRuleError';
  }
}

/** Mouvements autorisés selon le statut courant. */
const ALLOWED: Record<MovementType, readonly ArticleStatus[]> = {
  RECEPTION: ['ATTENDU'],
  RANGEMENT: ['EN_RECEPTION', 'ATTENDU'],
  TRANSFERT: ['EN_STOCK', 'RESERVE'],
  PREPARATION: ['RESERVE', 'EN_STOCK'],
  CHARGEMENT: ['EN_PREPARATION'],
  LIVRAISON: ['EN_TRANSIT'],
  RETOUR: ['EN_TRANSIT', 'RESTITUE'],
  AJUSTEMENT: ARTICLE_STATUSES,
};

/**
 * Applique un mouvement à la projection d'un article et renvoie la nouvelle projection.
 * Fonction pure : l'API l'appelle dans la même transaction que l'insertion du mouvement.
 */
export function applyMovement(current: ArticleProjection, mv: MovementInput): ArticleProjection {
  if (!ALLOWED[mv.type].includes(current.status)) {
    throw new MovementRuleError(`Mouvement ${mv.type} impossible depuis le statut ${current.status}`);
  }
  switch (mv.type) {
    case 'RECEPTION':
      return { status: 'EN_RECEPTION', locationId: mv.toLocationId ?? null, unitId: current.unitId };
    case 'RANGEMENT':
    case 'TRANSFERT':
      if (!mv.toLocationId) throw new MovementRuleError(`${mv.type} exige un emplacement de destination`);
      return {
        status: current.status === 'RESERVE' ? 'RESERVE' : 'EN_STOCK',
        locationId: mv.toLocationId,
        unitId: current.unitId,
      };
    case 'PREPARATION':
      return { status: 'EN_PREPARATION', locationId: mv.toLocationId ?? current.locationId, unitId: current.unitId };
    case 'CHARGEMENT':
      return { status: 'EN_TRANSIT', locationId: null, unitId: current.unitId };
    case 'LIVRAISON':
      return { status: 'RESTITUE', locationId: null, unitId: null };
    case 'RETOUR':
      return { status: 'EN_RECEPTION', locationId: mv.toLocationId ?? null, unitId: null };
    case 'AJUSTEMENT': {
      if (!mv.targetStatus && mv.toLocationId === undefined) {
        throw new MovementRuleError('AJUSTEMENT exige un statut cible ou un emplacement');
      }
      const status = mv.targetStatus ?? current.status;
      const gone = status === 'PERDU' || status === 'DETRUIT' || status === 'RESTITUE';
      return {
        status,
        locationId: gone ? null : mv.toLocationId !== undefined ? mv.toLocationId : current.locationId,
        unitId: gone ? null : current.unitId,
      };
    }
  }
}

/** RG-STK-01 : pas de mise en stock sans au moins 1 photo et 1 emplacement valide. */
export function assertCanStore(photoCount: number, locationActive: boolean): void {
  if (photoCount < 1) throw new MovementRuleError('Au moins une photo est obligatoire avant la mise en stock');
  if (!locationActive) throw new MovementRuleError("L'emplacement doit être actif pour y ranger un article");
}

export const MAX_PHOTOS_PER_ARTICLE = 6;
