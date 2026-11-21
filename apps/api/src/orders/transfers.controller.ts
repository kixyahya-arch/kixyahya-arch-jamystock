import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import sharp from 'sharp';
import { isClientRole, parisClock } from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { forbidden, notFound, unprocessable } from '../common/errors.js';
import { StorageService } from '../storage/storage.service.js';
import { FilesService } from '../files/files.service.js';
import { transfertPdf } from '../billing/pdf.js';

const uuid = z.string().uuid();

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
  COLLECTEE: 'Biens enlevés, en route',
  STOCKEE: 'En stock',
  ANNULEE: 'Annulée',
  CLOTUREE: 'Clôturée',
};

const dims = (a: { longueur_m: number | null; largeur_m: number | null; hauteur_m: number | null }) =>
  a.longueur_m && a.largeur_m ? `${[a.longueur_m, a.largeur_m, a.hauteur_m].filter((v) => v != null).map((v) => Number(v).toLocaleString('fr-FR')).join(' × ')} m` : null;

/**
 * Transferts programmés (compte rendu Adam, points 7 et 8) : la demande se fait depuis « Sur mes sites » avec une
 * date ; ce contrôleur produit le bon de transfert en PDF (date, départ, arrivée, biens en photo, enlèvement et
 * dépôt de chacun), pour le client comme pour le Back-Office.
 */
