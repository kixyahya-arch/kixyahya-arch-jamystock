import pg from 'pg';
import { generateQrCode, uuidv7 } from '@jamystock/domain';
import { demoPhotoSvg, writeDemoPhoto } from './demo-photos.js';

/**
 * Objets de démonstration installés chez le client (statut RESTITUE), pour que l'écran « Sur mes sites »
 * de l'Espace Client ait de quoi montrer un retour au dépôt ou un transfert entre sites.
 * Chaque objet a un historique complet (réception, rangement, préparation, chargement, livraison).
 * Ne fait rien si un objet est déjà chez un client : se relance sans effet de bord, y compris sur une base déjà seedée.
 */
const PLAN: { projet: string; libelle: string; categorie: string; couleur: string; dims: [number, number, number] }[] = [
  { projet: 'Stand de vente Résidence Les Tilleuls', libelle: "Comptoir d'accueil", categorie: 'Bureau', couleur: 'Blanc', dims: [2, 0.7, 1.1] },
  { projet: 'Stand de vente Résidence Les Tilleuls', libelle: 'Fauteuil client 1', categorie: 'Chaise', couleur: 'Gris anthracite', dims: [0.7, 0.7, 0.8] },
  { projet: 'Stand de vente Résidence Les Tilleuls', libelle: 'Fauteuil client 2', categorie: 'Chaise', couleur: 'Gris anthracite', dims: [0.7, 0.7, 0.8] },
  { projet: 'Stand de vente Résidence Les Tilleuls', libelle: 'Kakémono Les Tilleuls', categorie: 'PLV', couleur: 'Vert', dims: [0.85, 0.3, 2] },
  { projet: 'Bureau témoin Les Jardins', libelle: 'Table de réunion', categorie: 'Bureau', couleur: 'Chêne clair', dims: [2.2, 1, 0.75] },
  { projet: 'Bureau témoin Les Jardins', libelle: 'Chaise de réunion 1', categorie: 'Chaise', couleur: 'Noir', dims: [0.5, 0.5, 0.9] },
  { projet: 'Bureau témoin Les Jardins', libelle: 'Chaise de réunion 2', categorie: 'Chaise', couleur: 'Noir', dims: [0.5, 0.5, 0.9] },
  { projet: 'Bureau témoin Les Jardins', libelle: 'Totem Les Jardins', categorie: 'PLV', couleur: 'Bleu', dims: [1, 0.4, 2] },
];

export async function seedDemoOnSite(url: string, storageDir: string): Promise<number> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const org = (await c.query<{ id: string }>('SELECT id FROM organisation ORDER BY created_at LIMIT 1')).rows[0]?.id;
    if (!org) return 0;
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.role', 'SYSTEM', true)`, [org]);
    const already = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM article WHERE statut = 'RESTITUE'`)).rows[0]!.n;
    const projets = new Map(
      (await c.query<{ nom: string; id: string; entreprise_id: string }>('SELECT nom, id, entreprise_id FROM projet')).rows.map((p) => [p.nom, p]),
    );
    const cats = new Map((await c.query<{ nom: string; id: string; icone: string }>('SELECT nom, id, icone FROM categorie')).rows.map((r) => [r.nom, r]));
    const operateur = (await c.query<{ id: string }>(`SELECT id FROM utilisateur WHERE email = 'operateur@jamystock.test'`)).rows[0]?.id;
    const chauffeur = (await c.query<{ id: string }>(`SELECT id FROM utilisateur WHERE email = 'chauffeur@jamystock.test'`)).rows[0]?.id;
    const quai = (await c.query<{ id: string }>(`SELECT id FROM emplacement ORDER BY code LIMIT 1`)).rows[0]?.id;
    if (already > 0 || !operateur || !chauffeur || !quai) {
      await c.query('ROLLBACK');
      return 0;
    }
    let n = 0;
    for (const [i, o] of PLAN.entries()) {
      const p = projets.get(o.projet);
      const cat = cats.get(o.categorie);
      if (!p || !cat) continue;
      const id = uuidv7();
      await c.query(
        `INSERT INTO article (id, tenant_id, entreprise_id, projet_id, qr_code, libelle, categorie_id, longueur_m, largeur_m, hauteur_m,
                              etat, statut, couleur, date_entree, dernier_mouvement_le, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'BON','RESTITUE',$11, now() - interval '45 days', now() - interval '12 days', $12)`,
        [id, org, p.entreprise_id, p.id, generateQrCode('A'), o.libelle, cat.id, o.dims[0], o.dims[1], o.dims[2], o.couleur, operateur],
      );
      const photoKey = `${org}/demo/${id}.svg`;
      await writeDemoPhoto(storageDir, photoKey, demoPhotoSvg(o.libelle, cat.icone ?? 'box', 40 + i));
      await c.query(
        `INSERT INTO photo (id, tenant_id, article_id, cle_originale, contexte, prise_par, televersee, type_mime)
         VALUES ($1,$2,$3,$4,'RECEPTION',$5,true,'image/svg+xml')`,
        [uuidv7(), org, id, photoKey, operateur],
      );
      const steps: [string, string, string, string, string | null, number][] = [
        ['RECEPTION', 'ATTENDU', 'EN_RECEPTION', operateur, quai, 45],
        ['RANGEMENT', 'EN_RECEPTION', 'EN_STOCK', operateur, quai, 45],
        ['PREPARATION', 'EN_STOCK', 'EN_PREPARATION', operateur, null, 13],
        ['CHARGEMENT', 'EN_PREPARATION', 'EN_TRANSIT', chauffeur, null, 12],
        ['LIVRAISON', 'EN_TRANSIT', 'RESTITUE', chauffeur, null, 12],
      ];
      for (const [k, [type, avant, apres, auteur, vers, jours]] of steps.entries()) {
        await c.query(
          `INSERT INTO mouvement (id, tenant_id, article_id, type, vers_emplacement_id, statut_avant, statut_apres, auteur_id, horodatage_terminal)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() - make_interval(days => $9) + make_interval(mins => $10))`,
          [uuidv7(), org, id, type, vers, avant, apres, auteur, jours, k * 20],
        );
      }
      n++;
    }
    await c.query('COMMIT');
    return n;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
