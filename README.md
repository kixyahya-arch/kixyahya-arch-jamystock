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
apps/terrain      PWA hors-ligne (Vite + React) : réception, déplacement, préparation, chargement,
                  livraison signée, collecte. Base locale IndexedDB et file d'envoi ordonnée.
apps/client       Espace Client (Vite + React) : stock en vignettes, fiche, filtres, jauge m², panier,
                  livraison ou retrait, suivi et validation des commandes, demande de collecte.
apps/admin        Back-Office (Vite + React) : demandes en Kanban, confirmation des dates, planning
                  des missions par ressource, comptes clients, stock global.
```

À venir : Back-Office (entrepôt, facturation), workers BullMQ.

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
pnpm --filter @jamystock/terrain dev    # app terrain sur http://localhost:5173/terrain/ (relaie /api vers :3000)
pnpm --filter @jamystock/client dev     # Espace Client sur http://localhost:5174
pnpm --filter @jamystock/admin dev      # Back-Office sur http://localhost:5175/admin/ (admin@ ou dispatch@jamystock.test)
```

Sur téléphone, la caméra exige HTTPS (ou `localhost`) : passer par un tunnel HTTPS ou utiliser la saisie
manuelle / douchette, toujours disponible sous le bouton « Scanner ».

Comptes de démonstration (mot de passe `demo-jamystock`) : `admin@jamystock.test` (Super Admin),
`dispatch@jamystock.test`, `operateur@jamystock.test`, `chauffeur@jamystock.test`, `dsg@horizon.test` (B2B Admin),
`chef.projet@horizon.test` et `conducteur@horizon.test` (B2B Utilisateurs), `admin@batir.test` (autre client B2B),
`camille@exemple.test` (B2C).

## Mise en ligne

Une seule adresse : l'API sert aussi l'Espace Client (`/`), l'app terrain (`/terrain/`) et le Back-Office (`/admin/`),
si `CLIENT_DIST`, `TERRAIN_DIST` et `ADMIN_DIST` pointent vers leurs builds. Pas de CORS ni de proxy à configurer.

**Render (démo)** : le fichier [render.yaml](render.yaml) décrit tout. Dans Render : *New > Blueprint*, choisir ce dépôt,
saisir le mot de passe des comptes de démonstration (`DEMO_PASSWORD`, le dépôt étant public), valider.
Render crée la base PostgreSQL 16 (Francfort) et le service web, génère `JWT_SECRET` et `APP_DB_PASSWORD`, puis déploie
la branche `main` à chaque fusion.

Au démarrage, `apps/api/dist/src/db/provision.js` prépare la base avec l'URL propriétaire (`DATABASE_URL`) :
extensions, rôles `jamystock_app` / `jamystock_api`, migrations, données de démonstration si `SEED_DEMO=true` et la base
est vide. Il se relance sans effet de bord. L'API se connecte ensuite avec `jamystock_api` (URL dérivée de `DATABASE_URL`
et `APP_DB_PASSWORD`) et **refuse de démarrer** avec un rôle superutilisateur ou `BYPASSRLS`. Sans `TENANT_ID`,
l'organisation unique de la base est prise.

Ailleurs (VM, Docker, autre PaaS) : même principe.

```bash
pnpm install --frozen-lockfile && pnpm build
DATABASE_URL=… APP_DB_PASSWORD=… JWT_SECRET=… CLIENT_DIST=apps/client/dist TERRAIN_DIST=apps/terrain/dist \
  sh -c 'node apps/api/dist/src/db/provision.js && node apps/api/dist/src/main.js'
```

Offre gratuite de Render : le service s'endort après 15 min sans visite (réveil en une minute environ), la base gratuite
expire au bout de 30 jours (passer en *basic-256mb*), et sans disque persistant les photos prises sur le terrain sont
perdues au redémarrage (les illustrations de démonstration sont réécrites). Pour un vrai pilote : offre *starter*, disque
monté sur `STORAGE_DIR`, ou stockage objet S3 (prévu).

## Tests