@Controller('orders')
export class TransfersController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  @Get(':id/bon-transfert.pdf')
  @RequirePermission('inventory.read')
  async slip(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res() res: Response) {
    const commandeId = uuid.parse(id);
    // visibilité vérifiée avec les droits de l'utilisateur (RLS), puis lecture complète en contexte système
    const visible = await this.db.tx(ctxOf(user), (tx) => tx.query<{ type: string; nature: string | null }>('SELECT type, nature_collecte AS nature FROM commande WHERE id = $1', [commandeId]));
    const v = visible.rows[0];
    if (!v) throw notFound('Commande');
    if (v.type !== 'COLLECTE' || v.nature !== 'TRANSFERT') throw unprocessable('PAS_UN_TRANSFERT', 'Cette demande n’est pas un transfert de site à site');
    const data = await this.db.tx({ tenantId: user.tenantId, role: 'SYSTEM' }, async (tx) => {
      const c = (
        await tx.query<{
          numero: string | null;
          statut: string;
          created_at: Date;
          date_souhaitee: string | null;
          date_confirmee: string | null;
          creneau_confirme: string | null;
          adresse: { libelle?: string } | null;
          destination: { libelle?: string } | null;
          contact_site: { nom: string; telephone: string } | null;
          projet: string | null;
          dest: string | null;
          client: string;
          demandeur: string | null;
        }>(
          `SELECT c.numero, c.statut, c.created_at, c.date_souhaitee::text, c.date_confirmee::text, c.creneau_confirme, c.adresse, c.destination, c.contact_site,
                  p.nom AS projet, pd.nom AS dest, e.nom AS client, u.nom AS demandeur
             FROM commande c JOIN entreprise e ON e.id = c.entreprise_id LEFT JOIN projet p ON p.id = c.projet_id
             LEFT JOIN projet pd ON pd.id = c.destination_projet_id LEFT JOIN utilisateur u ON u.id = c.demandeur_id
            WHERE c.id = $1`,
          [commandeId],
        )
      ).rows[0]!;
      const biens = await tx.query<{
        id: string;
        libelle: string;
        qr: string;
        statut_ligne: string;
        longueur_m: number | null;
        largeur_m: number | null;
        hauteur_m: number | null;
        enleve: Date | null;
        depose: Date | null;
        cle: string | null;
      }>(
        `SELECT a.id, coalesce(a.nom_client, a.libelle) AS libelle, a.qr_code AS qr, l.statut_ligne,
                a.longueur_m::float AS longueur_m, a.largeur_m::float AS largeur_m, a.hauteur_m::float AS hauteur_m,
                (SELECT min(m.horodatage_terminal) FROM mouvement m JOIN mission mi ON mi.id = m.mission_id WHERE mi.commande_id = $1 AND m.article_id = a.id AND m.type = 'CHARGEMENT') AS enleve,
                (SELECT max(m.horodatage_terminal) FROM mouvement m JOIN mission mi ON mi.id = m.mission_id WHERE mi.commande_id = $1 AND m.article_id = a.id AND m.type = 'LIVRAISON') AS depose,
                (SELECT coalesce(ph.cle_vignette, ph.cle_moyenne, ph.cle_originale) FROM photo ph WHERE ph.article_id = a.id AND ph.televersee ORDER BY ph.prise_le, ph.id LIMIT 1) AS cle
           FROM ligne_commande l JOIN article a ON a.id = l.article_id
          WHERE l.commande_id = $1 ORDER BY a.libelle, a.id`,
        [commandeId],
      );
      const emetteur = (await tx.query<{ raison_sociale: string }>('SELECT raison_sociale FROM organisation WHERE id = $1', [user.tenantId])).rows[0]?.raison_sociale ?? 'JAMYSTOCK';
      return { c, biens: biens.rows, emetteur };
    });
    const ETAT: Record<string, string> = { MANQUANTE: 'Non trouvé sur place', LIVREE: 'Pris en charge' };
    const biens = [];
    for (const b of data.biens) {
      const photo = b.cle
        ? await this.storage
            .get(b.cle)
            .then((x) => sharp(x, { failOn: 'none' }).rotate().resize(160, 160, { fit: 'cover' }).flatten({ background: '#ffffff' }).jpeg({ quality: 72 }).toBuffer())
            .catch(() => null)
        : null;
      biens.push({
        libelle: b.libelle,
        qr: b.qr,
        dimensions: dims(b),
        enleveLe: b.enleve ? new Date(b.enleve) : null,
        deposeLe: b.depose ? new Date(b.depose) : null,
        etat: b.depose ? 'Déposé' : (ETAT[b.statut_ligne] ?? 'Prévu'),
        photo,
      });
    }
    const at = new Date();
    const numero = data.c.numero ?? commandeId.slice(0, 8);
    const pdf = await transfertPdf({
      emetteur: data.emetteur,
      numero,
      client: data.c.client,
      statut: ORDER_STATUS[data.c.statut] ?? data.c.statut,
      demandeLe: new Date(data.c.created_at),
      demandePar: data.c.demandeur,
      datePrevue: data.c.date_confirmee ?? data.c.date_souhaitee,
      creneau: data.c.date_confirmee ? data.c.creneau_confirme : null,
      depart: { site: data.c.projet, adresse: data.c.adresse?.libelle ?? null },
      arrivee: { site: data.c.dest, adresse: data.c.destination?.libelle ?? null },
      contact: data.c.contact_site,
      genereLe: at,
      biens,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="bon-transfert-${numero}-${parisClock(at).date}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  }
}

const ActivityQuery = z.object({
  /** curseur opaque rendu par la page précédente : instant (à la microseconde) et clé de la dernière activité */
  avant: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z~[\w:-]{1,80}$/)
    .optional(),
  limite: z.coerce.number().int().min(1).max(100).default(50),
  filtre: z.enum(['tout', 'stock', 'demandes', 'documents']).default('tout'),
});

/** Mouvements qui intéressent le client : entrées, sorties, retours et corrections, pas les rangements internes. */
const MOVES: Record<string, string> = {
  RECEPTION: 'Arrivé au dépôt',
  CHARGEMENT: 'Parti du dépôt ou d’un site',
  LIVRAISON: 'Livré',
  RETOUR: 'Revenu au dépôt',
  AJUSTEMENT: 'Correction d’inventaire',
};
const BL: Record<string, string> = { LIVRAISON: 'Bon de livraison signé', ENLEVEMENT: 'Bon d’enlèvement signé', RETRAIT: 'Bon de retrait signé', REFUS: 'Livraison refusée' };
const TYPE: Record<string, string> = { LIVRAISON: 'livraison', RETRAIT: 'retrait au dépôt', COLLECTE: 'collecte' };

/**
 * Activités (compte rendu Adam, points 1 et 6) : le fil de tout ce qui s'est passé sur le stock du client, du plus
 * récent au plus ancien : biens entrés, livrés, revenus, demandes faites, documents signés. RLS : un B2B Utilisateur
 * ne voit que ses projets.
 */
@Controller('me/activites')
export class ActivitiesController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

  @Get()
  @RequirePermission('inventory.read')
  list(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    if (!isClientRole(user.role) || !user.entrepriseId) throw forbidden('Réservé aux comptes clients');
    const q = ActivityQuery.parse(query);
    const [avant, avantCle] = q.avant ? (q.avant.split('~') as [string, string]) : [new Date(Date.now() + 60_000).toISOString(), '~'];
    return this.db.tx(ctxOf(user), async (tx) => {
      const parts: string[] = [];
      if (q.filtre === 'tout' || q.filtre === 'stock') {
        parts.push(`SELECT 'MOUVEMENT' AS genre, m.type::text AS sous_type, m.horodatage_serveur AS le, a.id AS article_id, coalesce(a.nom_client, a.libelle) AS libelle,
                           a.qr_code AS qr, p.nom AS projet, NULL::uuid AS commande_id, NULL::text AS numero, m.motif AS detail, m.id::text AS cle,
                           (SELECT ph.id FROM photo ph WHERE ph.article_id = a.id AND ph.televersee ORDER BY ph.prise_le, ph.id LIMIT 1) AS photo
                      FROM mouvement m JOIN article a ON a.id = m.article_id LEFT JOIN projet p ON p.id = a.projet_id
                     WHERE a.entreprise_id = $1 AND m.type IN ('RECEPTION','CHARGEMENT','LIVRAISON','RETOUR','AJUSTEMENT') AND m.horodatage_serveur <= $2`);
      }
      if (q.filtre === 'tout' || q.filtre === 'demandes') {
        parts.push(`SELECT 'DEMANDE', c.type::text || coalesce(':' || c.nature_collecte::text, ''), c.created_at, NULL::uuid, NULL::text, NULL::text, p.nom, c.id, c.numero,
                           (SELECT count(*)::text FROM ligne_commande l WHERE l.commande_id = c.id), c.id::text, NULL::uuid
                      FROM commande c LEFT JOIN projet p ON p.id = c.projet_id
                     WHERE c.entreprise_id = $1 AND c.statut <> 'BROUILLON' AND c.created_at <= $2`);
      }
      if (q.filtre === 'tout' || q.filtre === 'documents') {
        parts.push(`SELECT 'DOCUMENT', b.type::text, b.signe_le, NULL::uuid, NULL::text, b.numero, p.nom, b.commande_id, c.numero, b.signataire_nom, b.id::text, NULL::uuid
                      FROM bon_de_livraison b LEFT JOIN commande c ON c.id = b.commande_id LEFT JOIN projet p ON p.id = c.projet_id
                     WHERE b.entreprise_id = $1 AND b.signe_le IS NOT NULL AND b.signe_le <= $2 AND (c.id IS NOT NULL OR $3::text <> 'B2B_USER')`);
      }
      const r = await tx.query<{
        genre: 'MOUVEMENT' | 'DEMANDE' | 'DOCUMENT';
        sous_type: string;
        le: Date;
        article_id: string | null;
        libelle: string | null;
        qr: string | null;
        projet: string | null;
        commande_id: string | null;
        numero: string | null;
        detail: string | null;
        cle: string;
        photo: string | null;
        curseur: string;
      }>(`SELECT *, to_char(le AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '~' || x.genre || ':' || cle AS curseur FROM (${parts.join(' UNION ALL ')}) x
          WHERE $3::text IS NOT NULL AND (le < $2::timestamptz OR (le = $2::timestamptz AND (x.genre || ':' || cle) COLLATE "C" < $5::text COLLATE "C"))
          ORDER BY le DESC, (x.genre || ':' || cle) COLLATE "C" DESC LIMIT $4`,
        [user.entrepriseId, avant, user.role, q.limite, avantCle],
      );
      const items = r.rows.map((x) => {
        let titre: string;
        let texte: string | null = null;
        if (x.genre === 'MOUVEMENT') {
          titre = MOVES[x.sous_type] ?? x.sous_type;
          texte = x.detail;
        } else if (x.genre === 'DEMANDE') {
          const [type, nature] = x.sous_type.split(':');
          titre = nature === 'TRANSFERT' ? 'Transfert de site à site demandé' : nature === 'RETOUR' ? 'Retour au dépôt demandé' : `Demande de ${TYPE[type!] ?? type}`;
          const n = Number(x.detail ?? 0);
          texte = n ? `${n} bien${n > 1 ? 's' : ''}` : null;
        } else {
          titre = BL[x.sous_type] ?? 'Document signé';
          texte = x.detail ? `Signé par ${x.detail}` : null;
        }
        return {
          id: `${x.genre}:${x.cle}`,
          genre: x.genre,
          le: x.le,
          titre,
          texte,
          article: x.article_id ? { id: x.article_id, libelle: x.libelle, qr: x.qr } : null,
          commande: x.commande_id ? { id: x.commande_id, numero: x.numero } : null,
          document: x.genre === 'DOCUMENT' ? { id: x.cle, numero: x.libelle } : null,
          projet: x.projet,
          vignette: x.photo ? this.files.photoUrl(user.tenantId, x.photo, 't') : null,
        };
      });
      return { items, suivant: items.length === q.limite ? r.rows[r.rows.length - 1]!.curseur : null };
    });
  }
}
