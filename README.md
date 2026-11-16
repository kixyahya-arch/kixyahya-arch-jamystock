# JAMYSTOCK

Plateforme SaaS de stockage tracé B2B/B2C : chaque objet confié est photographié, étiqueté par QR code,
localisé à l'emplacement près, restituable depuis un panier, et facturé automatiquement au m² occupé.

Ce dépôt suit le cahier des charges v1.0 (16 novembre 2026). Les identifiants d'exigences (INV-01, RG-M2-04…)
sont repris dans le code et les tests.

## Architecture

Monolithe modulaire TypeScript (§7.1) :

```
packages/domain   Règles métier pures, sans I/O : machine à états des commandes, mouvements d'articles,
                  calcul des m² (RG-M2-01 à 04), moteur de facturation (RG-M2-05/06), alertes forfait,
                  matrice de permissions, QR codes, UUID v7, planification.
apps/api          API NestJS (REST) sur PostgreSQL 16 : authentification, RBAC à portée, RLS, audit,
                  inventaire, panier et commandes.
apps/api/migrations  Schéma SQL complet du MCD (§5) et politiques Row-Level Security.
```

À venir : `apps/web` (Next.js : Espace Client + Back-Office), `apps/terrain` (PWA hors-ligne), workers BullMQ.

### Principes clés

- **Journal de mouvements immuable** : la position et le statut d'un article sont une projection de ses mouvements,
  mise à jour dans la même transaction. Un déclencheur interdit toute modification du journal.
- **Isolation des clients en profondeur** : l'API vérifie la permission de la route, puis chaque transaction pose
  son contexte (`app.tenant_id`, `app.role`, `app.entreprise_id`, `app.user_id`) et la RLS PostgreSQL filtre les lignes.
  Un B2B Utilisateur ne voit que les projets qui lui sont attribués. L'API se connecte avec un rôle sans `BYPASSRLS`.
- **Machine à états côté serveur** (§6.4) : toute transition non listée est refusée (HTTP 409).
- **Un article dans une seule commande active** : index unique partiel sur `ligne_commande`.
- **Factures immuables après émission**, numérotation continue sans trou (`prochain_numero`).
- **Montants en centimes**, identifiants UUID v7 générables hors-ligne.

## Démarrer en local

Prérequis : Node 22, pnpm 10, PostgreSQL 16 (ou `docker compose up -d`).

```bash
pnpm install
./scripts/dev-db.sh jamystock          # crée la base et les rôles (PSQL="psql -h localhost -U postgres" avec Docker)
./scripts/dev-db.sh jamystock_test
cp apps/api/.env.example apps/api/.env  # puis renseigner JWT_SECRET
export $(grep -v '^#' apps/api/.env | xargs)
pnpm db:migrate
pnpm db:seed                            # affiche le TENANT_ID à reporter dans .env
pnpm --filter @jamystock/domain build
pnpm dev:api                            # http://localhost:3000
```

Comptes de démonstration (mot de passe `demo-jamystock`) : `admin@jamystock.test` (Super Admin),
`dispatch@jamystock.test`, `operateur@jamystock.test`, `chauffeur@jamystock.test`, `dsg@horizon.test` (B2B Admin),
`chef.projet@horizon.test` et `conducteur@horizon.test` (B2B Utilisateurs), `admin@batir.test` (autre client B2B),
`camille@exemple.test` (B2C).

## Tests

```bash
pnpm test        # domaine (unitaires) + API (bout en bout sur jamystock_test, base réinitialisée à chaque fichier)
pnpm typecheck
```

Les tests couvrent l'exemple chiffré du cahier des charges (forfait 120 m², 131,2 m² moyens → 1 995,50 € HT),
l'isolation entre clients et entre projets (API et RLS directe), la rotation des jetons, la révocation immédiate
des sessions, et le parcours panier → soumission → contre-proposition → planification → annulation.

## API (v1)

| Méthode | Route | Rôle | Exigence |
|---|---|---|---|
| POST | `/api/v1/auth/login`, `/refresh`, `/logout` | public | §7.3 |
| GET | `/api/v1/auth/me` | tous | |
| GET | `/api/v1/articles?projet&depot&categorie&etat&statut&q&apres&limite` | tous | INV-01, INV-03 |
| GET | `/api/v1/articles/:id` | tous | INV-02 |
| GET / POST / DELETE | `/api/v1/cart`, `/cart/items`, `/cart/items/:articleId` | clients | CMD-01 |
| POST | `/api/v1/orders/:id/submit` | clients | CMD-02 à 05 |
| POST | `/api/v1/collections` | clients | CMD-06 |
| POST | `/api/v1/orders/:id/approve`, `/reject` | B2B Admin | CMD-05 |
| POST | `/api/v1/orders/:id/cancel` | clients, exploitant | CMD-07, RG-CMD-03 |
| POST | `/api/v1/orders/:id/plan`, `/counter-propose` | Dispatcher | FLX-02 |
| POST | `/api/v1/orders/:id/accept-date` | clients | FLX-02 |
| GET | `/api/v1/orders`, `/orders/:id` | tous | SUI-01 |

## Feuille de route

- **A. Socle** (fait) : monorepo, domaine, schéma, auth, RBAC + RLS, audit, panier et commandes, CI.
- **B. Tranche verticale** : réception terrain (photo + QR + emplacement, hors-ligne), préparation et chargement par scan,
  livraison avec signature du BL et empreinte SHA-256, Espace Client (inventaire, panier, suivi) et Back-Office (dispatch).
- **C. Facturation** : instantané m² quotidien, factures mensuelles et avoirs, Stripe.
- **D. Reste du MVP** : génération d'emplacements en masse, étiquettes QR (PDF / ZPL), gestion des utilisateurs B2B,
  documents, notifications email.

Voir [docs/points-ouverts.md](docs/points-ouverts.md) pour les questions à trancher avec le client et les hypothèses prises.
