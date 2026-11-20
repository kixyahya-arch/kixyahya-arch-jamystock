import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { isIP } from 'node:net';
import { z } from 'zod';
import { clientKey, generateQrCode, isValidSiret, normalizeCode, normalizeSiret, parseRepriseArticles, parseRepriseClients, uuidv7 } from '@jamystock/domain';
import type { RepriseArticleRow, RepriseIssue } from '@jamystock/domain';
import { CONFIG, DATABASE } from '../common/tokens.js';
import type { AppConfig } from '../config.js';
import type { Database, Tx } from '../db/database.js';
import { CurrentUser, RequirePermission } from '../auth/decorators.js';
import type { AuthUser } from '../auth/auth.service.js';
import { ctxOf } from '../common/context.js';
import { notFound, unprocessable } from '../common/errors.js';
import { AuditService } from '../audit/audit.service.js';
import { StorageService } from '../storage/storage.service.js';
import { createInvitation } from '../accounts/invitations.js';

const uuid = z.string().uuid();
const MAX_LIGNES = 10_000;
const MAX_ARTICLES = 20_000;
const MOTIF = 'Reprise des données de l’ancien logiciel';

const ClientsBody = z.object({
  csv: z.string().min(1).max(5_000_000),
  dryRun: z.boolean().default(true),
  /** Envoie tout de suite le lien d'activation. Par défaut non : les invitations partent le jour de la bascule. */
  inviter: z.boolean().default(false),
});

const ArticlesBody = z.object({
  csv: z.string().min(1).max(20_000_000),
  dryRun: z.boolean().default(true),
  depotId: uuid,
  /** Emplacement où ranger les objets dont l'emplacement d'origine n'existe pas (encore) dans JAMYSTOCK. */
  emplacementParDefautId: uuid,
  clientParDefaut: z.string().trim().min(2).max(200).optional(),
  /** Crée les clients (B2B, sans contact) qui n'existent pas encore ; sinon leurs lignes sont en erreur. */
  creerClients: z.boolean().default(true),
});

const PhotosBody = z.object({ lot: z.number().int().min(1).max(100).default(25) });

interface Entreprise {
  id: string;
  nom: string;
}

/**
 * Reprise des données de l'ancien logiciel de stock (export CSV Monstock / « JAMYSO STOCK »).
 * Toujours en deux temps : aperçu (`dryRun`, rien n'est écrit) puis import. L'import est rejouable :
 * les lignes déjà reprises sont reconnues à leur clé d'origine et ignorées.
 */
