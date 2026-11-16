import pg from 'pg';
import { generateQrCode, uuidv7 } from '@jamystock/domain';
import { hashPassword } from '../auth/auth.service.js';
import { demoPhotoSvg, writeDemoPhoto } from './demo-photos.js';

/**
 * Données de démonstration : 1 exploitant, 1 dépôt, 2 clients B2B + 1 client B2C, un compte par rôle.
 * Mot de passe commun : « demo-jamystock ».
 */
export interface SeedResult {
  tenantId: string;
  users: Record<'superAdmin' | 'dispatcher' | 'operator' | 'driver' | 'b2bAdmin' | 'b2bUser' | 'b2bUserNoOrder' | 'otherB2bAdmin' | 'b2c', { id: string; email: string }>;
  entreprises: { promoteur: string; autre: string; particulier: string };
  projets: { tilleuls: string; jardins: string; autre: string };
  articles: { tilleuls: string[]; jardins: string[]; autre: string[]; particulier: string[] };
  depotId: string;
  vehicules: { vul12: string; vul20: string };
  password: string;
}

export const DEMO_PASSWORD = 'demo-jamystock';

export async function seed(databaseUrl: string): Promise<SeedResult> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const q = (sql: string, params: unknown[] = []) => client.query(sql, params);
  try {
    await q('BEGIN');
    // la seed tourne avec le contexte SYSTEM pour traverser la RLS si le propriétaire y est soumis (FORCE)
    const tenantId = uuidv7();
    await q(`SELECT set_config('app.tenant_id', $1, true), set_config('app.role', 'SYSTEM', true)`, [tenantId]);
    await q(`INSERT INTO organisation (id, raison_sociale, parametres) VALUES ($1, 'JAMYSTOCK Démo', '{}')`, [tenantId]);

    const passwordHash = await hashPassword(DEMO_PASSWORD);

    // --- dépôt Nord : zones réception / stockage / expédition, allée 4 en rack 5 niveaux × 4 cases, 6 emplacements au sol
    const depotId = uuidv7();
    await q(
      `INSERT INTO depot (id, tenant_id, nom, code, adresse, latitude, longitude, horaires, creneaux_retrait)
       VALUES ($1,$2,'Dépôt Nord','N','{"libelle":"12 rue des Entrepôts, 93200 Saint-Denis"}',48.9362,2.3574,
               '{"lun-ven":"07:00-19:00"}','["08:00-10:00","10:00-12:00","14:00-16:00","16:00-18:00"]')`,
      [depotId, tenantId],
    );
    const zone = async (code: string, nom: string, type: string) => {
      const id = uuidv7();
      await q('INSERT INTO zone (id, tenant_id, depot_id, code, nom, type) VALUES ($1,$2,$3,$4,$5,$6)', [id, tenantId, depotId, code, nom, type]);
      return id;
    };
    const zRec = await zone('R', 'Réception', 'RECEPTION');
    const zB = await zone('B', 'Zone B', 'STOCKAGE');
    await zone('X', 'Expédition', 'EXPEDITION');

    const location = async (zoneId: string, code: string, chemin: string, type: string, surface: number, niveaux = 1, parentId: string | null = null, adressable = true) => {
      const id = uuidv7();
      await q(
        `INSERT INTO emplacement (id, tenant_id, zone_id, parent_id, code, chemin, type, surface_m2, niveaux, qr_code, adressable, charge_max_kg)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1000)`,
        [id, tenantId, zoneId, parentId, code, chemin, type, surface, niveaux, generateQrCode('E'), adressable],
      );
      return id;
    };
    const quai = await location(zRec, 'N-R-QUAI1', 'Dépôt Nord > Réception > Quai 1', 'SOL', 40);
    const allee4 = await location(zB, 'N-B-04', 'Dépôt Nord > Zone B > Allée 4', 'RACK', 0, 5, null, false);
    const racks: string[] = [];
    for (let niv = 1; niv <= 5; niv++) {
      for (let c = 1; c <= 4; c++) {
        const code = `N-B-04-${niv}${String(c).padStart(2, '0')}`;
        racks.push(await location(zB, code, `Dépôt Nord > Zone B > Allée 4 > Niveau ${niv} > Case ${c}`, 'RACK', 1.2, 5, allee4));
      }
    }
    const sols: string[] = [];
    for (let i = 1; i <= 6; i++) {
      sols.push(await location(zB, `N-B-S${String(i).padStart(2, '0')}`, `Dépôt Nord > Zone B > Sol ${i}`, 'SOL', 12));
    }

    // --- catégories
    const icons = new Map<string, string>();
    const storageDir = process.env.STORAGE_DIR ?? '.storage';
    let photoSeq = 0;
    const cat = async (nom: string, icone: string, l: number, w: number, h: number, empilable = false) => {
      const id = uuidv7();
      await q(
        'INSERT INTO categorie (id, tenant_id, nom, icone, longueur_m, largeur_m, hauteur_m, empilable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, tenantId, nom, icone, l, w, h, empilable],
      );
      icons.set(id, icone);
      return id;
    };
    const cBureau = await cat('Bureau', 'desk', 1.6, 0.8, 0.75);
    const cChaise = await cat('Chaise', 'chair', 0.5, 0.5, 0.9, true);
    const cPlv = await cat('PLV', 'sign', 1, 0.4, 2);
    const cPrefa = await cat('Module préfabriqué', 'building', 6, 2.5, 2.6);
    const cCarton = await cat('Carton', 'box', 0.6, 0.4, 0.4, true);

    // --- grille et forfaits
    const grilleB2B = uuidv7();
    const lignes = JSON.stringify([
      { code: 'LIVRAISON_ZONE1', libelle: 'Livraison Île-de-France', unite: 'livraison', prix_ht_cents: 15000, tva: 20 },
      { code: 'MANUTENTION_HEURE', libelle: 'Manutention', unite: 'h', prix_ht_cents: 4500, tva: 20 },
      { code: 'ANNULATION_TARDIVE', libelle: 'Annulation tardive', unite: 'forfait', prix_ht_cents: 9000, tva: 20 },
    ]);
    await q(
      `INSERT INTO grille_tarifaire (id, tenant_id, nom, type, valide_du, prix_m2_mois_cents, lignes) VALUES ($1,$2,'Sur-mesure B2B','SUR_MESURE_B2B','2026-01-01',1500,$3)`,
      [grilleB2B, tenantId, lignes],
    );
    const grilleB2C = uuidv7();
    await q(
      `INSERT INTO grille_tarifaire (id, tenant_id, nom, type, valide_du, prix_m2_mois_cents, m2_minimum, lignes) VALUES ($1,$2,'Standard B2C','STANDARD_B2C','2026-01-01',2500,2,$3)`,
      [grilleB2C, tenantId, lignes],
    );

    // --- clients
    const entreprise = async (type: string, nom: string, siret: string | null) => {
      const id = uuidv7();
      await q('INSERT INTO entreprise (id, tenant_id, type, nom, siret) VALUES ($1,$2,$3,$4,$5)', [id, tenantId, type, nom, siret]);
      return id;
    };
    const promoteur = await entreprise('B2B', 'Promotion Horizon SAS', '12345678900011');
    const autre = await entreprise('B2B', 'Bâtir Ensemble SARL', '98765432100022');
    const particulier = await entreprise('B2C', 'Camille Martin', null);
    await q(
      `INSERT INTO forfait (id, tenant_id, entreprise_id, grille_tarifaire_id, m2_inclus, prix_mensuel_cents, prix_m2_depassement_cents, prestations_incluses, date_debut)
       VALUES ($1,$2,$3,$4,120,180000,1700,'{"LIVRAISON":2}','2026-01-01'),
              ($5,$2,$6,$4,40,60000,1700,'{"LIVRAISON":1}','2026-03-01'),
              ($7,$2,$8,$9,2,5000,2500,'{}','2026-06-01')`,
      [uuidv7(), tenantId, promoteur, grilleB2B, uuidv7(), autre, uuidv7(), particulier, grilleB2C],
    );

    const projet = async (entrepriseId: string, nom: string, code: string) => {
      const id = uuidv7();
      await q('INSERT INTO projet (id, tenant_id, entreprise_id, nom, code) VALUES ($1,$2,$3,$4,$5)', [id, tenantId, entrepriseId, nom, code]);
      return id;
    };
    const tilleuls = await projet(promoteur, 'Stand de vente Résidence Les Tilleuls', 'TIL');
    const jardins = await projet(promoteur, 'Bureau témoin Les Jardins', 'JAR');
    const projAutre = await projet(autre, 'Chantier Gare Sud', 'GSU');

    // --- utilisateurs
    const user = async (email: string, nom: string, role: string, entrepriseId: string | null, opts: { peutCommanderSeul?: boolean } = {}) => {
      const id = uuidv7();
      await q(
        `INSERT INTO utilisateur (id, tenant_id, entreprise_id, email, nom, role, mot_de_passe_hash, peut_commander_seul)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, tenantId, entrepriseId, email, nom, role, passwordHash, opts.peutCommanderSeul ?? true],
      );
      return { id, email };
    };
    const users: SeedResult['users'] = {
      superAdmin: await user('admin@jamystock.test', 'Responsable exploitation', 'SUPER_ADMIN', null),
      dispatcher: await user('dispatch@jamystock.test', 'Dispatcher', 'DISPATCHER', null),
      operator: await user('operateur@jamystock.test', 'Opérateur entrepôt', 'OPERATOR', null),
      driver: await user('chauffeur@jamystock.test', 'Chauffeur', 'DRIVER', null),
      b2bAdmin: await user('dsg@horizon.test', 'Directrice services généraux', 'B2B_ADMIN', promoteur),
      b2bUser: await user('chef.projet@horizon.test', 'Chef de projet Les Tilleuls', 'B2B_USER', promoteur),
      b2bUserNoOrder: await user('conducteur@horizon.test', 'Conducteur de travaux', 'B2B_USER', promoteur, { peutCommanderSeul: false }),
      otherB2bAdmin: await user('admin@batir.test', 'Admin Bâtir Ensemble', 'B2B_ADMIN', autre),
      b2c: await user('camille@exemple.test', 'Camille Martin', 'B2C', particulier),
    };
    await q('INSERT INTO acces_projet (utilisateur_id, projet_id, peut_commander) VALUES ($1,$2,true), ($3,$2,false)', [
      users.b2bUser.id,
      tilleuls,
      users.b2bUserNoOrder.id,
    ]);

    // --- articles en stock, chacun avec photo et mouvements RECEPTION + RANGEMENT (projection cohérente)
    let rackIdx = 0;
    let solIdx = 0;
    const article = async (entrepriseId: string, projetId: string | null, libelle: string, categorieId: string, dims: [number, number, number], onRack: boolean, empilable = false) => {
      const id = uuidv7();
      const loc = onRack ? racks[rackIdx++ % racks.length]! : sols[solIdx++ % sols.length]!;
      await q(
        `INSERT INTO article (id, tenant_id, entreprise_id, projet_id, qr_code, libelle, categorie_id, longueur_m, largeur_m, hauteur_m,
                              empilable, etat, statut, emplacement_courant_id, date_entree, dernier_mouvement_le, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'BON','EN_STOCK',$12, now() - interval '30 days', now() - interval '30 days', $13)`,
        [id, tenantId, entrepriseId, projetId, generateQrCode('A'), libelle, categorieId, dims[0], dims[1], dims[2], empilable, loc, users.operator.id],
      );
      const photoKey = `${tenantId}/demo/${id}.svg`;
      await writeDemoPhoto(storageDir, photoKey, demoPhotoSvg(libelle, icons.get(categorieId) ?? 'box', photoSeq++));
      await q(
        `INSERT INTO photo (id, tenant_id, article_id, cle_originale, contexte, prise_par, televersee, type_mime)
         VALUES ($1,$2,$3,$4,'RECEPTION',$5,true,'image/svg+xml')`,
        [uuidv7(), tenantId, id, photoKey, users.operator.id],
      );
      await q(
        `INSERT INTO mouvement (id, tenant_id, article_id, type, vers_emplacement_id, statut_avant, statut_apres, auteur_id, horodatage_terminal)
         VALUES ($1,$2,$3,'RECEPTION',$4,'ATTENDU','EN_RECEPTION',$5, now() - interval '30 days'),
                ($6,$2,$3,'RANGEMENT',$7,'EN_RECEPTION','EN_STOCK',$5, now() - interval '30 days' + interval '2 minutes')`,
        [uuidv7(), tenantId, id, quai, users.operator.id, uuidv7(), loc],
      );
      return id;
    };
    const articles: SeedResult['articles'] = { tilleuls: [], jardins: [], autre: [], particulier: [] };
    articles.tilleuls.push(await article(promoteur, tilleuls, 'Module préfabriqué bureau de vente', cPrefa, [6, 2.5, 2.6], false));
    for (let i = 1; i <= 4; i++) articles.tilleuls.push(await article(promoteur, tilleuls, `Bureau d'accueil ${i}`, cBureau, [1.6, 0.8, 0.75], false));
    for (let i = 1; i <= 6; i++) articles.tilleuls.push(await article(promoteur, tilleuls, `Chaise visiteur ${i}`, cChaise, [0.5, 0.5, 0.9], true, true));
    for (let i = 1; i <= 3; i++) articles.tilleuls.push(await article(promoteur, tilleuls, `Totem PLV ${i}`, cPlv, [1, 0.4, 2], true));
    for (let i = 1; i <= 2; i++) articles.jardins.push(await article(promoteur, jardins, `Bureau direction ${i}`, cBureau, [1.8, 0.9, 0.75], false));
    for (let i = 1; i <= 3; i++) articles.autre.push(await article(autre, projAutre, `Carton archives ${i}`, cCarton, [0.6, 0.4, 0.4], true, true));
    for (let i = 1; i <= 3; i++) articles.particulier.push(await article(particulier, null, `Carton déménagement ${i}`, cCarton, [0.6, 0.4, 0.4], true, true));

    // --- véhicules (CMD-04, FLX-03)
    const vehicules = { vul12: uuidv7(), vul20: uuidv7() };
    await q(
      `INSERT INTO vehicule (id, tenant_id, immatriculation, type, volume_m3, charge_utile_kg, hayon)
       VALUES ($1,$3,'GA-123-AA','VUL12',12,1200,true), ($2,$3,'GB-456-BB','VUL20',20,1500,true)`,
      [vehicules.vul12, vehicules.vul20, tenantId],
    );

    await q('COMMIT');
    return {
      tenantId,
      users,
      entreprises: { promoteur, autre, particulier },
      projets: { tilleuls, jardins, autre: projAutre },
      articles,
      depotId,
      vehicules,
      password: DEMO_PASSWORD,
    };
  } catch (err) {
    await q('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL manquant');
  seed(url).then((r) => {
    console.log(`Organisation de démo : ${r.tenantId} (à mettre dans TENANT_ID)`);
    console.log(`Comptes (mot de passe « ${r.password} ») :`);
    for (const [k, u] of Object.entries(r.users)) console.log(`  ${k.padEnd(16)} ${u.email}`);
  });
}
