import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  AVERY_FORMATS,
  LOCATION_STATUSES,
  LOCATION_TYPES,
  STOCK_CORRECTIONS,
  ZEBRA_FORMATS,
  applyMovement,
  expandLocationPattern,
  generateQrCode,
  isValidLocationCode,
  normalizeCode,
  parseLocationCsv,
  parseQr,
  qrUrl,
  uuidv7,
  zplLabels,
  type ArticleStatus,
  type LabelContent,
  type LocationType,
  type StockCorrection,
} from '@jamystock/domain';
import { DATABASE } from '../common/tokens.js';
import type { Database, Tx } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { conflict, notFound, unprocessable } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { averySheetPdf, rollPdf } from './labels-pdf.js';

const uuid = z.string().uuid();
const motif = z.string().trim().min(3, 'Motif obligatoire (3 caractères minimum)').max(500);
const code = z
  .string()
  .transform(normalizeCode)
  .refine(isValidLocationCode, 'Code : lettres, chiffres et tirets, 40 caractères au plus');
const dim = z.number().min(0).max(1000).nullable().optional();

const DepotBody = z.object({
  nom: z.string().trim().min(2).max(120),
  code: code.refine((c) => c.length <= 6, 'Code dépôt : 6 caractères au plus (il préfixe chaque emplacement)'),
  adresse: z.string().trim().min(3).max(300).optional(),
  surfaceTotaleM2: z.number().min(0).max(1_000_000).nullable().optional(),
  capaciteMissionsJour: z.number().int().min(0).max(1000).nullable().optional(),
});
const DepotUpdate = DepotBody.omit({ code: true }).partial();

const ZoneBody = z.object({
  depotId: uuid,
  code: code.refine((c) => c.length <= 6, 'Code zone : 6 caractères au plus'),
  nom: z.string().trim().min(1).max(80),
  type: z.enum(['STOCKAGE', 'RECEPTION', 'EXPEDITION', 'QUARANTAINE']).default('STOCKAGE'),
});
const ZoneUpdate = ZoneBody.pick({ nom: true, type: true }).partial();

const Caracteristiques = z.object({
  type: z.enum(LOCATION_TYPES as [LocationType, ...LocationType[]]).default('SOL'),
  longueurM: dim,
  largeurM: dim,
  hauteurM: dim,
  surfaceM2: z.number().min(0).max(100_000).optional(),
  chargeMaxKg: z.number().min(0).max(100_000).nullable().optional(),
  statut: z.enum(LOCATION_STATUSES).default('ACTIF'),
});
const LocationBody = Caracteristiques.extend({
  zoneId: uuid,
  parentId: uuid.nullable().optional(),
  code,
  libelle: z.string().trim().min(1).max(80).optional(),
  /** false pour un nœud de regroupement (allée, travée) qui ne reçoit pas d'articles. */
  adressable: z.boolean().default(true),
});
const LocationUpdate = Caracteristiques.partial().extend({
  libelle: z.string().trim().min(1).max(80).optional(),
  /** Obligatoire quand on bloque ou met en maintenance un emplacement occupé. */
  motif: motif.optional(),
});
const GenerateBody = Caracteristiques.extend({
  zoneId: uuid,
  allees: z.string().max(40).optional(),
  niveaux: z.string().max(40).optional(),
  cases: z.string().min(1).max(40),
  template: z.string().max(60).optional(),
  dryRun: z.boolean().default(true),
});
const ImportBody = z.object({ csv: z.string().min(1).max(2_000_000), dryRun: z.boolean().default(true) });

const LabelsBody = z.object({
  kind: z.enum(['EMPLACEMENT', 'ARTICLE', 'UM', 'VIERGE']),
  ids: z.array(uuid).max(2000).default([]),
  /** Pour VIERGE : un lot de QR pré-imprimés (labels/blank). */
  lot: z.string().trim().min(1).max(100).optional(),
  format: z.enum([...AVERY_FORMATS.map((f) => f.id), ...ZEBRA_FORMATS.map((f) => f.id)] as [string, ...string[]]),
  sortie: z.enum(['PDF', 'ZPL']).default('PDF'),
  /** Planche entamée : nombre d'étiquettes déjà utilisées en haut de la première planche. */
  skip: z.number().int().min(0).max(200).default(0),
  contours: z.boolean().default(false),
});

const CorrectionBody = z.object({
  action: z.enum(STOCK_CORRECTIONS as unknown as [StockCorrection, ...StockCorrection[]]),
  motif,
  /** Emplacement de destination (DEPLACER, RETROUVE, RETIRER_UM facultatif) : QR scanné ou code. */
  emplacement: z.string().trim().min(1).max(200).optional(),
  /** FUSIONNER_UM : QR de l'unité qui reçoit les articles. */
  umCible: z.string().trim().min(1).max(200).optional(),
});

interface LocRow {
  id: string;
  zone_id: string;
  code: string;
  chemin: string;
  statut: string;
  adressable: boolean;
  qr_code: string;
}

/** Statuts où un article occupe physiquement un emplacement du dépôt. */
const ON_SHELF: readonly ArticleStatus[] = ['EN_RECEPTION', 'EN_STOCK', 'RESERVE', 'EN_PREPARATION'];

/**
 * Dépôts, zones et emplacements (WMS-01, WMS-02), étiquettes QR (WMS-03) et corrections de stock (WMS-06).
 * Réservé au Super Admin (warehouse.manage) : le Dispatcher n'a pas accès aux paramètres dépôt (§2.2).
 */
