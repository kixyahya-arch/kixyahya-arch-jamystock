import { earliestDeliveryDate, type Role } from '@jamystock/domain';
import { Database } from './database.js';
import { OrdersService } from '../orders/orders.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.service.js';

/**
 * Demandes de démonstration pour le Back-Office (FLX-01 à 03), créées par le vrai parcours métier
 * (panier, soumission, planification) : numéros, réservations, frise et audit sont donc cohérents.
 * Ne fait rien si la base contient déjà des demandes soumises. Séparé de seed() pour que les tests
 * partent d'un stock entièrement disponible.
 */
export async function seedDemoOrders(url: string, now = new Date()): Promise<number> {
  const db = new Database(url);
  try {
    const tenantId = (await db.pool.query<{ id: string }>('SELECT id FROM organisation ORDER BY created_at LIMIT 1')).rows[0]?.id;
    if (!tenantId) return 0;
    const sys = { tenantId, role: 'SYSTEM' as const };

    const ctx = await db.tx(sys, async (tx) => {
      const existing = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM commande WHERE statut <> 'BROUILLON'`)).rows[0]!.n;
      if (existing > 0) return null;
      const users = new Map(
        (await tx.query<{ email: string; id: string; role: Role; entreprise_id: string | null }>('SELECT email, id, role, entreprise_id FROM utilisateur')).rows.map((u) => [
          u.email,
          { id: u.id, tenantId, role: u.role, entrepriseId: u.entreprise_id, sessionVersion: 0 } satisfies AuthUser,
        ]),
      );
      const articles = async (prefix: string, n: number) =>
        (await tx.query<{ id: string }>(`SELECT id FROM article WHERE statut = 'EN_STOCK' AND libelle LIKE $1 ORDER BY libelle LIMIT $2`, [`${prefix}%`, n])).rows.map((r) => r.id);
      const projet = async (nom: string) => (await tx.query<{ id: string }>('SELECT id FROM projet WHERE nom = $1', [nom])).rows[0]?.id;
      return {
        users,
        chaises: await articles('Chaise visiteur', 3),
        bureaux: await articles('Bureau direction', 2),
        totems: await articles('Totem PLV', 2),
        cartons: await articles('Carton déménagement', 1),
        tilleuls: await projet('Stand de vente Résidence Les Tilleuls'),
        jardins: await projet('Bureau témoin Les Jardins'),
      };
    });
    if (!ctx) return 0;

    const dsg = ctx.users.get('dsg@horizon.test');
    const batir = ctx.users.get('admin@batir.test');
    const camille = ctx.users.get('camille@exemple.test');
    const dispatch = ctx.users.get('dispatch@jamystock.test');
    if (!dsg || !batir || !camille || !dispatch) return 0;

    const orders = new OrdersService(db, new AuditService());
    const earliest = earliestDeliveryDate(now, 48);
    const plus = (days: number) => {
      const d = new Date(`${earliest}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + days);
      if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 2);
      if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    };
    const boulogne = { libelle: '12 rue des Tilleuls, 92100 Boulogne-Billancourt', codePostal: '92100', ville: 'Boulogne-Billancourt' };
    const contact = { nom: 'Paul Leroy', telephone: '06 12 34 56 78' };
    const deliver = async (user: AuthUser, ids: string[], projetId: string | undefined, input: Parameters<OrdersService['submit']>[2]) => {
      if (!ids.length) return null;
      const cart = (await orders.addToCart(user, ids, projetId)) as { id: string };
      return (await orders.submit(user, cart.id, input, now)) as { id: string };
    };

    let n = 0;
    // 1. livraison urgente : date souhaitée ramenée à demain pour montrer le badge « urgent » (FLX-01)
    const urgent = await deliver(dsg, ctx.chaises, ctx.tilleuls, {
      type: 'LIVRAISON',
      adresse: boulogne,
      contactSite: contact,
      contraintesAcces: { etage: 2, accesPL: false, consignes: 'Badge à récupérer à l’accueil du chantier.' },
      dateSouhaitee: earliest,
      creneau: '08:00-12:00',
    });
    if (urgent) {
      n++;
      const demain = new Date(now);
      demain.setUTCDate(demain.getUTCDate() + 1);
      await db.tx(sys, (tx) => tx.query('UPDATE commande SET date_souhaitee = $2 WHERE id = $1', [urgent.id, demain.toISOString().slice(0, 10)]));
    }
    // 2. livraison à confirmer la semaine suivante
    if (
      await deliver(dsg, ctx.bureaux, ctx.jardins, {
        type: 'LIVRAISON',
        adresse: { libelle: '4 allée des Jardins, 94300 Vincennes', codePostal: '94300', ville: 'Vincennes' },
        contactSite: { nom: 'Sophie Arnaud', telephone: '06 98 76 54 32' },
        dateSouhaitee: plus(5),
        creneau: '13:00-17:00',
      })
    )
      n++;
    // 3. retrait au dépôt par une particulière
    if (await deliver(camille, ctx.cartons, undefined, { type: 'RETRAIT', dateSouhaitee: plus(3), creneau: '10:00-12:00' })) n++;
    // 4. collecte chez un autre client B2B
    await orders.requestCollection(
      batir,
      {
        adresse: { libelle: '27 quai de la Loire, 75019 Paris', codePostal: '75019', ville: 'Paris' },
        contactSite: { nom: 'Karim Benali', telephone: '07 11 22 33 44' },
        dateSouhaitee: plus(2),
        creneau: '08:00-12:00',
        description: 'Fin de chantier : mobilier de bungalow à rentrer au dépôt.',
        volumeEstimeM3: 6,
        lignes: [
          { description: 'Bureaux de chantier', quantite: 4 },
          { description: 'Armoires métalliques', quantite: 2 },
        ],
      },
      now,
    );
    n++;
    // 5. livraison déjà planifiée : ses missions (préparation la veille, livraison le jour J) sont à affecter (FLX-03)
    const planned = await deliver(dsg, ctx.totems, ctx.tilleuls, {
      type: 'LIVRAISON',
      adresse: boulogne,
      contactSite: contact,
      dateSouhaitee: plus(1),
      creneau: '08:00-12:00',
    });
    if (planned) {
      await orders.plan(dispatch, planned.id, { date: plus(1), creneau: '08:00-12:00' });
      n++;
    }
    return n;
  } finally {
    await db.close();
  }
}

