import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import sharp from 'sharp';
import { addIsoDays, isClientRole, parisClock, uuidv7 } from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { conflict, forbidden, notFound, unprocessable } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { StorageService } from '../storage/storage.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { inventoryPdf } from '../billing/pdf.js';
import { ListQuery, articleFilter, type ArticleQuery } from './inventory.controller.js';

const uuid = z.string().uuid();
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v || null));

const AnnotationBody = z.object({
  nomClient: optText(120),
  referenceInterne: optText(60),
  categorieClient: optText(60),
  noteClient: optText(1000),
});

const RequestBody = z.object({
  type: z.enum(['PHOTO', 'CONSTAT']),
  message: z.string().trim().min(3, 'Précisez votre demande (3 caractères minimum)').max(500),
});

/** Plafond d'un export : au-delà, l'export est découpé par projet ou par filtre. */
const MAX_EXPORT = 3000;

const ETAT: Record<string, string> = { NEUF: 'Neuf', BON: 'Bon état', USE: 'Usé', ENDOMMAGE: 'Endommagé' };
const STATUT: Record<string, string> = {
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

interface ExportRow {
  id: string;
  qr_code: string;
  libelle: string;
  nom_client: string | null;
  reference_interne: string | null;
  categorie: string | null;
  categorie_client: string | null;
  note_client: string | null;
  projet: string | null;
  etat: string;
  statut: string;
  localisation: string | null;
  longueur_m: number | null;
  largeur_m: number | null;
  hauteur_m: number | null;
  poids_kg: number | null;
  date_entree: string | null;
  photo: string | null;
}

/** Lignes d'un export, sous la RLS de l'utilisateur : un utilisateur B2B ne voit que ses projets. */
async function exportRows(tx: Tx, q: ArticleQuery): Promise<ExportRow[]> {
  const { from, baseWhere, params } = articleFilter(q);
  const r = await tx.query<ExportRow>(
    `SELECT a.id, a.qr_code, a.libelle, a.nom_client, a.reference_interne, c.nom AS categorie, a.categorie_client, a.note_client,
            p.nom AS projet, a.etat, a.statut, e.chemin AS localisation, a.longueur_m::float AS longueur_m, a.largeur_m::float AS largeur_m,
            a.hauteur_m::float AS hauteur_m, a.poids_kg::float AS poids_kg, to_char(a.date_entree AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS date_entree,
            (SELECT ph.id FROM photo ph WHERE ph.article_id = a.id AND ph.televersee ORDER BY ph.prise_le LIMIT 1) AS photo
       ${from} LEFT JOIN projet p ON p.id = a.projet_id ${baseWhere}
      ORDER BY p.nom NULLS LAST, coalesce(a.nom_client, a.libelle), a.qr_code
      LIMIT ${MAX_EXPORT + 1}`,
    params,
  );
  if (r.rows.length > MAX_EXPORT) throw unprocessable('EXPORT_TROP_GRAND', `Plus de ${MAX_EXPORT} biens : filtrez par projet ou par catégorie avant d’exporter`);
  return r.rows;
}

const dims = (a: Pick<ExportRow, 'longueur_m' | 'largeur_m' | 'hauteur_m'>) =>
  a.longueur_m && a.largeur_m ? `${[a.longueur_m, a.largeur_m, a.hauteur_m].filter((v) => v != null).map((v) => v!.toLocaleString('fr-FR')).join(' × ')} m` : null;

/** Libellés lisibles des filtres appliqués, rappelés en tête du PDF. */
async function describeFilters(tx: Tx, q: ArticleQuery): Promise<string[]> {
  const out: string[] = [];
  if (q.projet) out.push(`Projet : ${(await tx.query<{ nom: string }>('SELECT nom FROM projet WHERE id = $1', [q.projet])).rows[0]?.nom ?? '—'}`);
  if (q.categorie) out.push(`Catégorie : ${(await tx.query<{ nom: string }>('SELECT nom FROM categorie WHERE id = $1', [q.categorie])).rows[0]?.nom ?? '—'}`);
  if (q.categorieClient) out.push(`Catégorie : ${q.categorieClient}`);
  if (q.etat) out.push(`État : ${ETAT[q.etat] ?? q.etat}`);
  if (q.statut) out.push(`Statut : ${STATUT[q.statut] ?? q.statut}`);
  if (q.q) out.push(`Recherche : « ${q.q} »`);
  if (q.entreDu || q.entreAu) out.push(`Entrés ${q.entreDu ? `depuis le ${q.entreDu}` : ''}${q.entreAu ? ` jusqu’au ${q.entreAu}` : ''}`.trim());
  return out;
}

const CLIENT_ONLY = (user: AuthUser) => {
  if (!isClientRole(user.role)) throw forbidden('Réservé aux utilisateurs clients');
};

/** Filtres d'un export : ceux de la liste, sans la pagination. */
const ExportQuery = ListQuery.omit({ apres: true, limite: true, client: true, depot: true });

/**
 * INV-05 : export PDF illustré préparé en tâche de fond. Le client est prévenu (notification et e-mail) quand il est prêt ;
 * le fichier reste téléchargeable 7 jours.
 */
@Injectable()
export class InventoryExportService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  async process(user: AuthUser, id: string): Promise<void> {
    try {
      const job = await this.db.tx(ctxOf(user), async (tx) => {
        const j = (await tx.query<{ filtres: ArticleQuery; entreprise: string | null }>(
          `SELECT x.filtres, e.nom AS entreprise FROM export_inventaire x LEFT JOIN entreprise e ON e.id = x.entreprise_id WHERE x.id = $1 AND x.statut = 'EN_COURS'`,
          [id],
        )).rows[0];
        if (!j) return null;
        const rows = await exportRows(tx, j.filtres);
        const photos = await tx.query<{ id: string; o: string; m: string | null; t: string | null }>(
          'SELECT id, cle_originale AS o, cle_moyenne AS m, cle_vignette AS t FROM photo WHERE id = ANY($1)',
          [rows.map((r) => r.photo).filter(Boolean)],
        );
        const issuer = (await tx.query<{ raison_sociale: string }>('SELECT raison_sociale FROM organisation WHERE id = app_tenant()')).rows[0]?.raison_sociale ?? 'JAMYSTOCK';
        return { rows, photos: new Map(photos.rows.map((p) => [p.id, p.t ?? p.m ?? p.o])), client: j.entreprise ?? 'Client', filtres: await describeFilters(tx, j.filtres), issuer };
      });
      if (!job) return;
      // vignettes converties en JPEG 160 px, une à la fois pour ne pas saturer la mémoire du petit serveur
      const articles = [];
      for (const r of job.rows) {
        let vignette: Buffer | null = null;
        const key = r.photo ? job.photos.get(r.photo) : undefined;
        if (key) {
          vignette = await this.storage
            .get(key)
            .then((b) => sharp(b).rotate().resize(160, 160, { fit: 'cover' }).jpeg({ quality: 72 }).toBuffer())
            .catch(() => null);
        }
        articles.push({
          qrCode: r.qr_code,
          libelle: r.libelle,
          nomClient: r.nom_client,
          referenceInterne: r.reference_interne,
          categorie: r.categorie_client ?? r.categorie,
          projet: r.projet,
          etat: ETAT[r.etat] ?? r.etat,
          statut: STATUT[r.statut] ?? r.statut,
          dimensions: dims(r),
          dateEntree: r.date_entree,
          note: r.note_client,
          vignette,
        });
      }
      const at = new Date();
      const pdf = await inventoryPdf({ emetteur: job.issuer, client: job.client, filtres: job.filtres, genereLe: at, articles });
      const key = `${user.tenantId}/exports/${id}.pdf`;
      await this.storage.put(key, pdf);
      await this.db.tx(ctxOf(user), async (tx) => {
        await tx.query(`UPDATE export_inventaire SET statut = 'PRET', cle = $2, nb_articles = $3, pret_le = $4 WHERE id = $1`, [id, key, articles.length, at]);
        await tx.query(`INSERT INTO notification (id, tenant_id, destinataire_id, canal, modele, variables) VALUES ($1,$2,$3,'IN_APP','EXPORT_PRET',$4)`, [
          uuidv7(), user.tenantId, user.id, JSON.stringify({ exportId: id, nbArticles: articles.length }),
        ]);
        await NotificationsService.enqueue(tx, user.tenantId, { modele: 'EXPORT_PRET', destinataireId: user.id, variables: { exportId: id, nbArticles: articles.length } });
      });
    } catch (e) {
      await this.db
        .tx(ctxOf(user), (tx) => tx.query(`UPDATE export_inventaire SET statut = 'ECHEC', erreur = $2 WHERE id = $1`, [id, (e as Error).message.slice(0, 300)]))
        .catch(() => undefined);
    }
  }
}

