import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { uuidv7 } from '@jamystock/domain';

/**
 * Pack de démonstration avec un visuel d'aménagement : l'accueil du bureau de vente des Tilleuls (deux chaises
 * visiteur et un totem), illustré par une image générée par Higgsfield à partir de ces meubles. Il montre la page
 * d'un pack, la planche et la vue 3D sans clé Higgsfield. Le visuel est réécrit au démarrage si le stockage l'a
 * perdu (Render gratuit). Se relance sans effet de bord.
 */
const NOM = 'Bureau de vente Les Tilleuls';
const PROJET = 'Stand de vente Résidence Les Tilleuls';
const BIENS: [string, string][] = [
  ['Chaise visiteur 1', 'Accueil'],
  ['Chaise visiteur 2', 'Accueil'],
  ['Totem PLV 1', 'Accueil'],
  ["Bureau d'accueil 1", 'Bureau'],
  ["Bureau d'accueil 2", 'Bureau'],
];
const IMAGE = ['../../assets/demo/ambiance-accueil.jpg', '../../../assets/demo/ambiance-accueil.jpg']
  .map((rel) => fileURLToPath(new URL(rel, import.meta.url)))
  .find((f) => existsSync(f));

export async function seedDemoPacks(url: string, storageDir: string): Promise<number> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const org = (await c.query<{ id: string }>('SELECT id FROM organisation ORDER BY created_at LIMIT 1')).rows[0]?.id;
    if (!org || !IMAGE) return 0;
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.role', 'SYSTEM', true)`, [org]);
    const projet = (await c.query<{ id: string; entreprise_id: string }>('SELECT id, entreprise_id FROM projet WHERE nom = $1', [PROJET])).rows[0];
    const auteur = (await c.query<{ id: string }>(`SELECT id FROM utilisateur WHERE email = 'dsg@horizon.test'`)).rows[0]?.id;
    const key = `${org}/ambiances/demo-accueil.jpg`;
    let created = 0;
    if (projet && auteur && !(await c.query('SELECT 1 FROM modele_panier WHERE nom = $1', [NOM])).rowCount) {
      const arts = await c.query<{ id: string; libelle: string }>('SELECT id, libelle FROM article WHERE projet_id = $1 AND libelle = ANY($2::text[])', [
        projet.id,
        BIENS.map((b) => b[0]),
      ]);
      const byName = new Map(arts.rows.map((a) => [a.libelle, a.id]));
      const ids: string[] = [];
      const pieces: Record<string, string> = {};
      for (const [libelle, piece] of BIENS) {
        const id = byName.get(libelle);
        if (!id) continue;
        ids.push(id);
        pieces[id] = piece;
      }
      if (ids.length) {
        const packId = uuidv7();
        await c.query(
          `INSERT INTO modele_panier (id, tenant_id, entreprise_id, projet_id, nom, description, article_ids, pieces, cree_par) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [packId, org, projet.entreprise_id, projet.id, NOM, 'Accueil des acquéreurs et bureau des conseillers', ids, JSON.stringify(pieces), auteur],
        );
        await c.query(
          `INSERT INTO pack_ambiance (id, tenant_id, pack_id, entreprise_id, projet_id, piece, source, statut, cle, request_id, cree_par, termine_le)
           VALUES ($1,$2,$3,$4,$5,'Accueil','IA','PRET',$6,'demo-higgsfield',$7,now())`,
          [uuidv7(), org, packId, projet.entreprise_id, projet.id, key, auteur],
        );
        created = 1;
      }
    }
    await c.query('COMMIT');
    const file = path.resolve(storageDir, key);
    if (!existsSync(file)) {
      await mkdir(path.dirname(file), { recursive: true });
      await copyFile(IMAGE, file);
    }
    return created;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
