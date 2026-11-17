import { addIsoDays, monthBounds, parisClock, previousMonth, uuidv7 } from '@jamystock/domain';
import { Database, type Tx } from './database.js';
import { BillingService, systemCtx } from '../billing/billing.service.js';
import { StorageService } from '../storage/storage.service.js';
import { liveSurface } from '../client/client.controller.js';
import type { AppConfig } from '../config.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * Historique de facturation de démonstration (FAC-01 à 04, SUI-03), produit par le vrai moteur :
 *  - instantanés quotidiens des trois derniers mois (une courbe qui rejoint la surface réelle d'aujourd'hui) ;
 *  - quelques prestations (livraisons, annulation tardive) ;
 *  - factures de M-2 émises et payées, un avoir partiel, factures de M-1 émises, un brouillon bloqué à revoir.
 * Ne fait rien si une facture existe déjà.
 */
export async function seedDemoBilling(url: string, storageDir = process.env.STORAGE_DIR ?? '.storage', now = new Date()): Promise<number> {
  const db = new Database(url);
  try {
    const tenantId = (await db.pool.query<{ id: string }>('SELECT id FROM organisation ORDER BY created_at LIMIT 1')).rows[0]?.id;
    if (!tenantId) return 0;
    const billing = new BillingService(db, new StorageService({ storageDir } as AppConfig));
    const sys = systemCtx(tenantId);
    const today = parisClock(now).date;
    const m1 = previousMonth(today); // mois dernier
    const m2 = previousMonth(`${m1}-01`); // le mois d'avant
    const start = monthBounds(m2).start;

    const ctx = await db.tx(sys, async (tx) => {
      if ((await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM facture')).rows[0]!.n > 0) return null;
      const ents = new Map((await tx.query<{ nom: string; id: string }>('SELECT nom, id FROM entreprise')).rows.map((e) => [e.nom, e.id]));
      const admin = (await tx.query<{ id: string }>(`SELECT id FROM utilisateur WHERE role = 'SUPER_ADMIN' ORDER BY created_at LIMIT 1`)).rows[0];
      const horizon = ents.get('Promotion Horizon SAS');
      const batir = ents.get('Bâtir Ensemble SARL');
      const camille = ents.get('Camille Martin');
      if (!horizon || !batir || !camille || !admin) return null;

      // Courbes : un niveau d'activité passé, qui redescend vers la surface réelle du jour (restitutions de fin de programme)
      const profiles: [string, number, number][] = [
        [horizon, 126, 9], // forfait 120 m² : léger dépassement le mois M-1, comme l'exemple du cahier des charges
        [batir, 34, 3],
        [camille, 2.5, 0.4],
      ];
      for (const [id, level, wave] of profiles) {
        const live = (await liveSurface(tx, id, true)).m2Occupes;
        const total = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000);
        let i = 0;
        for (let d = start; d < today; d = addIsoDays(d, 1), i++) {
          // les deux premiers mois oscillent autour du niveau, le mois en cours glisse vers la surface réelle
          const inCurrent = d >= `${today.slice(0, 7)}-01`;
          const base = level + wave * Math.sin(i / 4.5) + (d.slice(0, 7) === m1 ? wave * 0.9 : 0);
          const days = total - i;
          const m2v = inCurrent ? live + (base - live) * Math.min(1, days / 14) : base;
          await tx.query(
            `INSERT INTO instantane_occupation (id, tenant_id, entreprise_id, date, m2_occupes, nb_articles, source) VALUES ($1,$2,$3,$4,$5,$6,'AUTO') ON CONFLICT DO NOTHING`,
            [uuidv7(), tenantId, id, d, Math.max(0, Math.round(m2v * 100) / 100), Math.round(m2v * 1.8)],
          );
        }
      }

      const service = async (entrepriseId: string, code: string, libelle: string, unite: string, prix: number, date: string) =>
        tx.query(
          `INSERT INTO prestation_a_facturer (id, tenant_id, entreprise_id, code, libelle, quantite, unite, prix_unitaire_ht_cents, taux_tva, date_prestation)
           VALUES ($1,$2,$3,$4,$5,1,$6,$7,20,$8)`,
          [uuidv7(), tenantId, entrepriseId, code, libelle, unite, prix, date],
        );
      for (const [d, m] of [[5, m2], [19, m2], [4, m1], [14, m1], [27, m1]] as const) {
        await service(horizon, 'LIVRAISON_ZONE1', 'Livraison Île-de-France', 'livraison', 15000, `${m}-${String(d).padStart(2, '0')}`);
      }
      await service(batir, 'LIVRAISON_ZONE1', 'Livraison Île-de-France', 'livraison', 15000, `${m2}-11`);
      await service(batir, 'ANNULATION_TARDIVE', 'Annulation tardive (< 24 h)', 'forfait', 9000, `${m2}-23`);
      await service(batir, 'MANUTENTION_HEURE', 'Manutention', 'h', 4500, `${m1}-16`);
      await service(camille, 'LIVRAISON_ZONE1', 'Livraison Île-de-France', 'livraison', 15000, `${m1}-08`);

      await tx.query(`UPDATE entreprise SET conditions_paiement = '30 jours date de facture', adresse_facturation = $2 WHERE id = $1`, [
        horizon,
        JSON.stringify({ libelle: '8 avenue de la Démonstration, 92100 Boulogne-Billancourt' }),
      ]);
      await tx.query(`UPDATE organisation SET parametres = parametres || $2 WHERE id = $1`, [
        tenantId,
        JSON.stringify({ facturation: { adresse: 'Dépôt de démonstration, 93000 Bobigny', email: 'facturation@jamystock.test' } }),
      ]);
      return { horizon, batir, camille, admin: { id: admin.id, tenantId, role: 'SUPER_ADMIN', entrepriseId: null, sessionVersion: 0 } as AuthUser };
    });
    if (!ctx) return 0;

    const issueMonth = async (month: string, keepDraft?: string) => {
      const draftAt = new Date(`${addIsoDays(monthBounds(month).end, 1)}T01:30:00Z`); // le 1er à 2 h, heure de Paris
      const issueAt = new Date(`${addIsoDays(monthBounds(month).end, 3)}T08:00:00Z`); // J+2
      const ids = await db.tx(sys, async (tx: Tx) => {
        const r = await billing.generateDrafts(tx, tenantId, null, month, draftAt);
        await tx.query(`INSERT INTO tache_planifiee (tenant_id, cle, executee_le) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, `brouillons:${month}`, draftAt]);
        return r.factures;
      });
      const numbers: Record<string, string> = {};
      for (const id of ids) {
        const ent = (await db.tx(sys, (tx) => tx.query<{ entreprise_id: string }>('SELECT entreprise_id FROM facture WHERE id = $1', [id]))).rows[0]!.entreprise_id;
        if (ent === keepDraft) {
          await db.tx(sys, (tx) => billing.setBlocked(tx, ctx.admin, id, true, 'Vérifier la surface minimum facturée avant envoi', new Date(draftAt.getTime() + 7 * 3600_000)));
          continue;
        }
        numbers[ent] = (await db.tx(sys, (tx) => billing.issue(tx, tenantId, null, id, issueAt))).numero;
      }
      return { ids, numbers, issueAt };
    };

    const sep = await issueMonth(m2);
    // M-2 : tout est réglé, et l'annulation tardive de Bâtir est remboursée par un avoir partiel
    await db.tx(sys, async (tx) => {
      const rows = await tx.query<{ id: string; entreprise_id: string }>(`SELECT id, entreprise_id FROM facture WHERE id = ANY($1) AND statut = 'EMISE'`, [sep.ids]);
      for (const r of rows.rows) {
        const date = addIsoDays(sep.issueAt.toISOString().slice(0, 10), 12);
        await billing.markPaid(tx, ctx.admin, r.id, { date, moyen: r.entreprise_id === ctx.camille ? 'CB' : 'VIREMENT' }, new Date(`${date}T09:00:00Z`));
      }
      const bat = rows.rows.find((r) => r.entreprise_id === ctx.batir);
      if (bat) await billing.credit(tx, ctx.admin, bat.id, { montantHtCents: 9000, motif: 'Annulation tardive offerte (geste commercial)' }, new Date(sep.issueAt.getTime() + 6 * 86_400_000));
    });
    const oct = await issueMonth(m1, ctx.camille);
    return sep.ids.length + oct.ids.length;
  } finally {
    await db.close();
  }
}