@Controller('bo/warehouse')
export class WarehouseController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ dépôts

  @Get('depots')
  @RequirePermission('warehouse.manage')
  depots(@CurrentUser() user: AuthUser) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const r = await tx.query(
        `SELECT d.id, d.nom, d.code, d.adresse->>'libelle' AS adresse, d.surface_totale_m2::float AS "surfaceTotaleM2",
                d.capacite_missions_jour AS "capaciteMissionsJour",
                (SELECT count(*)::int FROM zone z WHERE z.depot_id = d.id) AS zones,
                (SELECT count(*)::int FROM emplacement e JOIN zone z ON z.id = e.zone_id WHERE z.depot_id = d.id AND e.adressable) AS emplacements,
                (SELECT count(*)::int FROM emplacement e JOIN zone z ON z.id = e.zone_id WHERE z.depot_id = d.id AND e.adressable AND e.statut <> 'ACTIF') AS indisponibles,
                (SELECT coalesce(sum(e.surface_m2), 0)::float FROM emplacement e JOIN zone z ON z.id = e.zone_id WHERE z.depot_id = d.id AND e.adressable) AS "surfaceEmplacementsM2",
                (SELECT count(*)::int FROM article a JOIN emplacement e ON e.id = a.emplacement_courant_id JOIN zone z ON z.id = e.zone_id
                  WHERE z.depot_id = d.id AND a.statut = ANY($1)) AS articles
           FROM depot d ORDER BY d.nom`,
        [ON_SHELF],
      );
      return { items: r.rows, formats: { avery: AVERY_FORMATS.map(({ id, nom }) => ({ id, nom })), zebra: ZEBRA_FORMATS } };
    });
  }

  @Post('depots')
  @RequirePermission('warehouse.manage')
  createDepot(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = DepotBody.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const id = uuidv7();
      await tx.query(
        `INSERT INTO depot (id, tenant_id, nom, code, adresse, surface_totale_m2, capacite_missions_jour, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, user.tenantId, b.nom, b.code, b.adresse ? JSON.stringify({ libelle: b.adresse }) : null, b.surfaceTotaleM2 ?? null, b.capaciteMissionsJour ?? null, user.id],
      );
      await this.audit.record(tx, user, { action: 'DEPOT_CREE', objet: 'depot', objetId: id, apres: b });
      return { id };
    });
  }

  @Put('depots/:id')
  @RequirePermission('warehouse.manage')
  updateDepot(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = DepotUpdate.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const d = (await tx.query<{ nom: string }>('SELECT nom FROM depot WHERE id = $1 FOR UPDATE', [uuid.parse(id)])).rows[0];
      if (!d) throw notFound('Dépôt');
      await tx.query(
        `UPDATE depot SET nom = coalesce($2, nom),
                adresse = CASE WHEN $3::text IS NULL THEN adresse ELSE jsonb_build_object('libelle', $3::text) END,
                surface_totale_m2 = CASE WHEN $4 THEN $5 ELSE surface_totale_m2 END,
                capacite_missions_jour = CASE WHEN $6 THEN $7 ELSE capacite_missions_jour END
          WHERE id = $1`,
        [id, b.nom ?? null, b.adresse ?? null, b.surfaceTotaleM2 !== undefined, b.surfaceTotaleM2 ?? null, b.capaciteMissionsJour !== undefined, b.capaciteMissionsJour ?? null],
      );
      if (b.nom && b.nom !== d.nom) await this.renamePrefix(tx, `${d.nom} > `, `${b.nom} > `, 'depot', id);
      await this.audit.record(tx, user, { action: 'DEPOT_MODIFIE', objet: 'depot', objetId: id, avant: d, apres: b });
      return { id };
    });
  }

  /** Arbre complet d'un dépôt : zones, nœuds de regroupement et emplacements, avec leur occupation. */
  @Get('depots/:id')
  @RequirePermission('warehouse.manage')
  depot(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const d = (
        await tx.query(
          `SELECT id, nom, code, adresse->>'libelle' AS adresse, surface_totale_m2::float AS "surfaceTotaleM2", capacite_missions_jour AS "capaciteMissionsJour"
             FROM depot WHERE id = $1`,
          [uuid.parse(id)],
        )
      ).rows[0];
      if (!d) throw notFound('Dépôt');
      const zones = await tx.query(`SELECT id, code, nom, type FROM zone WHERE depot_id = $1 ORDER BY code`, [id]);
      const locs = await tx.query(
        `SELECT e.id, e.zone_id AS "zoneId", e.parent_id AS "parentId", e.code, e.chemin, e.type, e.statut, e.adressable,
                e.longueur_m::float AS "longueurM", e.largeur_m::float AS "largeurM", e.hauteur_m::float AS "hauteurM",
                e.surface_m2::float AS "surfaceM2", e.charge_max_kg::float AS "chargeMaxKg", e.niveaux, e.qr_code AS "qrCode",
                (SELECT count(*)::int FROM article a WHERE a.emplacement_courant_id = e.id AND a.statut = ANY($2)) AS articles,
                (SELECT count(*)::int FROM unite_manutention u WHERE u.emplacement_courant_id = e.id AND u.actif) AS um
           FROM emplacement e JOIN zone z ON z.id = e.zone_id
          WHERE z.depot_id = $1
          ORDER BY e.code`,
        [id, ON_SHELF],
      );
      return { ...d, zones: zones.rows, emplacements: locs.rows };
    });
  }

  // ------------------------------------------------------------------ zones

  @Post('zones')
  @RequirePermission('warehouse.manage')
  createZone(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = ZoneBody.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      if (!(await tx.query('SELECT 1 FROM depot WHERE id = $1', [b.depotId])).rowCount) throw notFound('Dépôt');
      const dup = await tx.query('SELECT 1 FROM zone WHERE depot_id = $1 AND code = $2', [b.depotId, b.code]);
      if (dup.rowCount) throw conflict('CODE_EXISTANT', `La zone ${b.code} existe déjà dans ce dépôt`);
      const id = uuidv7();
      await tx.query('INSERT INTO zone (id, tenant_id, depot_id, code, nom, type, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
        id, user.tenantId, b.depotId, b.code, b.nom, b.type, user.id,
      ]);
      await this.audit.record(tx, user, { action: 'ZONE_CREEE', objet: 'zone', objetId: id, apres: b });
      return { id };
    });
  }

  @Put('zones/:id')
  @RequirePermission('warehouse.manage')
  updateZone(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = ZoneUpdate.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const z0 = (await tx.query<{ nom: string; depot: string; type: string }>(
        'SELECT z.nom, z.type, d.nom AS depot FROM zone z JOIN depot d ON d.id = z.depot_id WHERE z.id = $1 FOR UPDATE OF z',
        [uuid.parse(id)],
      )).rows[0];
      if (!z0) throw notFound('Zone');
      await tx.query('UPDATE zone SET nom = coalesce($2, nom), type = coalesce($3::type_zone, type) WHERE id = $1', [id, b.nom ?? null, b.type ?? null]);
      if (b.nom && b.nom !== z0.nom) await this.renamePrefix(tx, `${z0.depot} > ${z0.nom}`, `${z0.depot} > ${b.nom}`, 'zone', id);
      await this.audit.record(tx, user, { action: 'ZONE_MODIFIEE', objet: 'zone', objetId: id, avant: { nom: z0.nom, type: z0.type }, apres: b });
      return { id };
    });
  }

  @Delete('zones/:id')
  @RequirePermission('warehouse.manage')
  deleteZone(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const z0 = (await tx.query('SELECT id, code, nom FROM zone WHERE id = $1', [uuid.parse(id)])).rows[0];
      if (!z0) throw notFound('Zone');
      if ((await tx.query('SELECT 1 FROM emplacement WHERE zone_id = $1 LIMIT 1', [id])).rowCount) {
        throw conflict('ZONE_NON_VIDE', 'La zone contient des emplacements : supprimez-les ou bloquez-les d’abord');
      }
      await tx.query('DELETE FROM zone WHERE id = $1', [id]);
      await this.audit.record(tx, user, { action: 'ZONE_SUPPRIMEE', objet: 'zone', objetId: id, avant: z0 });
      return { ok: true };
    });
  }

  // ------------------------------------------------------------------ emplacements

  @Post('emplacements')
  @RequirePermission('warehouse.manage')
  createLocation(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = LocationBody.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const zone = await this.zoneOf(tx, b.zoneId);
      let prefix = `${zone.depot} > ${zone.nom}`;
      if (b.parentId) {
        const p = (await tx.query<{ chemin: string; zone_id: string }>('SELECT chemin, zone_id FROM emplacement WHERE id = $1', [b.parentId])).rows[0];
        if (!p || p.zone_id !== b.zoneId) throw unprocessable('PARENT_INVALIDE', 'Le parent doit appartenir à la même zone');
        prefix = p.chemin;
      }
      await this.assertFreeCodes(tx, [b.code]);
      const id = await this.insertLocation(tx, user, {
        zoneId: b.zoneId,
        parentId: b.parentId ?? null,
        code: b.code,
        chemin: `${prefix} > ${b.libelle ?? b.code}`,
        c: b,
        adressable: b.adressable,
      });
      await this.audit.record(tx, user, { action: 'EMPLACEMENT_CREE', objet: 'emplacement', objetId: id, apres: b });
      return { id };
    });
  }

  @Put('emplacements/:id')
  @RequirePermission('warehouse.manage')
  updateLocation(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = LocationUpdate.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const e = (
        await tx.query<{ statut: string; chemin: string; code: string; type: string; surface_m2: string; occupe: boolean }>(
          `SELECT e.statut, e.chemin, e.code, e.type, e.surface_m2,
                  EXISTS (SELECT 1 FROM article a WHERE a.emplacement_courant_id = e.id AND a.statut = ANY($2)) AS occupe
             FROM emplacement e WHERE e.id = $1 FOR UPDATE OF e`,
          [uuid.parse(id), ON_SHELF],
        )
      ).rows[0];
      if (!e) throw notFound('Emplacement');
      if (b.statut && b.statut !== 'ACTIF' && e.statut === 'ACTIF' && e.occupe && !b.motif) {
        throw unprocessable('MOTIF_OBLIGATOIRE', 'Emplacement occupé : indiquez un motif pour le bloquer ou le mettre en maintenance');
      }
      const surface = b.surfaceM2 ?? (b.longueurM != null && b.largeurM != null ? Math.round(b.longueurM * b.largeurM * 100) / 100 : undefined);
      await tx.query(
        `UPDATE emplacement SET
           type = coalesce($2::type_emplacement, type),
           longueur_m = CASE WHEN $3 THEN $4 ELSE longueur_m END,
           largeur_m = CASE WHEN $5 THEN $6 ELSE largeur_m END,
           hauteur_m = CASE WHEN $7 THEN $8 ELSE hauteur_m END,
           surface_m2 = coalesce($9, surface_m2),
           charge_max_kg = CASE WHEN $10 THEN $11 ELSE charge_max_kg END,
           statut = coalesce($12::statut_emplacement, statut)
         WHERE id = $1`,
        [
          id, b.type ?? null,
          b.longueurM !== undefined, b.longueurM ?? null,
          b.largeurM !== undefined, b.largeurM ?? null,
          b.hauteurM !== undefined, b.hauteurM ?? null,
          surface ?? null,
          b.chargeMaxKg !== undefined, b.chargeMaxKg ?? null,
          b.statut ?? null,
        ],
      );
      if (b.libelle) {
        const head = e.chemin.slice(0, e.chemin.lastIndexOf(' > '));
        await this.renamePrefix(tx, e.chemin, `${head} > ${b.libelle}`, 'emplacement', id);
      }
      const { motif: m, ...apres } = b;
      await this.audit.record(tx, user, {
        action: b.statut && b.statut !== e.statut ? `EMPLACEMENT_${b.statut}` : 'EMPLACEMENT_MODIFIE',
        objet: 'emplacement',
        objetId: id,
        avant: { statut: e.statut, type: e.type, surfaceM2: Number(e.surface_m2) },
        apres,
        motif: m ?? null,
      });
      return { id };
    });
  }

  /** Suppression d'un emplacement jamais utilisé ; sinon on le bloque (l'historique des mouvements y fait référence). */
  @Delete('emplacements/:id')
  @RequirePermission('warehouse.manage')
  deleteLocation(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const e = (await tx.query('SELECT id, code, chemin FROM emplacement WHERE id = $1', [uuid.parse(id)])).rows[0];
      if (!e) throw notFound('Emplacement');
      const used = await tx.query(
        `SELECT EXISTS (SELECT 1 FROM emplacement c WHERE c.parent_id = $1)
             OR EXISTS (SELECT 1 FROM article a WHERE a.emplacement_courant_id = $1)
             OR EXISTS (SELECT 1 FROM unite_manutention u WHERE u.emplacement_courant_id = $1)
             OR EXISTS (SELECT 1 FROM mouvement m WHERE m.de_emplacement_id = $1 OR m.vers_emplacement_id = $1) AS used`,
        [id],
      );
      if (used.rows[0].used) throw conflict('EMPLACEMENT_UTILISE', 'Emplacement déjà utilisé ou parent d’autres emplacements : bloquez-le plutôt que de le supprimer');
      await tx.query('DELETE FROM emplacement WHERE id = $1', [id]);
      await this.audit.record(tx, user, { action: 'EMPLACEMENT_SUPPRIME', objet: 'emplacement', objetId: id, avant: e });
      return { ok: true };
    });
  }

  /** WMS-02 : assistant de génération par motif. dryRun = aperçu (rien n'est écrit). */
  @Post('emplacements/generate')
  @RequirePermission('warehouse.manage')
  generate(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = GenerateBody.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const zone = await this.zoneOf(tx, b.zoneId);
      const r = expandLocationPattern({ depotCode: zone.depot_code, zoneCode: zone.code, allees: b.allees, niveaux: b.niveaux, cases: b.cases, template: b.template });
      if (!r.ok) throw unprocessable('MOTIF_INVALIDE', r.error);
      const existing = await this.existingCodes(tx, r.locations.map((l) => l.code));
      const prefix = `${zone.depot} > ${zone.nom}`;
      const preview = r.locations.map((l) => ({ code: l.code, chemin: [prefix, ...l.chemin].join(' > '), existe: existing.has(l.code) }));
      const surface = b.surfaceM2 ?? (b.longueurM != null && b.largeurM != null ? Math.round(b.longueurM * b.largeurM * 100) / 100 : 0);
      const result = { total: preview.length, nouveaux: preview.filter((p) => !p.existe).length, existants: existing.size, surfaceTotaleM2: 0, apercu: preview };
      result.surfaceTotaleM2 = Math.round(result.nouveaux * surface * 100) / 100;
      if (b.dryRun) return { ...result, apercu: preview.slice(0, 400), cree: 0 };
      if (!result.nouveaux) throw conflict('DEJA_CREES', 'Tous ces emplacements existent déjà');

      // nœud de regroupement par allée (non adressable), réutilisé s'il existe
      const parents = new Map<number, { id: string; chemin: string }>();
      const niveauxCount = b.niveaux ? (expandLocationPattern({ depotCode: 'X', zoneCode: 'X', cases: b.niveaux }) as { ok: true; locations: unknown[] }).locations?.length ?? 1 : 1;
      for (const a of new Set(r.locations.map((l) => l.allee).filter((x): x is number => x != null))) {
        const aCode = normalizeCode(`${zone.depot_code}-${zone.code}-${String(a).padStart(2, '0')}`);
        const found = (await tx.query<{ id: string; chemin: string }>('SELECT id, chemin FROM emplacement WHERE zone_id = $1 AND code = $2', [b.zoneId, aCode])).rows[0];
        if (found) parents.set(a, found);
        else {
          const chemin = `${prefix} > Allée ${a}`;
          const nid = await this.insertLocation(tx, user, {
            zoneId: b.zoneId,
            parentId: null,
            code: aCode,
            chemin,
            c: { type: b.type, statut: 'ACTIF', surfaceM2: 0 },
            adressable: false,
            niveaux: niveauxCount,
          });
          parents.set(a, { id: nid, chemin });
        }
      }
      let cree = 0;
      for (const l of r.locations) {
        if (existing.has(l.code)) continue;
        const parent = l.allee != null ? parents.get(l.allee)! : null;
        await this.insertLocation(tx, user, {
          zoneId: b.zoneId,
          parentId: parent?.id ?? null,
          code: l.code,
          chemin: [parent ? parent.chemin : prefix, ...(parent ? l.chemin.slice(1) : l.chemin)].join(' > '),
          c: { ...b, surfaceM2: surface },
          adressable: true,
          niveaux: niveauxCount,
        });
        cree++;
      }
      await this.audit.record(tx, user, {
        action: 'EMPLACEMENTS_GENERES',
        objet: 'zone',
        objetId: b.zoneId,
        apres: { allees: b.allees ?? null, niveaux: b.niveaux ?? null, cases: b.cases, template: b.template ?? null, type: b.type, cree },
      });
      return { ...result, apercu: preview.slice(0, 50), cree };
    });
  }

  /** WMS-02 : import CSV (zone;code;type;longueur_m;largeur_m;hauteur_m;surface_m2;charge_max_kg;statut;libelle). */
  @Post('depots/:id/import')
  @RequirePermission('warehouse.manage')
  importCsv(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = ImportBody.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const d = (await tx.query<{ nom: string }>('SELECT nom FROM depot WHERE id = $1', [uuid.parse(id)])).rows[0];
      if (!d) throw notFound('Dépôt');
      const parsed = parseLocationCsv(b.csv);
      if (parsed.rows.length > 5000) throw unprocessable('TROP_DE_LIGNES', '5 000 lignes au plus par import');
      const zones = new Map((await tx.query<{ id: string; code: string; nom: string }>('SELECT id, code, nom FROM zone WHERE depot_id = $1', [id])).rows.map((z) => [z.code, z]));
      const existing = await this.existingCodes(tx, parsed.rows.map((r) => r.code));
      const errors = [...parsed.errors];
      const valid = parsed.rows.filter((r) => {
        if (!zones.has(r.zone)) errors.push({ line: r.line, message: `zone « ${r.zone} » inconnue dans ce dépôt` });
        else if (existing.has(r.code)) errors.push({ line: r.line, message: `l’emplacement ${r.code} existe déjà` });
        else return true;
        return false;
      });
      errors.sort((a, x) => a.line - x.line);
      const out = { lignes: parsed.rows.length + parsed.errors.length, valides: valid.length, erreurs: errors.slice(0, 200), nbErreurs: errors.length, apercu: valid.slice(0, 200) };
      if (b.dryRun) return { ...out, cree: 0 };
      if (errors.length) throw unprocessable('IMPORT_INVALIDE', `${errors.length} ligne(s) en erreur : corrigez le fichier puis relancez l’import`);
      for (const r of valid) {
        const z0 = zones.get(r.zone)!;
        await this.insertLocation(tx, user, {
          zoneId: z0.id,
          parentId: null,
          code: r.code,
          chemin: `${d.nom} > ${z0.nom} > ${r.libelle ?? r.code}`,
          c: r,
          adressable: true,
        });
      }
      await this.audit.record(tx, user, { action: 'EMPLACEMENTS_IMPORTES', objet: 'depot', objetId: id, apres: { cree: valid.length } });
      return { ...out, cree: valid.length };
    });
  }

  // ------------------------------------------------------------------ étiquettes

  /** WMS-03 : planche A4 Avery (PDF) ou étiquettes thermiques Zebra (ZPL, ou PDF au format du rouleau). */
  @Post('labels')
  @HttpCode(200)
  @RequirePermission('warehouse.manage')
  async labels(@CurrentUser() user: AuthUser, @Body() body: unknown, @Res() res: Response) {
    const b = LabelsBody.parse(body);
    const labels = await this.db.tx(ctxOf(user), (tx) => this.labelContents(tx, b.kind, b.ids, b.lot));
    if (!labels.length) throw unprocessable('AUCUNE_ETIQUETTE', 'Aucune étiquette à imprimer');
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `etiquettes-${b.kind.toLowerCase()}-${stamp}`;
    res.setHeader('Cache-Control', 'private, no-store');
    const zebra = ZEBRA_FORMATS.find((f) => f.id === b.format);
    if (b.sortie === 'ZPL') {
      if (!zebra) throw unprocessable('FORMAT', 'Le ZPL est réservé aux formats Zebra');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${name}.zpl"`);
      res.send(zplLabels(labels, zebra.id));
      return;
    }
    const pdf = zebra ? await rollPdf(labels, zebra.id) : await averySheetPdf(labels, AVERY_FORMATS.find((f) => f.id === b.format)!, { skip: b.skip, outline: b.contours });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${name}.pdf"`);
    res.send(pdf);
  }

  // ------------------------------------------------------------------ corrections de stock (WMS-06)

  /** Fiche de correction : article, position, unité de manutention et historique complet des mouvements. */
  @Get('articles/:id')
  @RequirePermission('warehouse.manage')
  article(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const a = (
        await tx.query(
          `SELECT a.id, a.qr_code AS "qrCode", a.libelle, a.statut, a.etat, a.date_entree AS "dateEntree",
                  en.nom AS client, p.nom AS projet, c.nom AS categorie,
                  e.id AS "emplacementId", e.code AS "emplacementCode", e.chemin AS emplacement,
                  u.id AS "umId", u.qr_code AS "umQr", u.type AS "umType",
                  (SELECT count(*)::int FROM article x WHERE x.um_courante_id = u.id) AS "umArticles",
                  (SELECT id FROM photo ph WHERE ph.article_id = a.id AND ph.televersee ORDER BY ph.prise_le LIMIT 1) AS "photoId"
             FROM article a
             JOIN entreprise en ON en.id = a.entreprise_id
             LEFT JOIN projet p ON p.id = a.projet_id
             LEFT JOIN categorie c ON c.id = a.categorie_id
             LEFT JOIN emplacement e ON e.id = a.emplacement_courant_id
             LEFT JOIN unite_manutention u ON u.id = a.um_courante_id
            WHERE a.id = $1`,
          [uuid.parse(id)],
        )
      ).rows[0];
      if (!a) throw notFound('Article');
      const mouvements = await tx.query(
        `SELECT m.id, m.type, m.horodatage_serveur AS le, de.chemin AS de, vers.chemin AS vers, m.statut_avant AS "statutAvant",
                m.statut_apres AS "statutApres", m.motif, ut.nom AS auteur, m.applique
           FROM mouvement m
           LEFT JOIN emplacement de ON de.id = m.de_emplacement_id
           LEFT JOIN emplacement vers ON vers.id = m.vers_emplacement_id
           LEFT JOIN utilisateur ut ON ut.id = m.auteur_id
          WHERE m.article_id = $1 ORDER BY m.horodatage_serveur DESC, m.id DESC LIMIT 100`,
        [id],
      );
      return { ...a, mouvements: mouvements.rows };
    });
  }

  @Post('articles/:id/correction')
  @RequirePermission('warehouse.manage')
  correct(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = CorrectionBody.parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const a = (
        await tx.query<{ id: string; entreprise_id: string; statut: ArticleStatus; etat: string; emplacement_courant_id: string | null; um_courante_id: string | null; libelle: string }>(
          `SELECT id, entreprise_id, statut, etat, emplacement_courant_id, um_courante_id, libelle FROM article WHERE id = $1 FOR UPDATE`,
          [uuid.parse(id)],
        )
      ).rows[0];
      if (!a) throw notFound('Article');
      const at = new Date();
      const before = { statut: a.statut, etat: a.etat, emplacementId: a.emplacement_courant_id, umId: a.um_courante_id };

      if (b.action === 'FUSIONNER_UM') {
        if (!a.um_courante_id) throw unprocessable('SANS_UM', 'Cet article n’est dans aucune unité de manutention');
        if (!b.umCible) throw unprocessable('UM_CIBLE', 'Scannez l’unité qui reçoit les articles');
        return this.mergeUnits(tx, user, a.um_courante_id, b.umCible, b.motif, at);
      }

      let target: LocRow | null = null;
      if (b.emplacement) target = await this.locationByScan(tx, b.emplacement);
      let next: { statut: ArticleStatus; etat: string; emplacementId: string | null; umId: string | null };
      switch (b.action) {
        case 'DEPLACER': {
          if (!['EN_STOCK', 'RESERVE', 'EN_RECEPTION'].includes(a.statut)) throw conflict('STATUT', `Article ${a.statut} : il n’est pas en rayon`);
          if (!target) throw unprocessable('EMPLACEMENT_REQUIS', 'Indiquez l’emplacement de destination');
          if (target.id === a.emplacement_courant_id) throw unprocessable('MEME_EMPLACEMENT', 'L’article est déjà à cet emplacement');
          // un article déplacé seul quitte son unité de manutention (la palette reste où elle est)
          next = { statut: a.statut, etat: a.etat, emplacementId: target.id, umId: null };
          break;
        }
        case 'PERDU':
          if (!['EN_STOCK', 'RESERVE', 'EN_RECEPTION', 'EN_PREPARATION'].includes(a.statut)) throw conflict('STATUT', `Article ${a.statut} : impossible de le déclarer perdu`);
          next = { statut: 'PERDU', etat: a.etat, emplacementId: null, umId: null };
          break;
        case 'DETRUIT':
          if (!['EN_STOCK', 'PERDU', 'EN_RECEPTION'].includes(a.statut)) throw conflict('STATUT', `Article ${a.statut} : impossible de le déclarer détruit`);
          next = { statut: 'DETRUIT', etat: a.etat, emplacementId: null, umId: null };
          break;
        case 'RETROUVE':
          if (a.statut !== 'PERDU') throw conflict('STATUT', 'Seul un article déclaré perdu peut être retrouvé');
          if (!target) throw unprocessable('EMPLACEMENT_REQUIS', 'Indiquez où l’article a été retrouvé');
          next = { statut: 'EN_STOCK', etat: a.etat, emplacementId: target.id, umId: null };
          break;
        case 'ENDOMMAGE':
          if (a.etat === 'ENDOMMAGE') throw conflict('DEJA_ENDOMMAGE', 'Article déjà déclaré endommagé');
          next = { statut: a.statut, etat: 'ENDOMMAGE', emplacementId: a.emplacement_courant_id, umId: a.um_courante_id };
          break;
        case 'RETIRER_UM':
          if (!a.um_courante_id) throw unprocessable('SANS_UM', 'Cet article n’est dans aucune unité de manutention');
          next = { statut: a.statut, etat: a.etat, emplacementId: target?.id ?? a.emplacement_courant_id, umId: null };
          break;
        default:
          throw unprocessable('ACTION', 'Action inconnue');
      }
      if (target && next.emplacementId === target.id && (target.statut !== 'ACTIF' || !target.adressable)) {
        throw unprocessable('EMPLACEMENT_INACTIF', `L’emplacement ${target.code} n’est pas disponible (${target.adressable ? target.statut.toLowerCase() : 'regroupement'})`);
      }
      // la règle de mouvement du domaine reste la référence (statut autorisé, sortie de stock)
      applyMovement({ status: a.statut, locationId: a.emplacement_courant_id, unitId: a.um_courante_id }, { type: 'AJUSTEMENT', targetStatus: next.statut, toLocationId: next.emplacementId });
      await this.ajustement(tx, user, { articleId: a.id, umId: a.um_courante_id, de: a.emplacement_courant_id, vers: next.emplacementId, avant: a.statut, apres: next.statut, motif: `${labelOf(b.action)} : ${b.motif}`, at });
      await tx.query(
        `UPDATE article SET statut = $2, etat = $3, emplacement_courant_id = $4, um_courante_id = $5, dernier_mouvement_le = $6, dernier_mouvement_terminal = $6
          WHERE id = $1`,
        [a.id, next.statut, next.etat, next.emplacementId, next.umId, at],
      );
      if (a.um_courante_id && !next.umId) await this.closeEmptyUnit(tx, a.um_courante_id);
      await this.audit.record(tx, user, { action: `STOCK_${b.action}`, objet: 'article', objetId: a.id, entrepriseId: a.entreprise_id, avant: before, apres: next, motif: b.motif });
      return { id: a.id, ...next };
    });
  }

  // ------------------------------------------------------------------ internes

  private async mergeUnits(tx: Tx, user: AuthUser, sourceId: string, cibleScan: string, motif: string, at: Date) {
    const parsed = parseQr(cibleScan);
    const cible = (
      await tx.query<{ id: string; qr_code: string; emplacement_courant_id: string | null; actif: boolean }>(
        'SELECT id, qr_code, emplacement_courant_id, actif FROM unite_manutention WHERE qr_code = $1 FOR UPDATE',
        [parsed?.qr ?? cibleScan.trim().toUpperCase()],
      )
    ).rows[0];
    if (!cible || !cible.actif) throw notFound('Unité de manutention cible');
    if (cible.id === sourceId) throw unprocessable('MEME_UM', 'Choisissez une autre unité que celle de l’article');
    const source = (await tx.query<{ qr_code: string; emplacement_courant_id: string | null }>('SELECT qr_code, emplacement_courant_id FROM unite_manutention WHERE id = $1 FOR UPDATE', [sourceId])).rows[0]!;
    const articles = (
      await tx.query<{ id: string; entreprise_id: string; statut: ArticleStatus; emplacement_courant_id: string | null }>(
        'SELECT id, entreprise_id, statut, emplacement_courant_id FROM article WHERE um_courante_id = $1 FOR UPDATE',
        [sourceId],
      )
    ).rows;
    const vers = cible.emplacement_courant_id;
    for (const a of articles) {
      await this.ajustement(tx, user, { articleId: a.id, umId: cible.id, de: a.emplacement_courant_id, vers, avant: a.statut, apres: a.statut, motif: `Fusion ${source.qr_code} → ${cible.qr_code} : ${motif}`, at });
      await tx.query('UPDATE article SET um_courante_id = $2, emplacement_courant_id = coalesce($3, emplacement_courant_id), dernier_mouvement_le = $4 WHERE id = $1', [a.id, cible.id, vers, at]);
    }
    await tx.query(
      `INSERT INTO mouvement (id, tenant_id, um_id, type, de_emplacement_id, vers_emplacement_id, auteur_id, appareil_id, horodatage_terminal, motif)
       VALUES ($1,$2,$3,'AJUSTEMENT',$4,NULL,$5,'back-office',$6,$7)`,
      [uuidv7(), user.tenantId, sourceId, source.emplacement_courant_id, user.id, at, `Fusion dans ${cible.qr_code} : ${motif}`],
    );
    await tx.query('UPDATE unite_manutention SET actif = false, emplacement_courant_id = NULL WHERE id = $1', [sourceId]);
    await this.audit.record(tx, user, {
      action: 'STOCK_FUSIONNER_UM',
      objet: 'unite_manutention',
      objetId: sourceId,
      entrepriseId: articles[0]?.entreprise_id ?? null,
      avant: { um: source.qr_code, articles: articles.length },
      apres: { um: cible.qr_code },
      motif,
    });
    return { umId: cible.id, umQr: cible.qr_code, articles: articles.length };
  }

  /** Une palette vidée par scission reste en base (historique) mais n'est plus active ni positionnée. */
  private async closeEmptyUnit(tx: Tx, umId: string) {
    await tx.query(
      `UPDATE unite_manutention SET actif = false, emplacement_courant_id = NULL
        WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM article WHERE um_courante_id = $1)`,
      [umId],
    );
  }

  private async ajustement(
    tx: Tx,
    user: AuthUser,
    m: { articleId: string; umId: string | null; de: string | null; vers: string | null; avant: ArticleStatus; apres: ArticleStatus; motif: string; at: Date },
  ) {
    await tx.query(
      `INSERT INTO mouvement (id, tenant_id, article_id, um_id, type, de_emplacement_id, vers_emplacement_id, statut_avant, statut_apres,
                              auteur_id, appareil_id, horodatage_terminal, motif)
       VALUES ($1,$2,$3,$4,'AJUSTEMENT',$5,$6,$7,$8,$9,'back-office',$10,$11)`,
      [uuidv7(), user.tenantId, m.articleId, m.umId, m.de, m.vers, m.avant, m.apres, user.id, m.at, m.motif.slice(0, 600)],
    );
  }

  private async locationByScan(tx: Tx, input: string): Promise<LocRow> {
    const parsed = parseQr(input);
    if (parsed && parsed.type !== 'E') throw unprocessable('QR_INVALIDE', 'Ce QR n’est pas celui d’un emplacement');
    const r = parsed
      ? await tx.query<LocRow>('SELECT id, zone_id, code, chemin, statut, adressable, qr_code FROM emplacement WHERE qr_code = $1', [parsed.qr])
      : await tx.query<LocRow>('SELECT id, zone_id, code, chemin, statut, adressable, qr_code FROM emplacement WHERE code = $1', [normalizeCode(input)]);
    if (!r.rows[0]) throw notFound(`Emplacement « ${input} »`);
    if (r.rows.length > 1) throw unprocessable('AMBIGU', `Plusieurs emplacements portent le code ${input} : scannez son QR`);
    return r.rows[0];
  }

  private async zoneOf(tx: Tx, zoneId: string) {
    const z0 = (
      await tx.query<{ id: string; code: string; nom: string; depot: string; depot_code: string }>(
        'SELECT z.id, z.code, z.nom, d.nom AS depot, d.code AS depot_code FROM zone z JOIN depot d ON d.id = z.depot_id WHERE z.id = $1',
        [zoneId],
      )
    ).rows[0];
    if (!z0) throw notFound('Zone');
    return z0;
  }

  /** Codes d'emplacement uniques dans tout l'exploitant : c'est ce que lit l'opérateur sur l'étiquette. */
  private async existingCodes(tx: Tx, codes: string[]): Promise<Set<string>> {
    if (!codes.length) return new Set();
    const r = await tx.query<{ code: string }>('SELECT code FROM emplacement WHERE code = ANY($1)', [codes]);
    return new Set(r.rows.map((x) => x.code));
  }

  private async assertFreeCodes(tx: Tx, codes: string[]) {
    const e = await this.existingCodes(tx, codes);
    if (e.size) throw conflict('CODE_EXISTANT', `Code déjà utilisé : ${[...e].join(', ')}`);
  }

  private async insertLocation(
    tx: Tx,
    user: AuthUser,
    l: {
      zoneId: string;
      parentId: string | null;
      code: string;
      chemin: string;
      adressable: boolean;
      niveaux?: number;
      c: { type?: LocationType; longueurM?: number | null; largeurM?: number | null; hauteurM?: number | null; surfaceM2?: number; chargeMaxKg?: number | null; statut?: string };
    },
  ): Promise<string> {
    const id = uuidv7();
    const surface = l.c.surfaceM2 ?? (l.c.longueurM != null && l.c.largeurM != null ? Math.round(l.c.longueurM * l.c.largeurM * 100) / 100 : 0);
    await tx.query(
      `INSERT INTO emplacement (id, tenant_id, zone_id, parent_id, code, chemin, type, longueur_m, largeur_m, hauteur_m, surface_m2, niveaux,
                                charge_max_kg, statut, adressable, qr_code, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        id, user.tenantId, l.zoneId, l.parentId, l.code, l.chemin, l.c.type ?? 'SOL', l.c.longueurM ?? null, l.c.largeurM ?? null, l.c.hauteurM ?? null,
        l.adressable ? surface : 0, Math.max(1, l.niveaux ?? 1), l.c.chargeMaxKg ?? null, l.c.statut ?? 'ACTIF', l.adressable, generateQrCode('E'), user.id,
      ],
    );
    return id;
  }

  /** Renomme un dépôt, une zone ou un nœud : le chemin lisible de tous les emplacements concernés suit. */
  private async renamePrefix(tx: Tx, from: string, to: string, scope: 'depot' | 'zone' | 'emplacement', id: string) {
    const where =
      scope === 'depot'
        ? 'zone_id IN (SELECT id FROM zone WHERE depot_id = $3)'
        : scope === 'zone'
          ? 'zone_id = $3'
          : 'zone_id = (SELECT zone_id FROM emplacement WHERE id = $3)';
    await tx.query(
      `UPDATE emplacement SET chemin = $2 || substr(chemin, length($1) + 1)
        WHERE ${where} AND (chemin = $1 OR left(chemin, length($1) + 3) = $1 || ' > ' OR (right($1, 3) = ' > ' AND left(chemin, length($1)) = $1))`,
      [from, to, id],
    );
  }

  private async labelContents(tx: Tx, kind: 'EMPLACEMENT' | 'ARTICLE' | 'UM' | 'VIERGE', ids: string[], lot?: string): Promise<LabelContent[]> {
    const fallbackDepot = (await tx.query<{ nom: string }>('SELECT nom FROM depot ORDER BY created_at LIMIT 1')).rows[0]?.nom ?? 'JAMYSTOCK';
    const order = <T extends { id: string }>(rows: T[]): T[] => {
      const pos = new Map(ids.map((x, i) => [x, i]));
      return rows.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
    };
    const sub = (chemin: string, depot: string) => (chemin.startsWith(`${depot} > `) ? chemin.slice(depot.length + 3) : chemin);
    if (kind === 'EMPLACEMENT') {
      const r = await tx.query<{ id: string; code: string; chemin: string; qr_code: string; depot: string }>(
        `SELECT e.id, e.code, e.chemin, e.qr_code, d.nom AS depot FROM emplacement e JOIN zone z ON z.id = e.zone_id JOIN depot d ON d.id = z.depot_id
          WHERE e.id = ANY($1)`,
        [ids],
      );
      return order(r.rows).map((e) => ({ qr: qrUrl(e.qr_code), titre: e.code, sousTitre: sub(e.chemin, e.depot), depot: `${e.depot} · ${e.qr_code}` }));
    }
    if (kind === 'ARTICLE') {
      const r = await tx.query<{ id: string; qr_code: string; libelle: string; client: string; depot: string | null }>(
        `SELECT a.id, a.qr_code, a.libelle, en.nom AS client, d.nom AS depot
           FROM article a JOIN entreprise en ON en.id = a.entreprise_id
           LEFT JOIN emplacement e ON e.id = a.emplacement_courant_id LEFT JOIN zone z ON z.id = e.zone_id LEFT JOIN depot d ON d.id = z.depot_id
          WHERE a.id = ANY($1)`,
        [ids],
      );
      return order(r.rows).map((a) => ({ qr: qrUrl(a.qr_code), titre: a.qr_code, sousTitre: `${a.libelle} · ${a.client}`, depot: a.depot ?? fallbackDepot }));
    }
    if (kind === 'UM') {
      const r = await tx.query<{ id: string; qr_code: string; type: string; client: string | null; depot: string | null }>(
        `SELECT u.id, u.qr_code, u.type, en.nom AS client, d.nom AS depot
           FROM unite_manutention u LEFT JOIN entreprise en ON en.id = u.entreprise_id
           LEFT JOIN emplacement e ON e.id = u.emplacement_courant_id LEFT JOIN zone z ON z.id = e.zone_id LEFT JOIN depot d ON d.id = z.depot_id
          WHERE u.id = ANY($1)`,
        [ids],
      );
      return order(r.rows).map((u) => ({ qr: qrUrl(u.qr_code), titre: u.qr_code, sousTitre: [u.type.toLowerCase(), u.client].filter(Boolean).join(' · '), depot: u.depot ?? fallbackDepot }));
    }
    if (!lot) throw unprocessable('LOT_REQUIS', 'Indiquez le lot de QR vierges à imprimer');
    const r = await tx.query<{ qr_code: string }>('SELECT qr_code FROM qr_vierge WHERE lot = $1 AND attribue_le IS NULL ORDER BY qr_code LIMIT 2000', [lot]);
    return r.rows.map((q) => ({ qr: qrUrl(q.qr_code), titre: q.qr_code, sousTitre: q.qr_code.startsWith('U') ? 'Unité de manutention' : 'Article', depot: fallbackDepot }));
  }
}

const labelOf = (a: StockCorrection) =>
  ({ DEPLACER: 'Déplacement', PERDU: 'Perdu', ENDOMMAGE: 'Endommagé', RETROUVE: 'Retrouvé', DETRUIT: 'Détruit', RETIRER_UM: 'Sortie d’unité', FUSIONNER_UM: 'Fusion' })[a];
