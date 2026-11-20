import { generateQrCode, uuidv7 } from '@jamystock/domain';
import { Database } from './database.js';
import { createInvitation } from '../accounts/invitations.js';

/**
 * Premier démarrage d'une base de production (SEED_DEMO absent) : crée l'organisation, le dépôt avec un emplacement
 * « À ranger » (où la reprise de l'ancien logiciel range ce qu'elle ne sait pas placer) et le premier administrateur.
 * L'administrateur n'a pas de mot de passe : il reçoit un lien d'activation (par e-mail si Brevo est configuré,
 * et dans le journal de déploiement, visible seulement du propriétaire du compte d'hébergement).
 * Ne fait rien dès qu'une organisation existe : se relance sans effet de bord.
 */
export async function bootstrapProduction(url: string, env: NodeJS.ProcessEnv, log: (m: string) => void): Promise<boolean> {
  const db = new Database(url);
  try {
    const n = (await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM organisation')).rows[0]!.n;
    if (n > 0) return false;
    const email = env.INIT_ADMIN_EMAIL?.trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      log('Base vide : renseignez INIT_ADMIN_EMAIL (e-mail du premier administrateur) puis redéployez.');
      return false;
    }
    const tenantId = uuidv7();
    const publicUrl = (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const depotNom = env.INIT_DEPOT_NOM?.trim() || 'Dépôt JAMYSTOCK';
    const lien = await db.tx({ tenantId, role: 'SYSTEM' }, async (tx) => {
      await tx.query(`INSERT INTO organisation (id, raison_sociale, parametres) VALUES ($1, $2, '{}')`, [tenantId, env.INIT_ORG_NOM?.trim() || 'JAMYSTOCK']);
      const depotId = uuidv7();
      await tx.query(
        `INSERT INTO depot (id, tenant_id, nom, code, horaires, creneaux_retrait)
         VALUES ($1,$2,$3,'D','{"lun-ven":"08:00-18:00"}','["08:00-10:00","10:00-12:00","14:00-16:00","16:00-18:00"]')`,
        [depotId, tenantId, depotNom],
      );
      const zone = async (code: string, nom: string, type: string) => {
        const id = uuidv7();
        await tx.query('INSERT INTO zone (id, tenant_id, depot_id, code, nom, type) VALUES ($1,$2,$3,$4,$5,$6)', [id, tenantId, depotId, code, nom, type]);
        return id;
      };
      const zRec = await zone('R', 'Réception', 'RECEPTION');
      const zStock = await zone('S', 'Stockage', 'STOCKAGE');
      await zone('X', 'Expédition', 'EXPEDITION');
      const place = (zoneId: string, code: string, nom: string, surface: number) =>
        tx.query(
          `INSERT INTO emplacement (id, tenant_id, zone_id, code, chemin, type, surface_m2, niveaux, qr_code, adressable, charge_max_kg)
           VALUES ($1,$2,$3,$4,$5,'SOL',$6,1,$7,true,1000)`,
          [uuidv7(), tenantId, zoneId, code, `${depotNom} > ${nom}`, surface, generateQrCode('E')],
        );
      await place(zRec, 'D-R-QUAI1', 'Réception > Quai 1', 40);
      await place(zStock, 'D-S-ARANGER', 'Stockage > À ranger', 500);
      const adminId = uuidv7();
      await tx.query(
        `INSERT INTO utilisateur (id, tenant_id, entreprise_id, email, nom, role, mot_de_passe_hash, peut_commander_seul)
         VALUES ($1,$2,NULL,$3,$4,'SUPER_ADMIN',NULL,true)`,
        [adminId, tenantId, email, env.INIT_ADMIN_NOM?.trim() || 'Administrateur'],
      );
      const inv = await createInvitation(tx, { tenantId, utilisateurId: adminId, entrepriseId: null, createdBy: null, invitePar: 'JAMYSTOCK', publicUrl });
      return inv.lien;
    });
    log(`Organisation créée avec le dépôt « ${depotNom} » et l'administrateur ${email}.`);
    log(`Lien d'activation de l'administrateur (valable 7 jours, à usage unique) : ${lien}`);
    return true;
  } finally {
    await db.close();
  }
}
