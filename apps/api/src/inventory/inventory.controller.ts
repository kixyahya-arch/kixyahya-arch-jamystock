import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { ARTICLE_CONDITIONS, ARTICLE_STATUSES } from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { notFound } from '../common/errors.js';
import { FilesService } from '../files/files.service.js';

const ListQuery = z.object({
  projet: z.string().uuid().optional(),
  depot: z.string().uuid().optional(),
  categorie: z.string().uuid().optional(),
  etat: z.enum(ARTICLE_CONDITIONS).optional(),
  statut: z.enum(ARTICLE_STATUSES).optional(),
  entreDu: z.string().date().optional(),
  entreAu: z.string().date().optional(),
  q: z.string().trim().min(1).max(100).optional(),
  /** pagination par curseur (id UUID v7, donc ordre chronologique) — lots de 48 (INV-01) */
  apres: z.string().uuid().optional(),
  limite: z.coerce.number().int().min(1).max(200).default(48),
});

/**
 * Module INV : l'isolation entre clients et projets est faite par la RLS (le contexte de la transaction),
 * la requête n'ajoute aucun filtre d'entreprise.
 */
@Controller('articles')
export class InventoryController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

  @Get()
  @RequirePermission('inventory.read')
  async list(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = ListQuery.parse(query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.projet) add('a.projet_id = ?', q.projet);
    if (q.categorie) add('a.categorie_id = ?', q.categorie);
    if (q.etat) add('a.etat = ?', q.etat);
    if (q.statut) add('a.statut = ?', q.statut);
    else where.push(`a.statut NOT IN ('RESTITUE','PERDU','DETRUIT')`);
    if (q.entreDu) add('a.date_entree >= ?::date', q.entreDu);
    if (q.entreAu) add(`a.date_entree < (?::date + 1)`, q.entreAu);
    if (q.depot) add('z.depot_id = ?', q.depot);
    if (q.q) {
      // INV-03 : plein texte + tolérance aux fautes (trigrammes) : « bureaux » trouve « bureau »
      params.push(q.q);
      const p = `$${params.length}`;
      where.push(`(a.recherche @@ plainto_tsquery('simple', ${p})
        OR ${p} <% (coalesce(a.libelle,'') || ' ' || coalesce(a.nom_client,'') || ' ' || coalesce(a.description,''))
        OR c.nom ILIKE '%' || ${p} || '%')`);
    }
    const baseWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = `FROM article a
      LEFT JOIN emplacement e ON e.id = a.emplacement_courant_id
      LEFT JOIN zone z ON z.id = e.zone_id
      LEFT JOIN categorie c ON c.id = a.categorie_id`;

    return this.db.tx(ctxOf(user), async (tx) => {
      const count = await tx.query<{ n: number }>(`SELECT count(*)::int AS n ${from} ${baseWhere}`, params);
      const pageParams = [...params];
      let pageWhere = baseWhere;
      if (q.apres) {
        pageParams.push(q.apres);
        pageWhere = `${baseWhere ? `${baseWhere} AND` : 'WHERE'} a.id < $${pageParams.length}`;
      }
      pageParams.push(q.limite);
      const rows = await tx.query(
        `SELECT a.id, a.qr_code AS "qrCode", a.libelle, a.nom_client AS "nomClient", a.statut, a.etat,
                a.projet_id AS "projetId", c.nom AS categorie, e.chemin AS localisation, a.date_entree AS "dateEntree",
                (SELECT p.id FROM photo p WHERE p.article_id = a.id AND p.televersee ORDER BY p.prise_le LIMIT 1) AS "photoId",
                EXISTS (SELECT 1 FROM ligne_commande lc WHERE lc.article_id = a.id AND lc.active) AS "engage"
           ${from} ${pageWhere}
          ORDER BY a.id DESC LIMIT $${pageParams.length}`,
        pageParams,
      );
      // liens signés à la place des clés de stockage (§7.3)
      const items = rows.rows.map(({ photoId, ...r }: Record<string, unknown>) => ({
        ...r,
        vignette: photoId ? this.files.photoUrl(user.tenantId, photoId as string, 't') : null,
      }));
      return {
        total: count.rows[0]!.n,
        items,
        suivant: items.length === q.limite ? (rows.rows[rows.rows.length - 1] as { id: string }).id : null,
      };
    });
  }

  @Get(':id')
  @RequirePermission('inventory.read')
  async get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    z.string().uuid().parse(id);
    return this.db.tx(ctxOf(user), async (tx) => {
      const a = await tx.query(
        `SELECT a.*, c.nom AS categorie, e.chemin AS localisation, p.nom AS projet
           FROM article a
           LEFT JOIN categorie c ON c.id = a.categorie_id
           LEFT JOIN emplacement e ON e.id = a.emplacement_courant_id
           LEFT JOIN projet p ON p.id = a.projet_id
          WHERE a.id = $1`,
        [id],
      );
      if (!a.rows[0]) throw notFound('Article');
      const photos = await tx.query(
        `SELECT id, contexte, prise_le AS "priseLe", televersee FROM photo WHERE article_id = $1 ORDER BY prise_le`,
        [id],
      );
      const mouvements = await tx.query(
        `SELECT m.id, m.type, m.horodatage_serveur AS le, de.chemin AS de, vers.chemin AS vers, m.statut_apres AS statut, m.motif
           FROM mouvement m
           LEFT JOIN emplacement de ON de.id = m.de_emplacement_id
           LEFT JOIN emplacement vers ON vers.id = m.vers_emplacement_id
          WHERE m.article_id = $1 ORDER BY m.horodatage_serveur DESC, m.horodatage_terminal DESC, m.id DESC`,
        [id],
      );
      const { recherche: _r, ...article } = a.rows[0] as Record<string, unknown>;
      // une photo déclarée par le terminal mais pas encore téléversée est listée, sans lien
      const withUrls = photos.rows.map(({ televersee, ...p }: { id: string; televersee: boolean }) =>
        televersee ? { ...p, disponible: true, ...this.files.photoUrls(user.tenantId, p.id) } : { ...p, disponible: false },
      );
      return { ...article, photos: withUrls, mouvements: mouvements.rows };
    });
  }
}