/** INV-05 : exports de l'inventaire du client, filtrés comme la vue courante. */
@Controller('me/inventory')
export class ClientInventoryController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(InventoryExportService) private readonly exports: InventoryExportService,
  ) {}

  /** Catégories propres au client déjà utilisées (filtre et suggestions de saisie). */
  @Get('categories')
  @RequirePermission('inventory.read')
  categories(@CurrentUser() user: AuthUser) {
    return this.db.tx(ctxOf(user), async (tx) => ({
      items: (
        await tx.query<{ nom: string; n: number }>(
          `SELECT categorie_client AS nom, count(*)::int AS n FROM article
            WHERE categorie_client IS NOT NULL AND statut NOT IN ('RESTITUE','PERDU','DETRUIT') GROUP BY 1 ORDER BY 1`,
        )
      ).rows,
    }));
  }

  /** CSV immédiat (séparateur point-virgule, BOM : s'ouvre tel quel dans Excel). */
  @Get('export.csv')
  @RequirePermission('inventory.read')
  async csv(@CurrentUser() user: AuthUser, @Query() query: unknown, @Res() res: Response) {
    CLIENT_ONLY(user);
    const q = ExportQuery.parse(query) as ArticleQuery;
    const rows = await this.db.tx(ctxOf(user), (tx) => exportRows(tx, q));
    const cell = (v: unknown) => {
      const s = v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v);
      return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const head = ['QR', 'Libellé dépôt', 'Nom client', 'Référence interne', 'Catégorie', 'Catégorie client', 'Projet', 'État', 'Statut', 'Emplacement', 'Longueur (m)', 'Largeur (m)', 'Hauteur (m)', 'Poids (kg)', 'Entré le', 'Note'];
    const lines = rows.map((r) =>
      [r.qr_code, r.libelle, r.nom_client, r.reference_interne, r.categorie, r.categorie_client, r.projet, ETAT[r.etat] ?? r.etat, STATUT[r.statut] ?? r.statut, r.localisation, r.longueur_m, r.largeur_m, r.hauteur_m, r.poids_kg, r.date_entree, r.note_client]
        .map(cell)
        .join(';'),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inventaire-${parisClock(new Date()).date}.csv"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(`﻿${[head.join(';'), ...lines].join('\r\n')}\r\n`);
  }

  /** Lance un PDF illustré en tâche de fond ; la réponse arrive tout de suite. */
  @Post('exports')
  @HttpCode(202)
  @RequirePermission('inventory.read')
  async startPdf(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    CLIENT_ONLY(user);
    const q = ExportQuery.parse(body ?? {}) as ArticleQuery;
    const id = uuidv7();
    await this.db.tx(ctxOf(user), async (tx) => {
      const running = await tx.query(`SELECT 1 FROM export_inventaire WHERE utilisateur_id = $1 AND statut = 'EN_COURS' AND cree_le > now() - interval '10 minutes'`, [user.id]);
      if (running.rowCount) throw conflict('EXPORT_EN_COURS', 'Un export est déjà en préparation : il sera prêt dans un instant');
      await exportRows(tx, q); // contrôle de taille avant de lancer
      await tx.query(`INSERT INTO export_inventaire (id, tenant_id, entreprise_id, utilisateur_id, format, filtres) VALUES ($1,$2,$3,$4,'PDF',$5)`, [
        id, user.tenantId, user.entrepriseId, user.id, JSON.stringify(q),
      ]);
    });
    void this.exports.process(user, id);
    return { id, statut: 'EN_COURS' };
  }

  @Get('exports')
  @RequirePermission('inventory.read')
  list(@CurrentUser() user: AuthUser) {
    return this.db.tx(ctxOf(user), async (tx) => {
      // un export resté « en cours » plus de 10 minutes a été interrompu (redémarrage du service)
      await tx.query(`UPDATE export_inventaire SET statut = 'ECHEC', erreur = 'Interrompu' WHERE utilisateur_id = $1 AND statut = 'EN_COURS' AND cree_le < now() - interval '10 minutes'`, [user.id]);
      const r = await tx.query(
        `SELECT id, statut, nb_articles AS "nbArticles", cree_le AS "creeLe", pret_le AS "pretLe", expire_le AS "expireLe"
           FROM export_inventaire WHERE utilisateur_id = $1 AND expire_le > now() ORDER BY cree_le DESC LIMIT 5`,
        [user.id],
      );
      return { items: r.rows };
    });
  }

  @Get('exports/:id/file')
  @RequirePermission('inventory.read')
  async file(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res() res: Response) {
    const x = await this.db.tx(ctxOf(user), (tx) =>
      tx.query<{ cle: string | null; statut: string; cree_le: Date }>(`SELECT cle, statut, cree_le FROM export_inventaire WHERE id = $1 AND expire_le > now()`, [uuid.parse(id)]),
    );
    const row = x.rows[0];
    if (!row || row.statut !== 'PRET' || !row.cle) throw notFound('Export');
    const data = await this.storage.get(row.cle);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="inventaire-${parisClock(row.cree_le).date}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(data);
  }
}