@Controller('bo/reprise')
export class RepriseController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  /** Où en est la reprise : articles repris, photos à rapatrier. */
  @Get()
  @RequirePermission('client.manage')
  etat(@CurrentUser() user: AuthUser) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const a = (
        await tx.query<{ articles: number; clients: number }>(
          `SELECT count(*)::int AS articles, count(DISTINCT entreprise_id)::int AS clients FROM article WHERE origine_import IS NOT NULL`,
        )
      ).rows[0]!;
      const p = await tx.query<{ statut: string; n: number }>(`SELECT statut, count(*)::int AS n FROM reprise_photo GROUP BY statut`);
      const photos = Object.fromEntries(['A_TELECHARGER', 'TELECHARGEE', 'ECHEC'].map((s) => [s, p.rows.find((r) => r.statut === s)?.n ?? 0]));
      const echecs = await tx.query<{ url: string; erreur: string | null; libelle: string }>(
        `SELECT r.url, r.erreur, a.libelle FROM reprise_photo r JOIN article a ON a.id = r.article_id WHERE r.statut = 'ECHEC' ORDER BY r.created_at LIMIT 50`,
      );
      return { ...a, photos, echecs: echecs.rows };
    });
  }

  // ------------------------------------------------------------------ comptes clients

  @Post('clients')
  @HttpCode(200)
  @RequirePermission('client.manage')
  importClients(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = ClientsBody.parse(body);
    const parsed = parseRepriseClients(b.csv);
    if (parsed.rows.length > MAX_LIGNES) throw unprocessable('TROP_DE_LIGNES', `${MAX_LIGNES} lignes au plus par import`);
    return this.db.tx(ctxOf(user), async (tx) => {
      const entreprises = await this.entreprises(tx);
      const emails = new Map(
        (await tx.query<{ email: string; entreprise_id: string | null }>(`SELECT lower(email) AS email, entreprise_id FROM utilisateur`)).rows.map((u) => [
          u.email,
          u.entreprise_id,
        ]),
      );
      const errors: RepriseIssue[] = [...parsed.errors];
      const apercu: { line: number; client: string; action: 'CREE' | 'EXISTANT'; contact: string | null; contactAction: 'CREE' | 'EXISTANT' | 'AUCUN' }[] = [];
      const plan = parsed.rows.filter((r) => {
        const ent = entreprises.get(clientKey(r.client));
        const owner = r.email ? emails.get(r.email) : undefined;
        if (r.email && owner !== undefined && (!ent || owner !== ent.id)) {
          errors.push({ line: r.line, message: `l’e-mail ${r.email} appartient déjà à un autre compte` });
          return false;
        }
        apercu.push({
          line: r.line,
          client: ent?.nom ?? r.client,
          action: ent ? 'EXISTANT' : 'CREE',
          contact: r.email,
          contactAction: !r.email ? 'AUCUN' : owner !== undefined ? 'EXISTANT' : 'CREE',
        });
        return true;
      });
      errors.sort((x, y) => x.line - y.line);
      const out = {
        lignes: parsed.rows.length + parsed.errors.length,
        valides: plan.length,
        colonnes: parsed.colonnes,
        ignorees: parsed.ignorees,
        erreurs: errors.slice(0, 200),
        nbErreurs: errors.length,
        apercu: apercu.slice(0, 200),
        clientsCrees: apercu.filter((a) => a.action === 'CREE').length,
        contactsCrees: apercu.filter((a) => a.contactAction === 'CREE').length,
      };
      if (b.dryRun) return { ...out, invitations: 0 };

      let invitations = 0;
      const me = (await tx.query<{ nom: string }>('SELECT nom FROM utilisateur WHERE id = $1', [user.id])).rows[0];
      for (const r of plan) {
        const key = clientKey(r.client);
        let ent = entreprises.get(key);
        if (!ent) {
          ent = { id: uuidv7(), nom: r.client };
          const siret = r.siret && isValidSiret(r.siret) ? normalizeSiret(r.siret) : null;
          await tx.query(`INSERT INTO entreprise (id, tenant_id, type, nom, siret, adresse_facturation, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
            ent.id,
            user.tenantId,
            r.type,
            r.client,
            siret,
            r.adresse ? { libelle: r.adresse } : null,
            user.id,
          ]);
          entreprises.set(key, ent);
        }
        for (const p of r.type === 'B2B' ? r.projets : []) await this.projet(tx, user, ent.id, p);
        if (r.email && !emails.has(r.email)) {
          const id = uuidv7();
          await tx.query(
            `INSERT INTO utilisateur (id, tenant_id, entreprise_id, email, telephone, nom, role, statut, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,'INVITE',$8)`,
            [id, user.tenantId, ent.id, r.email, r.telephone, r.contactNom ?? r.email, r.type === 'B2B' ? 'B2B_ADMIN' : 'B2C', user.id],
          );
          emails.set(r.email, ent.id);
          if (b.inviter) {
            await createInvitation(tx, {
              tenantId: user.tenantId,
              utilisateurId: id,
              entrepriseId: ent.id,
              createdBy: user.id,
              invitePar: me?.nom ?? 'JAMYSTOCK',
              publicUrl: this.config.publicUrl,
            });
            invitations++;
          }
        }
      }
      await this.audit.record(tx, user, {
        action: 'REPRISE_CLIENTS',
        objet: 'organisation',
        objetId: user.tenantId,
        apres: { clients: out.clientsCrees, contacts: out.contactsCrees, invitations },
      });
      return { ...out, invitations };
    });
  }

  /** Envoie le lien d'activation à tous les contacts repris qui ne l'ont pas encore reçu : à lancer le jour de la bascule. */
  @Post('invitations')
  @HttpCode(200)
  @RequirePermission('client.manage')
  inviteAll(@CurrentUser() user: AuthUser) {
    return this.db.tx(ctxOf(user), async (tx) => {
      const me = (await tx.query<{ nom: string }>('SELECT nom FROM utilisateur WHERE id = $1', [user.id])).rows[0];
      const pending = await tx.query<{ id: string; entreprise_id: string }>(
        `SELECT u.id, u.entreprise_id FROM utilisateur u
          WHERE u.statut = 'INVITE' AND u.entreprise_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM invitation i WHERE i.utilisateur_id = u.id)`,
      );
      for (const u of pending.rows) {
        await createInvitation(tx, {
          tenantId: user.tenantId,
          utilisateurId: u.id,
          entrepriseId: u.entreprise_id,
          createdBy: user.id,
          invitePar: me?.nom ?? 'JAMYSTOCK',
          publicUrl: this.config.publicUrl,
        });
      }
      await this.audit.record(tx, user, {
        action: 'REPRISE_INVITATIONS',
        objet: 'organisation',
        objetId: user.tenantId,
        apres: { invitations: pending.rows.length },
      });
      return { invitations: pending.rows.length };
    });
  }

  // ------------------------------------------------------------------ stock

  @Post('articles')
  @HttpCode(200)
  @RequirePermission('client.manage')
  importArticles(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = ArticlesBody.parse(body);
    const parsed = parseRepriseArticles(b.csv, { clientParDefaut: b.clientParDefaut ?? null });
    if (parsed.rows.length > MAX_LIGNES) throw unprocessable('TROP_DE_LIGNES', `${MAX_LIGNES} lignes au plus par import`);
    return this.db.tx(ctxOf(user), async (tx) => {
      const depot = (await tx.query<{ id: string }>('SELECT id FROM depot WHERE id = $1', [b.depotId])).rows[0];
      if (!depot) throw notFound('Dépôt');
      const defaut = (
        await tx.query<{ id: string }>(`SELECT e.id FROM emplacement e JOIN zone z ON z.id = e.zone_id WHERE e.id = $1 AND z.depot_id = $2 AND e.adressable`, [
          b.emplacementParDefautId,
          b.depotId,
        ])
      ).rows[0];
      if (!defaut) throw unprocessable('EMPLACEMENT', 'L’emplacement par défaut doit être un emplacement de ce dépôt');
      const locations = new Map(
        (
          await tx.query<{ id: string; code: string }>(
            `SELECT e.id, e.code FROM emplacement e JOIN zone z ON z.id = e.zone_id WHERE z.depot_id = $1 AND e.adressable AND e.statut = 'ACTIF'`,
            [b.depotId],
          )
        ).rows.map((e) => [normalizeCode(e.code), e.id]),
      );
      const entreprises = await this.entreprises(tx);
      const already = new Set(
        (
          await tx.query<{ origine_import: string }>(`SELECT origine_import FROM article WHERE origine_import = ANY($1::text[])`, [
            parsed.rows.flatMap((r) => Array.from({ length: r.quantite }, (_, k) => `${r.origine}#${k + 1}`)),
          ])
        ).rows.map((r) => r.origine_import),
      );

      const errors: RepriseIssue[] = [...parsed.errors];
      const avertissements: RepriseIssue[] = [];
      const nouveauxClients = new Set<string>();
      const plan: (RepriseArticleRow & { aCreer: number; emplacementId: string })[] = [];
      for (const r of parsed.rows) {
        const key = clientKey(r.client);
        if (!entreprises.has(key)) {
          if (!b.creerClients) {
            errors.push({ line: r.line, message: `client « ${r.client} » inconnu : importez d’abord les comptes clients` });
            continue;
          }
          nouveauxClients.add(r.client);
        }
        let emplacementId = defaut.id;
        if (r.emplacement) {
          const found = locations.get(normalizeCode(r.emplacement));
          if (found) emplacementId = found;
          else avertissements.push({ line: r.line, message: `emplacement « ${r.emplacement} » absent du dépôt : rangé à l’emplacement par défaut` });
        }
        const aCreer = Array.from({ length: r.quantite }, (_, k) => `${r.origine}#${k + 1}`).filter((o) => !already.has(o)).length;
        plan.push({ ...r, aCreer, emplacementId });
      }
      const total = plan.reduce((s, r) => s + r.aCreer, 0);
      if (total > MAX_ARTICLES) throw unprocessable('TROP_D_ARTICLES', `${total} articles à créer : ${MAX_ARTICLES} au plus par import, découpez le fichier`);
      errors.sort((x, y) => x.line - y.line);
      const out = {
        lignes: parsed.rows.length + parsed.errors.length,
        valides: plan.length,
        colonnes: parsed.colonnes,
        ignorees: parsed.ignorees,
        erreurs: errors.slice(0, 200),
        nbErreurs: errors.length,
        avertissements: avertissements.slice(0, 200),
        nbAvertissements: avertissements.length,
        nouveauxClients: [...nouveauxClients],
        articlesACreer: total,
        dejaRepris: plan.reduce((s, r) => s + r.quantite - r.aCreer, 0),
        photos: plan.reduce((s, r) => s + (r.aCreer ? r.photos.length * r.aCreer : 0), 0),
        apercu: plan.slice(0, 200).map((r) => ({
          line: r.line,
          client: entreprises.get(clientKey(r.client))?.nom ?? r.client,
          projet: r.projet,
          libelle: r.libelle,
          categorie: r.categorie,
          quantite: r.quantite,
          aCreer: r.aCreer,
          emplacement: r.emplacement,
          photos: r.photos.length,
        })),
      };
      if (b.dryRun) return { ...out, cree: 0 };
      if (errors.length) throw unprocessable('IMPORT_INVALIDE', `${errors.length} ligne(s) en erreur : corrigez le fichier puis relancez l’import`);

      const categories = new Map((await tx.query<{ id: string; nom: string }>('SELECT id, nom FROM categorie')).rows.map((c) => [clientKey(c.nom), c.id]));
      const projets = new Map<string, string>();
      let cree = 0;
      for (const r of plan) {
        if (!r.aCreer) continue;
        const key = clientKey(r.client);
        let ent = entreprises.get(key);
        if (!ent) {
          ent = { id: uuidv7(), nom: r.client };
          await tx.query(`INSERT INTO entreprise (id, tenant_id, type, nom, created_by) VALUES ($1,$2,'B2B',$3,$4)`, [
            ent.id,
            user.tenantId,
            r.client,
            user.id,
          ]);
          entreprises.set(key, ent);
        }
        let projetId: string | null = null;
        if (r.projet) {
          const pk = `${ent.id}|${clientKey(r.projet)}`;
          projetId = projets.get(pk) ?? (await this.projet(tx, user, ent.id, r.projet));
          projets.set(pk, projetId);
        }
        let categorieId: string | null = null;
        if (r.categorie) {
          const ck = clientKey(r.categorie);
          categorieId = categories.get(ck) ?? null;
          if (!categorieId) {
            categorieId = uuidv7();
            await tx.query(`INSERT INTO categorie (id, tenant_id, nom) VALUES ($1,$2,$3)`, [categorieId, user.tenantId, r.categorie]);
            categories.set(ck, categorieId);
          }
        }
        const entree = r.dateEntree ? new Date(r.dateEntree) : new Date();
        for (let k = 1; k <= r.quantite; k++) {
          const origine = `${r.origine}#${k}`;
          if (already.has(origine)) continue;
          const id = uuidv7();
          await tx.query(
            `INSERT INTO article (id, tenant_id, entreprise_id, projet_id, qr_code, libelle, reference_interne, categorie_id, description,
                                  longueur_m, largeur_m, hauteur_m, poids_kg, etat, statut, emplacement_courant_id, date_entree,
                                  dernier_mouvement_le, origine_import, ancien_code, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'EN_STOCK',$15,$16,now(),$17,$18,$19)`,
            [
              id,
              user.tenantId,
              ent.id,
              projetId,
              generateQrCode('A'),
              r.quantite > 1 ? `${r.libelle} (${k}/${r.quantite})` : r.libelle,
              r.reference,
              categorieId,
              r.description,
              r.longueurM,
              r.largeurM,
              r.hauteurM,
              r.poidsKg,
              r.etat,
              r.emplacementId,
              entree,
              origine,
              r.codeBarres,
              user.id,
            ],
          );
          await tx.query(
            `INSERT INTO mouvement (id, tenant_id, article_id, type, vers_emplacement_id, statut_avant, statut_apres, auteur_id, appareil_id, horodatage_terminal, motif)
             VALUES ($1,$2,$3,'RECEPTION',$4,'ATTENDU','EN_STOCK',$5,'reprise',now(),$6)`,
            [uuidv7(), user.tenantId, id, r.emplacementId, user.id, MOTIF],
          );
          for (const url of r.photos) {
            await tx.query(`INSERT INTO reprise_photo (id, tenant_id, article_id, url) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [
              uuidv7(),
              user.tenantId,
              id,
              url,
            ]);
          }
          cree++;
        }
      }
      await this.audit.record(tx, user, {
        action: 'REPRISE_ARTICLES',
        objet: 'depot',
        objetId: b.depotId,
        apres: { cree, clientsCrees: out.nouveauxClients.length, avertissements: avertissements.length },
      });
      return { ...out, cree };
    });
  }

  // ------------------------------------------------------------------ photos

  /** Rapatrie un lot de photos de l'ancien logiciel. À relancer jusqu'à ce qu'il n'en reste plus. */
  @Post('photos')
  @HttpCode(200)
  @RequirePermission('client.manage')
  async importPhotos(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    const b = PhotosBody.parse(body ?? {});
    const todo = await this.db.tx(ctxOf(user), (tx) =>
      tx.query<{ id: string; article_id: string; url: string; essais: number }>(
        `SELECT id, article_id, url, essais FROM reprise_photo WHERE statut = 'A_TELECHARGER' ORDER BY created_at, id LIMIT $1`,
        [b.lot],
      ),
    );
    let ok = 0;
    let echecs = 0;
    for (const p of todo.rows) {
      const res = await this.download(p.url);
      await this.db.tx(ctxOf(user), async (tx) => {
        if ('error' in res) {
          const final = res.definitive || p.essais + 1 >= 3;
          await tx.query(`UPDATE reprise_photo SET essais = essais + 1, erreur = $2, statut = $3 WHERE id = $1`, [
            p.id,
            res.error,
            final ? 'ECHEC' : 'A_TELECHARGER',
          ]);
          echecs++;
          return;
        }
        const photoId = uuidv7();
        const key = `${user.tenantId}/photos/${photoId}/original.${res.ext}`;
        await this.storage.put(key, res.data);
        await tx.query(
          `INSERT INTO photo (id, tenant_id, article_id, cle_originale, contexte, prise_le, prise_par, televersee, type_mime, taille_octets)
           VALUES ($1,$2,$3,$4,'RECEPTION',now(),$5,true,$6,$7)`,
          [photoId, user.tenantId, p.article_id, key, user.id, res.mime, res.data.length],
        );
        await tx.query(`UPDATE reprise_photo SET statut = 'TELECHARGEE', photo_id = $2, erreur = NULL, essais = essais + 1 WHERE id = $1`, [p.id, photoId]);
        ok++;
      });
    }
    const restant = (
      await this.db.tx(ctxOf(user), (tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM reprise_photo WHERE statut = 'A_TELECHARGER'`))
    ).rows[0]!.n;
    return { telechargees: ok, echecs, restant };
  }

  private async download(url: string): Promise<{ data: Buffer; mime: string; ext: string } | { error: string; definitive: boolean }> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { error: 'adresse invalide', definitive: true };
    }
    if (!['http:', 'https:'].includes(u.protocol)) return { error: 'adresse invalide', definitive: true };
    if (!this.config.reprisePhotosLocal && isPrivateHost(u.hostname)) return { error: 'adresse privée refusée', definitive: true };
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
      if (!res.ok) return { error: `HTTP ${res.status}`, definitive: res.status === 404 || res.status === 410 || res.status === 403 };
      const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic' }[mime];
      if (!ext) return { error: `pas une image (${mime || 'type inconnu'})`, definitive: true };
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > 15 * 1024 * 1024) return { error: 'image de plus de 15 Mo', definitive: true };
      if (!data.length) return { error: 'fichier vide', definitive: true };
      return { data, mime, ext };
    } catch (e) {
      return { error: e instanceof Error ? e.message.slice(0, 200) : 'téléchargement impossible', definitive: false };
    }
  }

  // ------------------------------------------------------------------ outils

  private async entreprises(tx: Tx): Promise<Map<string, Entreprise>> {
    const rows = (await tx.query<Entreprise>('SELECT id, nom FROM entreprise ORDER BY created_at')).rows;
    const map = new Map<string, Entreprise>();
    for (const e of rows) if (!map.has(clientKey(e.nom))) map.set(clientKey(e.nom), e);
    return map;
  }

  private async projet(tx: Tx, user: AuthUser, entrepriseId: string, nom: string): Promise<string> {
    const existing = (await tx.query<{ id: string; nom: string }>('SELECT id, nom FROM projet WHERE entreprise_id = $1', [entrepriseId])).rows.find(
      (p) => clientKey(p.nom) === clientKey(nom),
    );
    if (existing) return existing.id;
    const id = uuidv7();
    await tx.query(`INSERT INTO projet (id, tenant_id, entreprise_id, nom, created_by) VALUES ($1,$2,$3,$4,$5)`, [
      id,
      user.tenantId,
      entrepriseId,
      nom,
      user.id,
    ]);
    return id;
  }
}

/** Refuse les adresses locales ou privées (les URL viennent d'un fichier importé). */
export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (isIP(h) === 4) {
    const [a, b2] = h.split('.').map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b2 === 254) ||
      (a === 172 && b2 >= 16 && b2 <= 31) ||
      (a === 192 && b2 === 168) ||
      (a === 100 && b2 >= 64 && b2 <= 127)
    );
  }
  if (isIP(h) === 6) return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:');
  return false;
}
