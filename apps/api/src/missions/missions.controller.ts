import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { DATABASE } from '../common/tokens.js';
import type { Database } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { notFound, unprocessable } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';

const uuid = z.string().uuid();

/** FLX-01 / FLX-03 : liste des missions et affectation (le planning glisser-déposer viendra avec le back-office). */
@Controller()
export class MissionsController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Get('missions')
  @RequirePermission('mission.assign')
  list(@CurrentUser() user: AuthUser, @Query() q: Record<string, string>) {
    const f = z.object({ date: z.string().date().optional(), statut: z.string().optional() }).parse(q);
    return this.db.tx(ctxOf(user), async (tx) =>
      (
        await tx.query(
          `SELECT m.id, m.type, m.statut, m.assigne_a AS "assigneA", m.vehicule_id AS "vehiculeId", m.debut_prevu AS "debutPrevu",
                  c.id AS "commandeId", c.numero, c.type AS "typeCommande", c.statut AS "statutCommande", e.nom AS client
             FROM mission m LEFT JOIN commande c ON c.id = m.commande_id LEFT JOIN entreprise e ON e.id = c.entreprise_id
            WHERE ($1::date IS NULL OR m.debut_prevu::date = $1) AND ($2::text IS NULL OR m.statut::text = $2)
            ORDER BY m.debut_prevu, m.ordre NULLS LAST`,
          [f.date ?? null, f.statut ?? null],
        )
      ).rows,
    );
  }

  @Post('missions/:id/assign')
  @HttpCode(200)
  @RequirePermission('mission.assign')
  assign(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: unknown) {
    const b = z.object({ assigneA: uuid, vehiculeId: uuid.optional(), ordre: z.number().int().optional() }).parse(body);
    return this.db.tx(ctxOf(user), async (tx) => {
      const m = (await tx.query<{ id: string; type: string; commande_id: string | null }>('SELECT id, type, commande_id FROM mission WHERE id = $1 FOR UPDATE', [uuid.parse(id)])).rows[0];
      if (!m) throw notFound('Mission');
      const target = (await tx.query<{ role: string }>(`SELECT role FROM utilisateur WHERE id = $1 AND statut = 'ACTIF'`, [b.assigneA])).rows[0];
      const expectedRole = ['LIVRAISON', 'COLLECTE'].includes(m.type) ? 'DRIVER' : 'OPERATOR';
      if (!target || (target.role !== expectedRole && target.role !== 'SUPER_ADMIN')) {
        throw unprocessable('MAUVAISE_RESSOURCE', `Une mission ${m.type} s'affecte à un ${expectedRole === 'DRIVER' ? 'chauffeur' : 'opérateur'}`);
      }
      const warnings: string[] = [];
      if (b.vehiculeId && m.commande_id) {
        // FLX-03 : contrôle de capacité du véhicule (m³, kg) avec alerte
        const cap = (
          await tx.query<{ volume_m3: number; charge_utile_kg: number; vol: number | null; kg: number | null }>(
            `SELECT v.volume_m3, v.charge_utile_kg, c.volume_m3 AS vol, c.poids_kg AS kg FROM vehicule v, commande c WHERE v.id = $1 AND c.id = $2`,
            [b.vehiculeId, m.commande_id],
          )
        ).rows[0];
        if (!cap) throw notFound('Véhicule');
        if ((cap.vol ?? 0) > cap.volume_m3) warnings.push(`Volume ${cap.vol} m³ > capacité ${cap.volume_m3} m³`);
        if ((cap.kg ?? 0) > cap.charge_utile_kg) warnings.push(`Poids ${cap.kg} kg > charge utile ${cap.charge_utile_kg} kg`);
      }
      await tx.query(
        `UPDATE mission SET assigne_a = $2, vehicule_id = coalesce($3, vehicule_id), ordre = coalesce($4, ordre),
                statut = CASE WHEN statut = 'A_AFFECTER' THEN 'AFFECTEE'::statut_mission ELSE statut END WHERE id = $1`,
        [m.id, b.assigneA, b.vehiculeId ?? null, b.ordre ?? null],
      );
      await tx.query(`INSERT INTO notification (id, tenant_id, destinataire_id, canal, modele, variables) VALUES (gen_random_uuid(), $1, $2, 'PUSH', 'MISSION_AFFECTEE', $3)`, [
        user.tenantId, b.assigneA, JSON.stringify({ missionId: m.id }),
      ]);
      await this.audit.record(tx, user, { action: 'MISSION_AFFECTEE', objet: 'mission', objetId: m.id, apres: b });
      return { id: m.id, statut: 'AFFECTEE', warnings };
    });
  }

  /** Pré-chargement de début de journée de l'app terrain (§7.5, LIV-01) : missions affectées + référentiels. */
  @Get('field/bootstrap')
  bootstrap(@CurrentUser() user: AuthUser, @Query('date') date?: string) {
    const day = date ? z.string().date().parse(date) : null;
    return this.db.tx(ctxOf(user), async (tx) => {
      const missions = (
        await tx.query(
          `SELECT m.id, m.type, m.statut, m.ordre, m.debut_prevu AS "debutPrevu", c.id AS "commandeId", coalesce(c.numero, m.donnees->>'numero') AS numero, c.adresse,
                  m.donnees->>'zone' AS zone,
                  c.contraintes_acces AS "contraintesAcces", c.contact_site AS "contactSite", c.creneau_confirme AS creneau,
                  coalesce(pa.nom_client, pa.libelle) AS "articleLibelle"
             FROM mission m LEFT JOIN commande c ON c.id = m.commande_id
             LEFT JOIN article pa ON m.type = 'PHOTO' AND pa.id = (m.donnees->>'articleId')::uuid
            WHERE m.assigne_a = $1 AND m.statut IN ('AFFECTEE','EN_COURS') AND ($2::date IS NULL OR m.debut_prevu::date <= $2)
            ORDER BY m.ordre NULLS LAST, m.debut_prevu`,
          [user.id, day],
        )
      ).rows;
      const emplacements = (
        await tx.query(`SELECT e.id, e.code, e.chemin, e.qr_code AS "qrCode", e.statut, z.type AS "typeZone" FROM emplacement e JOIN zone z ON z.id = e.zone_id WHERE e.adressable`)
      ).rows;
      const categories = (await tx.query('SELECT id, nom, icone, longueur_m AS "longueurM", largeur_m AS "largeurM", hauteur_m AS "hauteurM", empilable FROM categorie ORDER BY nom')).rows;
      return { serverTime: new Date().toISOString(), missions, emplacements, categories };
    });
  }
}