/** Prochain jour ouvré (lundi à vendredi). */
function nextWorkingDay(today: string): string {
  let d = addIsoDays(today, 1);
  while ([0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay())) d = addIsoDays(d, 1);
  return d;
}

/** INV-06 (annotations) et INV-07 (photo ou constat à la demande) sur un bien du client. */
@Controller('articles')
export class ArticleClientController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Le client renomme, référence, recatégorise et annote ses biens ; le libellé du dépôt ne change pas. */
  @Put(':id/annotation')
  @RequirePermission('inventory.read')
  annotate(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    CLIENT_ONLY(user);
    const aid = uuid.parse(id);
    const b = AnnotationBody.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const before = (
        await tx.query<{ nom_client: string | null; reference_interne: string | null; categorie_client: string | null; note_client: string | null; entreprise_id: string }>(
          'SELECT nom_client, reference_interne, categorie_client, note_client, entreprise_id FROM article WHERE id = $1 FOR UPDATE',
          [aid],
        )
      ).rows[0];
      if (!before) throw notFound('Article');
      const next = {
        nom_client: b.nomClient === undefined ? before.nom_client : b.nomClient,
        reference_interne: b.referenceInterne === undefined ? before.reference_interne : b.referenceInterne,
        categorie_client: b.categorieClient === undefined ? before.categorie_client : b.categorieClient,
        note_client: b.noteClient === undefined ? before.note_client : b.noteClient,
      };
      // seules ces quatre colonnes sont modifiables par le client
      await tx.query(
        `UPDATE article SET nom_client = $2, reference_interne = $3, categorie_client = $4, note_client = $5, annote_le = now(), annote_par = $6, updated_at = now() WHERE id = $1`,
        [aid, next.nom_client, next.reference_interne, next.categorie_client, next.note_client, user.id],
      );
      const { entreprise_id, ...avant } = before;
      await this.audit.record(tx, user, { action: 'ARTICLE_ANNOTE', objet: 'article', objetId: aid, entrepriseId: entreprise_id, avant, apres: next });
      return { nomClient: next.nom_client, referenceInterne: next.reference_interne, categorieClient: next.categorie_client, noteClient: next.note_client };
    });
  }

  /** INV-07 : demande de photo supplémentaire ou de constat d'état, traitée par un opérateur (micro-mission « Photo »). */
  @Post(':id/requests')
  @RequirePermission('inventory.read')
  async request(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    CLIENT_ONLY(user);
    const aid = uuid.parse(id);
    const b = RequestBody.parse(body);
    // le droit de voir le bien se vérifie sous la RLS du client
    const a = (
      await this.db.tx(ctxOf(user), (tx) =>
        tx.query<{ libelle: string; nom_client: string | null; statut: string; entreprise_id: string; depot_id: string | null }>(
          `SELECT a.libelle, a.nom_client, a.statut, a.entreprise_id, z.depot_id
             FROM article a LEFT JOIN emplacement e ON e.id = a.emplacement_courant_id LEFT JOIN zone z ON z.id = e.zone_id WHERE a.id = $1`,
          [aid],
        ),
      )
    ).rows[0];
    if (!a) throw notFound('Article');
    if (!['EN_STOCK', 'RESERVE'].includes(a.statut)) throw conflict('PAS_AU_DEPOT', 'Ce bien n’est pas au dépôt en ce moment');
    const day = nextWorkingDay(parisClock(new Date()).date);
    // les missions ne sont visibles que du personnel : la demande s'enregistre en contexte système
    return this.db.tx({ tenantId: user.tenantId, role: 'SYSTEM' }, async (tx) => {
      const open = await tx.query(`SELECT 1 FROM mission WHERE type = 'PHOTO' AND donnees->>'articleId' = $1 AND statut IN ('A_AFFECTER','AFFECTEE','EN_COURS')`, [aid]);
      if (open.rowCount) throw conflict('DEMANDE_EN_COURS', 'Une demande est déjà en cours pour ce bien : la photo arrive bientôt');
      const missionId = uuidv7();
      await tx.query(
        `INSERT INTO mission (id, tenant_id, depot_id, type, debut_prevu, donnees)
         VALUES ($1,$2,$3,'PHOTO', ($4::date + time '10:00') AT TIME ZONE 'Europe/Paris', $5)`,
        [missionId, user.tenantId, a.depot_id, day, JSON.stringify({ articleId: aid, entrepriseId: a.entreprise_id, demande: b.type, message: b.message, demandeurId: user.id })],
      );
      await tx.query(
        `INSERT INTO notification (id, tenant_id, destinataire_id, canal, modele, variables)
         SELECT gen_random_uuid(), $1, u.id, 'IN_APP', 'DEMANDE_PHOTO', $2 FROM utilisateur u WHERE u.tenant_id = $1 AND u.role IN ('DISPATCHER','SUPER_ADMIN') AND u.statut = 'ACTIF'`,
        [user.tenantId, JSON.stringify({ missionId, articleId: aid, demande: b.type })],
      );
      await tx.query(
        `INSERT INTO journal_audit (id, tenant_id, entreprise_id, acteur_id, action, objet, objet_id, apres) VALUES ($1,$2,$3,$4,'DEMANDE_PHOTO','article',$5,$6)`,
        [uuidv7(), user.tenantId, a.entreprise_id, user.id, aid, JSON.stringify({ missionId, demande: b.type, message: b.message })],
      );
      return { id: missionId, statut: 'A_AFFECTER', prevueLe: day };
    });
  }

  /** Demandes du client sur ce bien (en cours et traitées). */
  @Get(':id/requests')
  @RequirePermission('inventory.read')
  async requests(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const aid = uuid.parse(id);
    const visible = await this.db.tx(ctxOf(user), (tx) => tx.query('SELECT 1 FROM article WHERE id = $1', [aid]));
    if (!visible.rowCount) throw notFound('Article');
    const r = await this.db.tx({ tenantId: user.tenantId, role: 'SYSTEM' }, (tx) =>
      tx.query(
        `SELECT id, statut, donnees->>'demande' AS demande, donnees->>'message' AS message, created_at AS "demandeeLe", fin_reelle AS "traiteeLe",
                donnees->>'commentaire' AS commentaire
           FROM mission WHERE type = 'PHOTO' AND donnees->>'articleId' = $1 AND statut <> 'ANNULEE' ORDER BY created_at DESC LIMIT 10`,
        [aid],
      ),
    );
    return { items: r.rows };
  }
}