```bash
pnpm test        # domaine (unitaires) + API (bout en bout sur jamystock_test, base réinitialisée à chaque fichier)
                 # + app terrain (file d'envoi sur IndexedDB simulée, empreinte BL identique terminal/serveur)
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
| GET / POST / DELETE | `/api/v1/cart`, `/cart/items`, `/cart/items/:articleId` (avec estimation : date au plus tôt, coût, livraisons incluses) | clients | CMD-01, CMD-04 |
| GET | `/api/v1/me/context`, `/me/surface` | clients | INV-03, INV-04, ADM-01 |
| GET | `/api/v1/files/photos/:id/:taille?t&e&s` (lien signé 15 min, sans jeton) | public signé | §7.3 |
| POST | `/api/v1/orders/:id/submit` | clients | CMD-02 à 05 |
| POST | `/api/v1/collections` | clients | CMD-06 |
| POST | `/api/v1/orders/:id/approve`, `/reject` | B2B Admin | CMD-05 |
| POST | `/api/v1/orders/:id/cancel` | clients, exploitant | CMD-07, RG-CMD-03 |
| POST | `/api/v1/orders/:id/plan`, `/counter-propose` | Dispatcher | FLX-02 |
| POST | `/api/v1/orders/:id/accept-date` | clients | FLX-02 |
| GET | `/api/v1/orders`, `/orders/:id` | tous | SUI-01 |
| GET | `/api/v1/missions`, POST `/missions/:id/assign` | Dispatcher | FLX-01, FLX-03 |
| POST | `/api/v1/labels/blank` | Opérateur, Super Admin | O1, WMS-03 |
| GET | `/api/v1/field/bootstrap` | terrain | §7.5 pré-chargement, LIV-01 |
| GET | `/api/v1/field/receptions`, `/field/missions/:id` | terrain | REC-01, PRP-01 |
| POST | `/api/v1/field/sync` | terrain | §7.5 (toutes les actions ci-dessous) |
| PUT | `/api/v1/field/photos/:id` | terrain | REC-02, §7.6 |

### App terrain : file d'actions hors-ligne

Le terminal enregistre chaque geste en local puis envoie une file ordonnée à `POST /field/sync`. Chaque action porte
une clé d'idempotence et son horodatage terminal ; le serveur les rejoue dans l'ordre chronologique, chacune dans sa
transaction, et mémorise la réponse (un renvoi après coupure ne rejoue rien). La dérive d'horloge au-delà de 2 min
est corrigée et signalée. Si un déplacement arrive après un déplacement plus récent du même article, il est journalisé
sans modifier la position et une alerte de réconciliation est créée. Le contrat est typé dans `packages/domain/src/sync.ts`.

| Action | Rôle | Exigence |
|---|---|---|
| `ARTICLE_CREATE` (QR vierge ou QR posé à l'enlèvement, 1 à 6 photos) | Opérateur | REC-02, §4.1 |
| `ARTICLE_STORE`, `TRANSFER` (contrôle zone, surface et charge, forçage avec motif) | Opérateur | REC-03, RG-STK-01 |
| `UM_CREATE`, `UM_ADD`, `UM_STORE` | Opérateur | REC-04 |
| `RECEPTION_CLOSE` (collecte → STOCKEE, email récapitulatif) | Opérateur | §4.1 |
| `PICK`, `PICK_MISSING`, `PICK_COMPLETE` | Opérateur | PRP-01, PRP-02 |
| `LOAD` (statut En transit, départ bloqué si incomplet) | Opérateur | PRP-03 |
| `DEPART`, `ARRIVE` (contrôle GPS à 500 m) | Chauffeur | LIV-01, §4.3 |
| `BL_SIGN` (empreinte SHA-256 vérifiée, réserves, refus, retrait au comptoir) | Chauffeur, Opérateur | LIV-03, LIV-04 |
| `PICKUP_SIGN` (BL d'enlèvement, articles ATTENDU) | Chauffeur | LIV-06 |
| `RETURN` (article refusé de retour au dépôt) | Opérateur | §4.3 |

### App terrain (PWA)

- **D'abord en local** : chaque geste est écrit dans IndexedDB puis envoyé dès que le réseau revient
  (retour en ligne, retour au premier plan, toutes les 30 s). Une pastille en haut de chaque écran indique
  ce qui reste à envoyer ; la déconnexion est bloquée tant que la file n'est pas vide.
- **Ordre et idempotence** : actions envoyées par lots de 50 dans l'ordre des gestes, avec une clé par action.
  Une action refusée par le serveur est mise de côté et signalée ; une action mal formée est isolée sans bloquer la file.
- **Photos** compressées sur le terminal (WebP, 2048 px) et téléversées après les données, BL et réserves d'abord.
- **Scan** : caméra (BarcodeDetector, sinon jsQR), douchette ou saisie ; un scan hors commande bloque avec alerte.
- **Signature** au doigt convertie en SVG ; l'empreinte SHA-256 du BL est calculée sur le terminal et revérifiée par l'API.
- **Coque en cache** (service worker) : l'appli s'ouvre sans réseau une fois chargée ; les données hors-ligne
  sont les missions pré-chargées à l'ouverture de l'accueil.

## Feuille de route

- **A. Socle** (fait) : monorepo, domaine, schéma, auth, RBAC + RLS, audit, panier et commandes, CI.
- **B. Tranche verticale** (faite) : réception terrain (photo + QR + emplacement, hors-ligne), préparation et chargement par scan,
  livraison avec signature du BL et empreinte SHA-256, Espace Client (stock, jauge m², panier, suivi, collecte).
  Back-Office (fait) : tableau de bord des demandes en Kanban ou liste avec badge urgent (FLX-01), confirmation ou
  contre-proposition de date (FLX-02), planning par ressource avec glisser-déposer et contrôle de capacité (FLX-03),
  comptes clients avec SIRET contrôlé, projets et forfait (CLI-01), stock global. Avec `SEED_DEMO=true`, cinq demandes
  de démonstration sont créées par le vrai parcours.
  Dépôts (fait) : arbre dépôt > zones > allées > emplacements éditable (WMS-01), génération en masse par motif et
  import CSV avec aperçu (WMS-02), étiquettes QR en planche A4 Avery ou ZPL Zebra 50 × 25 / 100 × 50 mm (WMS-03),
  corrections de stock motivées et tracées : déplacer, perdu, retrouvé, endommagé, détruit, scinder ou fusionner
  des palettes (WMS-06).
- **C. Facturation** (faite) : instantané m² quotidien à 23 h 59 avec rattrapage et correction motivée (FAC-01),
  brouillons le 1er à 2 h puis émission automatique à J+2 sauf blocage, numérotation continue et PDF figé avec empreinte
  (FAC-02), avoirs partiels ou totaux et paiements (FAC-03), grilles versionnées et avenants (FAC-04), « Mes documents »
  côté client avec téléchargement ZIP (SUI-03). Les tâches tournent dans l'API (`BILLING_SCHEDULER`, actif par défaut en
  production) ; un service qui dort les rattrape au réveil, et le bouton « Lancer les tâches » les force. Avec
  `SEED_DEMO=true`, deux mois de factures de démonstration sont produits par le vrai moteur.
- **D. Comptes, paiement, e-mails** (fait) :
  - Utilisateurs clients (ADM-03) : l'administrateur client invite par e-mail (lien valable 7 jours, à usage unique),
    choisit Administrateur ou Utilisateur, attribue les projets un par un et désactive un accès, ce qui coupe la session
    immédiatement. Le contact d'un nouveau client reçoit aussi une invitation.
  - Facturation et paiement (ADM-04) : adresse, e-mail de facturation, bon de commande rappelé sur les factures.
    Carte obligatoire pour un particulier, prélèvement SEPA ou virement pour un professionnel, enregistrés sur la page
    sécurisée de Stripe. Les factures émises sont prélevées automatiquement, et une facture peut être payée en ligne.
    Les webhooks Stripe (`/api/v1/stripe/webhook`) rapprochent les paiements sans double comptage.
  - E-mails (§6.3) : file d'envoi avec reprises, modèles pour l'invitation, les commandes, la livraison, la mise en stock,
    la facture et les paiements. Chacun règle ses préférences dans « Mon compte ». Le Back-Office montre chaque message
    et son aperçu.
- **E. Exploitation** (fait) :
  - Relances (FAC-05) : une facture échue passe « en retard », puis le client reçoit un rappel à J+7, J+15 et J+30
    (un seul par palier, même après une panne), au contact facturation ou à défaut aux administrateurs. Relance manuelle
    depuis la fiche facture. Option, désactivée par défaut, qui suspend les restitutions après 30 jours d'impayé
    (droit de rétention à faire valider).
  - Export comptable (FAC-06) : fichier des écritures (FEC normalisé ou CSV) d'une période, ventes au journal VE
    (411 / 706 / 4457 par taux) et règlements au journal BQ (512 / 411), chaque écriture équilibrée.
  - Connexion « en tant que » (CLI-02) : depuis la fiche client, le Super Admin ouvre l'Espace Client d'un utilisateur
    dans un nouvel onglet, en lecture seule, 30 minutes, avec un motif tracé dans l'audit et un bandeau visible.
  - Pilotage (CLI-03) : remplissage des dépôts, CA récurrent, surface occupée sur 60 jours, missions du jour et
    retards, rechargé toutes les 15 minutes et exportable en CSV.

### Variables d'environnement des services externes

| Variable | Rôle | Sans elle |
| --- | --- | --- |
| `BREVO_API_KEY`, `MAIL_FROM`, `MAIL_FROM_NAME` | Envoi des e-mails par Brevo | Les messages sont préparés et visibles dans le Back-Office (« E-mails »), mais ne partent pas. Les liens d'invitation sont alors affichés à l'administrateur. |
| `PUBLIC_URL` | Adresse de l'Espace Client dans les liens des e-mails | `RENDER_EXTERNAL_URL` sur Render |
| `STRIPE_SECRET_KEY` | Carte, SEPA, prélèvements, paiement en ligne | Le paiement en ligne est masqué ; le virement reste proposé. |
| `STRIPE_WEBHOOK_SECRET` | Signature des webhooks Stripe (événements `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`) | Les paiements ne sont pas rapprochés automatiquement. |

Voir [docs/points-ouverts.md](docs/points-ouverts.md) pour les questions à trancher avec le client et les hypothèses prises,
et [docs/charte-graphique.md](docs/charte-graphique.md) pour la charte visuelle commune aux trois applis.
