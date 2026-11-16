-- JAMYSTOCK — schéma initial (cahier des charges §5)
-- Principes :
--  * toutes les tables métier portent tenant_id (organisation exploitante), created_at, updated_at, created_by ;
--  * identifiants UUID v7 générés par l'application ou le terminal (gen_random_uuid en repli) ;
--  * mouvement = journal immuable ; article.statut / emplacement_courant_id = projection mise à jour
--    dans la même transaction ;
--  * Row-Level Security sur entreprise_id / projet_id pour les rôles client (défense en profondeur).

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Énumérations
-- ---------------------------------------------------------------------------
CREATE TYPE role_utilisateur AS ENUM ('B2B_ADMIN','B2B_USER','B2C','SUPER_ADMIN','DISPATCHER','OPERATOR','DRIVER');
CREATE TYPE type_entreprise AS ENUM ('B2B','B2C');
CREATE TYPE statut_article AS ENUM ('ATTENDU','EN_RECEPTION','EN_STOCK','RESERVE','EN_PREPARATION','EN_TRANSIT','RESTITUE','PERDU','DETRUIT');
CREATE TYPE etat_article AS ENUM ('NEUF','BON','USE','ENDOMMAGE');
CREATE TYPE type_mouvement AS ENUM ('RECEPTION','RANGEMENT','TRANSFERT','PREPARATION','CHARGEMENT','LIVRAISON','RETOUR','AJUSTEMENT');
CREATE TYPE type_commande AS ENUM ('LIVRAISON','RETRAIT','COLLECTE');
CREATE TYPE statut_commande AS ENUM ('BROUILLON','EN_ATTENTE_VALIDATION','SOUMISE','REFUSEE','PLANIFIEE','EN_PREPARATION','PRETE',
  'EN_LIVRAISON','RETIREE','LIVREE','LIVREE_AVEC_RESERVES','ECHEC_LIVRAISON','COLLECTEE','STOCKEE','ANNULEE','CLOTUREE');
CREATE TYPE type_mission AS ENUM ('PREPARATION','LIVRAISON','COLLECTE','RETRAIT','INVENTAIRE','PHOTO','DEGROUPAGE');
CREATE TYPE statut_mission AS ENUM ('A_AFFECTER','AFFECTEE','EN_COURS','TERMINEE','ANNULEE','ANOMALIE');
CREATE TYPE type_emplacement AS ENUM ('RACK','ETAGERE','SOL');
CREATE TYPE type_zone AS ENUM ('STOCKAGE','RECEPTION','EXPEDITION','QUARANTAINE');
CREATE TYPE statut_emplacement AS ENUM ('ACTIF','BLOQUE','MAINTENANCE');
CREATE TYPE type_bl AS ENUM ('LIVRAISON','ENLEVEMENT','RETRAIT','REFUS');
CREATE TYPE statut_bl AS ENUM ('BROUILLON','SIGNE','NON_SIGNE_DEPOSE','SIGNATURE_PAPIER','SCELLE');
CREATE TYPE type_facture AS ENUM ('FACTURE','AVOIR');
CREATE TYPE statut_facture AS ENUM ('BROUILLON','EMISE','PAYEE','EN_RETARD','ANNULEE');
CREATE TYPE type_ligne_facture AS ENUM ('ABONNEMENT','DEPASSEMENT_M2','PRESTATION');

-- ---------------------------------------------------------------------------
-- Fonctions utilitaires
-- ---------------------------------------------------------------------------
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- Contexte de requête posé par l'API au début de chaque transaction (SET LOCAL).
CREATE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION app_entreprise() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.entreprise_id', true), '')::uuid $$;
CREATE FUNCTION app_role() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.role', true), '') $$;
CREATE FUNCTION app_is_staff() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT app_role() IN ('SUPER_ADMIN','DISPATCHER','OPERATOR','DRIVER','SYSTEM') $$;

-- ---------------------------------------------------------------------------
-- Organisation, clients, utilisateurs
-- ---------------------------------------------------------------------------
CREATE TABLE organisation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raison_sociale text NOT NULL,
  siret text,
  parametres jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE entreprise (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  type type_entreprise NOT NULL,
  nom text NOT NULL,
  siret text,
  tva_intracom text,
  adresse_facturation jsonb,
  conditions_paiement text,
  depot_sans_signature boolean NOT NULL DEFAULT false,
  statut text NOT NULL DEFAULT 'ACTIF' CHECK (statut IN ('ACTIF','SUSPENDU')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE INDEX ON entreprise (tenant_id);

CREATE TABLE utilisateur (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  entreprise_id uuid REFERENCES entreprise(id),
  email text NOT NULL,
  telephone text,
  nom text NOT NULL,
  role role_utilisateur NOT NULL,
  mot_de_passe_hash text,
  mfa_secret text,
  peut_commander_seul boolean NOT NULL DEFAULT true,
  plafond_articles_sans_validation integer,
  statut text NOT NULL DEFAULT 'ACTIF' CHECK (statut IN ('INVITE','ACTIF','DESACTIVE')),
  session_version integer NOT NULL DEFAULT 0,
  derniere_connexion timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT client_a_une_entreprise CHECK (
    (role IN ('B2B_ADMIN','B2B_USER','B2C')) = (entreprise_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX utilisateur_email_unique ON utilisateur (tenant_id, lower(email));

CREATE TABLE refresh_token (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id uuid NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  famille uuid NOT NULL,
  appareil_id text,
  expire_le timestamptz NOT NULL,
  revoque_le timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projet (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  entreprise_id uuid NOT NULL REFERENCES entreprise(id),
  nom text NOT NULL,
  code text,
  adresse_site jsonb,
  statut text NOT NULL DEFAULT 'ACTIF' CHECK (statut IN ('ACTIF','TERMINE','ARCHIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE INDEX ON projet (entreprise_id);

CREATE TABLE acces_projet (
  utilisateur_id uuid NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  projet_id uuid NOT NULL REFERENCES projet(id) ON DELETE CASCADE,
  peut_commander boolean NOT NULL DEFAULT true,
  plafond_sans_validation integer,
  PRIMARY KEY (utilisateur_id, projet_id)
);

-- Projets visibles par l'utilisateur courant (B2B_USER) : utilisée par les politiques RLS.
CREATE FUNCTION app_projets_visibles() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER AS
$$ SELECT projet_id FROM acces_projet WHERE utilisateur_id = app_user() $$;

-- ---------------------------------------------------------------------------
-- Tarifs et forfaits
-- ---------------------------------------------------------------------------
CREATE TABLE grille_tarifaire (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  nom text NOT NULL,
  type text NOT NULL CHECK (type IN ('STANDARD_B2C','SUR_MESURE_B2B')),
  version integer NOT NULL DEFAULT 1,
  valide_du date NOT NULL,
  valide_au date,
  prix_m2_mois_cents integer,
  m2_minimum numeric(10,2) NOT NULL DEFAULT 0,
  lignes jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{code, libelle, unite, prix_ht_cents, tva}]
  utilisee boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, nom, version)
);

CREATE TABLE forfait (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  entreprise_id uuid NOT NULL REFERENCES entreprise(id),
  grille_tarifaire_id uuid NOT NULL REFERENCES grille_tarifaire(id),
  version integer NOT NULL DEFAULT 1,
  m2_inclus numeric(10,2) NOT NULL,
  prix_mensuel_cents integer NOT NULL,
  prix_m2_depassement_cents integer NOT NULL,
  prestations_incluses jsonb NOT NULL DEFAULT '{}'::jsonb, -- { "LIVRAISON": 2 }
  mode_surface text NOT NULL DEFAULT 'MOYENNE' CHECK (mode_surface IN ('MOYENNE','PIC')),
  coefficient_degagement numeric(4,2) NOT NULL DEFAULT 1.15,
  m2_minimum numeric(10,2) NOT NULL DEFAULT 0,
  date_debut date NOT NULL,
  date_fin date,
  engagement_mois integer,
  statut text NOT NULL DEFAULT 'ACTIF' CHECK (statut IN ('BROUILLON','ACTIF','TERMINE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
-- un seul forfait actif à une date donnée par entreprise
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE forfait ADD CONSTRAINT forfait_sans_chevauchement EXCLUDE USING gist (
  entreprise_id WITH =,
  daterange(date_debut, coalesce(date_fin, 'infinity'::date), '[]') WITH &&
) WHERE (statut = 'ACTIF');

-- ---------------------------------------------------------------------------
-- WMS : dépôts, zones, emplacements
-- ---------------------------------------------------------------------------
CREATE TABLE depot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  nom text NOT NULL,
  code text NOT NULL,
  adresse jsonb,
  latitude double precision,
  longitude double precision,
  horaires jsonb NOT NULL DEFAULT '{}'::jsonb,
  creneaux_retrait jsonb NOT NULL DEFAULT '[]'::jsonb,
  delai_min_heures_ouvrees integer NOT NULL DEFAULT 48,
  capacite_missions_jour integer,
  surface_totale_m2 numeric(10,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, code)
);

CREATE TABLE zone (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  depot_id uuid NOT NULL REFERENCES depot(id),
  code text NOT NULL,
  nom text NOT NULL,
  type type_zone NOT NULL DEFAULT 'STOCKAGE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (depot_id, code)
);

CREATE TABLE emplacement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  zone_id uuid NOT NULL REFERENCES zone(id),
  parent_id uuid REFERENCES emplacement(id),
  code text NOT NULL,
  chemin text NOT NULL, -- « Dépôt Nord > Zone B > Allée 4 > Emplacement 12 »
  type type_emplacement NOT NULL DEFAULT 'SOL',
  longueur_m numeric(8,3),
  largeur_m numeric(8,3),
  hauteur_m numeric(8,3),
  surface_m2 numeric(10,2) NOT NULL DEFAULT 0,
  niveaux integer NOT NULL DEFAULT 1 CHECK (niveaux >= 1),
  charge_max_kg numeric(10,2),
  statut statut_emplacement NOT NULL DEFAULT 'ACTIF',
  dedie_entreprise_id uuid REFERENCES entreprise(id), -- RG-M2-03
  adressable boolean NOT NULL DEFAULT true, -- false pour les nœuds intermédiaires (allée, travée)
  qr_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, qr_code),
  UNIQUE (zone_id, code)
);

CREATE TABLE categorie (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  nom text NOT NULL,
  icone text,
  longueur_m numeric(8,3),
  largeur_m numeric(8,3),
  hauteur_m numeric(8,3),
  empilable boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, nom)
);

-- ---------------------------------------------------------------------------
-- Stock : UM, articles, photos, mouvements
-- ---------------------------------------------------------------------------
CREATE TABLE unite_manutention (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  entreprise_id uuid REFERENCES entreprise(id),
  type text NOT NULL CHECK (type IN ('PALETTE','CAISSE','RACK')),
  qr_code text NOT NULL,
  longueur_m numeric(8,3) NOT NULL DEFAULT 1.2,
  largeur_m numeric(8,3) NOT NULL DEFAULT 0.8,
  hauteur_m numeric(8,3),
  empilable boolean NOT NULL DEFAULT false,
  emplacement_courant_id uuid REFERENCES emplacement(id),
  actif boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (tenant_id, qr_code)
);

-- Planches de QR vierges pré-imprimées (optimisation O1) : un QR n'est attribué qu'une fois.
CREATE TABLE qr_vierge (
  qr_code text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  lot text,
  attribue_le timestamptz,
  PRIMARY KEY (tenant_id, qr_code)
);

CREATE TABLE article (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  entreprise_id uuid NOT NULL REFERENCES entreprise(id),
  projet_id uuid REFERENCES projet(id),
  qr_code text NOT NULL,
  libelle text NOT NULL,
  nom_client text,
  reference_interne text,
  categorie_id uuid REFERENCES categorie(id),
  description text,
  longueur_m numeric(8,3),
  largeur_m numeric(8,3),
  hauteur_m numeric(8,3),
  poids_kg numeric(10,2),
  empilable boolean NOT NULL DEFAULT false,
  etat etat_article NOT NULL DEFAULT 'BON',
  statut statut_article NOT NULL DEFAULT 'ATTENDU',
  emplacement_courant_id uuid REFERENCES emplacement(id),
  um_courante_id uuid REFERENCES unite_manutention(id),
  date_entree timestamptz,
  dernier_mouvement_le timestamptz,
  commande_collecte_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  recherche tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(libelle,'') || ' ' || coalesce(nom_client,'') || ' ' || coalesce(description,'') || ' ' || coalesce(reference_interne,''))
  ) STORED
);
-- RG-STK-02 : QR unique par tenant, jamais recyclé (même après restitution)
CREATE UNIQUE INDEX article_qr_unique ON article (tenant_id, qr_code);
CREATE INDEX article_entreprise_statut_projet ON article (entreprise_id, statut, projet_id);
CREATE INDEX article_emplacement ON article (emplacement_courant_id);
CREATE INDEX article_um ON article (um_courante_id);
CREATE INDEX article_recherche ON article USING gin (recherche);
CREATE INDEX article_trgm ON article USING gin ((coalesce(libelle,'') || ' ' || coalesce(nom_client,'') || ' ' || coalesce(description,'')) gin_trgm_ops);

CREATE TABLE photo (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  article_id uuid REFERENCES article(id),
  mouvement_id uuid,
  reserve_id uuid,
  bl_id uuid,
  cle_originale text NOT NULL,
  cle_vignette text,
  cle_moyenne text,
  contexte text NOT NULL CHECK (contexte IN ('RECEPTION','LIVRAISON','RESERVE','A_LA_DEMANDE','ENLEVEMENT','ANOMALIE','DEPOT')),
  prise_le timestamptz NOT NULL DEFAULT now(),
  prise_par uuid,
  televersee boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON photo (article_id);

CREATE TABLE mouvement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  article_id uuid REFERENCES article(id),
  um_id uuid REFERENCES unite_manutention(id),
  type type_mouvement NOT NULL,
  de_emplacement_id uuid REFERENCES emplacement(id),
  vers_emplacement_id uuid REFERENCES emplacement(id),
  statut_avant statut_article,
  statut_apres statut_article,
  mission_id uuid,
  auteur_id uuid NOT NULL,
  appareil_id text,
  horodatage_terminal timestamptz NOT NULL,
  horodatage_serveur timestamptz NOT NULL DEFAULT now(),
  latitude double precision,
  longitude double precision,
  motif text,
  CONSTRAINT mouvement_cible CHECK (article_id IS NOT NULL OR um_id IS NOT NULL),
  CONSTRAINT ajustement_motif CHECK (type <> 'AJUSTEMENT' OR coalesce(length(trim(motif)), 0) > 0)
);
CREATE INDEX mouvement_article_horodatage ON mouvement (article_id, horodatage_serveur);

-- Journal immuable (append-only)
CREATE FUNCTION interdire_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% est immuable', TG_TABLE_NAME USING ERRCODE = 'P0001'; END $$;
CREATE TRIGGER mouvement_immuable BEFORE UPDATE OR DELETE ON mouvement
  FOR EACH ROW EXECUTE FUNCTION interdire_modification();

-- ---------------------------------------------------------------------------
-- Commandes, missions, tournées, véhicules
-- ---------------------------------------------------------------------------
CREATE TABLE vehicule (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  immatriculation text NOT NULL,
  type text NOT NULL,
  volume_m3 numeric(6,2) NOT NULL,
  charge_utile_kg numeric(10,2) NOT NULL,
  hayon boolean NOT NULL DEFAULT false,
  actif boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, immatriculation)
);

CREATE TABLE carnet_adresse (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  entreprise_id uuid NOT NULL REFERENCES entreprise(id),
  libelle text NOT NULL,
  adresse jsonb NOT NULL,
  contraintes_acces jsonb NOT NULL DEFAULT '{}'::jsonb,
  contact_site jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);

CREATE TABLE commande (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  numero text,
  entreprise_id uuid NOT NULL REFERENCES entreprise(id),
  projet_id uuid REFERENCES projet(id),
  depot_id uuid REFERENCES depot(id),
  demandeur_id uuid NOT NULL REFERENCES utilisateur(id),
  valideur_id uuid REFERENCES utilisateur(id),
  type type_commande NOT NULL,
  statut statut_commande NOT NULL DEFAULT 'BROUILLON',
  adresse jsonb,
  contraintes_acces jsonb NOT NULL DEFAULT '{}'::jsonb,
  contact_site jsonb,
  date_souhaitee date,
  creneau_souhaite text,
  date_confirmee date,
  creneau_confirme text,
  date_contre_proposee date,
  message_dispatcher text,
  motif_refus text,
  volume_m3 numeric(10,3),
  poids_kg numeric(10,2),
  vehicule_suggere text,
  cout_estime_cents integer,
  description_collecte text,
  historique_statuts jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{statut, le, par}]
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE UNIQUE INDEX commande_numero_unique ON commande (tenant_id, numero) WHERE numero IS NOT NULL;
-- le panier : un seul brouillon par utilisateur, type et projet
CREATE UNIQUE INDEX commande_un_panier ON commande (demandeur_id, type, coalesce(projet_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE statut = 'BROUILLON';
CREATE INDEX ON commande (entreprise_id, statut);

CREATE TABLE ligne_commande (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  commande_id uuid NOT NULL REFERENCES commande(id) ON DELETE CASCADE,
  article_id uuid REFERENCES article(id),
  description_libre text,
  quantite_estimee integer,
  statut_ligne text NOT NULL DEFAULT 'DEMANDEE' CHECK (statut_ligne IN ('DEMANDEE','PREPAREE','CHARGEE','LIVREE','MANQUANTE','REFUSEE')),
  active boolean NOT NULL DEFAULT false,
  CONSTRAINT ligne_article_ou_description CHECK (article_id IS NOT NULL OR description_libre IS NOT NULL)
);
CREATE UNIQUE INDEX ligne_article_par_commande ON ligne_commande (commande_id, article_id) WHERE article_id IS NOT NULL;
-- §5.2 : un article appartient à au plus une commande active
CREATE UNIQUE INDEX article_une_commande_active ON ligne_commande (article_id) WHERE active AND article_id IS NOT NULL;

CREATE FUNCTION sync_lignes_actives() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.statut IS DISTINCT FROM OLD.statut THEN
    UPDATE ligne_commande SET active = NEW.statut IN
      ('EN_ATTENTE_VALIDATION','SOUMISE','PLANIFIEE','EN_PREPARATION','PRETE','EN_LIVRAISON','ECHEC_LIVRAISON')
      AND statut_ligne NOT IN ('MANQUANTE','REFUSEE','LIVREE')
    WHERE commande_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commande_sync_lignes AFTER UPDATE OF statut ON commande
  FOR EACH ROW EXECUTE FUNCTION sync_lignes_actives();

CREATE TABLE tournee (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  date date NOT NULL,
  chauffeur_id uuid REFERENCES utilisateur(id),
  vehicule_id uuid REFERENCES vehicule(id),
  statut text NOT NULL DEFAULT 'PLANIFIEE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  commande_id uuid REFERENCES commande(id),
  depot_id uuid REFERENCES depot(id),
  type type_mission NOT NULL,
  statut statut_mission NOT NULL DEFAULT 'A_AFFECTER',
  assigne_a uuid REFERENCES utilisateur(id),
  vehicule_id uuid REFERENCES vehicule(id),
  tournee_id uuid REFERENCES tournee(id),
  ordre integer,
  debut_prevu timestamptz,
  debut_reel timestamptz,
  fin_reelle timestamptz,
  donnees jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON mission (assigne_a, statut);
CREATE INDEX ON mission (commande_id);

-- ---------------------------------------------------------------------------
-- Bons de livraison et réserves
-- ---------------------------------------------------------------------------
CREATE TABLE bon_de_livraison (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  numero text NOT NULL,
  mission_id uuid NOT NULL REFERENCES mission(id),
  commande_id uuid NOT NULL REFERENCES commande(id),
  entreprise_id uuid NOT NULL REFERENCES entreprise(id),
  type type_bl NOT NULL,
  contenu jsonb NOT NULL, -- articles livrés, réserves, refus : base de l'empreinte
  signataire_nom text,
  signataire_qualite text,
  signature_svg text,
  cle_signature_png text,
  signe_le timestamptz,
  recu_le timestamptz NOT NULL DEFAULT now(),
  latitude double precision,
  longitude double precision,
  precision_m double precision,
  appareil_id text,
  empreinte_sha256 text,
  cle_pdf text,
  statut statut_bl NOT NULL DEFAULT 'BROUILLON',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, numero)
);
CREATE UNIQUE INDEX un_bl_par_mission ON bon_de_livraison (mission_id);

CREATE TABLE reserve (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  bl_id uuid NOT NULL REFERENCES bon_de_livraison(id),
  article_id uuid REFERENCES article(id),
  type text NOT NULL CHECK (type IN ('CASSE','RAYURE','MANQUANT','REFUS','AUTRE')),
  commentaire text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Facturation
-- ---------------------------------------------------------------------------
CREATE TABLE instantane_occupation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  entreprise_id uuid NOT NULL REFERENCES entreprise(id),
  projet_id uuid REFERENCES projet(id),
  depot_id uuid REFERENCES depot(id),
  date date NOT NULL,
  m2_occupes numeric(10,2) NOT NULL,
  nb_articles integer NOT NULL,
  calcule_le timestamptz NOT NULL DEFAULT now(),
  recalcul_motif text
);
CREATE UNIQUE INDEX instantane_unique ON instantane_occupation (
  entreprise_id, date,
  coalesce(projet_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(depot_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
CREATE INDEX instantane_entreprise_date ON instantane_occupation (entreprise_id, date);

-- Prestations à facturer (livraisons, manutention, annulations tardives...) pointées par les missions.
CREATE TABLE prestation_a_facturer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  entreprise_id uuid NOT NULL REFERENCES entreprise(id),
  code text NOT NULL,
  libelle text NOT NULL,
  quantite numeric(10,3) NOT NULL DEFAULT 1,
  unite text NOT NULL,
  prix_unitaire_ht_cents integer NOT NULL,
  taux_tva numeric(5,2) NOT NULL DEFAULT 20,
  source_id uuid,
  date_prestation date NOT NULL,
  facture_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sequence_document (
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  prefixe text NOT NULL,
  annee integer NOT NULL,
  dernier integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, prefixe, annee)
);

-- Numérotation continue sans trou : verrou de ligne dans la transaction appelante.
CREATE FUNCTION prochain_numero(p_tenant uuid, p_prefixe text, p_annee integer) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v integer;
BEGIN
  INSERT INTO sequence_document (tenant_id, prefixe, annee, dernier) VALUES (p_tenant, p_prefixe, p_annee, 1)
  ON CONFLICT (tenant_id, prefixe, annee) DO UPDATE SET dernier = sequence_document.dernier + 1
  RETURNING dernier INTO v;
  RETURN v;
END $$;

CREATE TABLE facture (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  numero text,
  entreprise_id uuid NOT NULL REFERENCES entreprise(id),
  forfait_id uuid REFERENCES forfait(id),
  type type_facture NOT NULL DEFAULT 'FACTURE',
  periode_debut date,
  periode_fin date,
  statut statut_facture NOT NULL DEFAULT 'BROUILLON',
  m2_factures numeric(10,2),
  total_ht_cents integer NOT NULL DEFAULT 0,
  tva_cents integer NOT NULL DEFAULT 0,
  total_ttc_cents integer NOT NULL DEFAULT 0,
  cle_pdf text,
  facture_origine_id uuid REFERENCES facture(id),
  emise_le timestamptz,
  echeance date,
  bon_de_commande text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  CONSTRAINT avoir_lie CHECK (type <> 'AVOIR' OR facture_origine_id IS NOT NULL),
  CONSTRAINT numero_si_emise CHECK (statut = 'BROUILLON' OR numero IS NOT NULL)
);
CREATE UNIQUE INDEX facture_numero_unique ON facture (tenant_id, numero) WHERE numero IS NOT NULL;
-- un seul brouillon/facture récurrente par entreprise et période
CREATE UNIQUE INDEX facture_periode_unique ON facture (entreprise_id, periode_debut)
  WHERE type = 'FACTURE' AND statut <> 'ANNULEE' AND periode_debut IS NOT NULL;

CREATE TABLE ligne_facture (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  facture_id uuid NOT NULL REFERENCES facture(id) ON DELETE CASCADE,
  type type_ligne_facture NOT NULL,
  libelle text NOT NULL,
  quantite numeric(12,4) NOT NULL,
  unite text NOT NULL,
  prix_unitaire_ht_cents integer NOT NULL,
  taux_tva numeric(5,2) NOT NULL,
  total_ht_cents integer NOT NULL,
  source_id uuid,
  ordre integer NOT NULL DEFAULT 0
);

-- FAC-03 : facture non modifiable après émission (seuls statut de paiement et PDF évoluent).
CREATE FUNCTION facture_immuable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.statut <> 'BROUILLON' THEN RAISE EXCEPTION 'Facture émise : suppression interdite (émettre un avoir)'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.statut <> 'BROUILLON' AND (
      NEW.numero IS DISTINCT FROM OLD.numero OR NEW.total_ht_cents <> OLD.total_ht_cents OR NEW.tva_cents <> OLD.tva_cents
      OR NEW.total_ttc_cents <> OLD.total_ttc_cents OR NEW.entreprise_id <> OLD.entreprise_id
      OR NEW.periode_debut IS DISTINCT FROM OLD.periode_debut OR NEW.emise_le IS DISTINCT FROM OLD.emise_le
      OR NEW.statut = 'BROUILLON') THEN
    RAISE EXCEPTION 'Facture émise : modification interdite (émettre un avoir)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER facture_immuable BEFORE UPDATE OR DELETE ON facture FOR EACH ROW EXECUTE FUNCTION facture_immuable();

CREATE FUNCTION ligne_facture_immuable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s statut_facture;
BEGIN
  SELECT statut INTO s FROM facture WHERE id = coalesce(NEW.facture_id, OLD.facture_id);
  IF s IS NOT NULL AND s <> 'BROUILLON' THEN RAISE EXCEPTION 'Facture émise : lignes non modifiables'; END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER ligne_facture_immuable BEFORE INSERT OR UPDATE OR DELETE ON ligne_facture
  FOR EACH ROW EXECUTE FUNCTION ligne_facture_immuable();

CREATE TABLE paiement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  facture_id uuid NOT NULL REFERENCES facture(id),
  moyen text NOT NULL,
  montant_cents integer NOT NULL,
  date date NOT NULL,
  reference_psp text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Notifications, audit, idempotence de la synchronisation terrain
-- ---------------------------------------------------------------------------
CREATE TABLE notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  destinataire_id uuid REFERENCES utilisateur(id),
  destinataire_adresse text,
  canal text NOT NULL CHECK (canal IN ('EMAIL','SMS','PUSH','IN_APP')),
  modele text NOT NULL,
  variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  statut text NOT NULL DEFAULT 'EN_ATTENTE' CHECK (statut IN ('EN_ATTENTE','ENVOYEE','ECHEC','LUE')),
  envoyee_le timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notification (destinataire_id, statut);

CREATE TABLE alerte_envoyee (
  entreprise_id uuid NOT NULL REFERENCES entreprise(id),
  regle text NOT NULL,
  envoyee_le date NOT NULL,
  PRIMARY KEY (entreprise_id, regle, envoyee_le)
);

CREATE TABLE journal_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  entreprise_id uuid REFERENCES entreprise(id),
  acteur_id uuid,
  action text NOT NULL,
  objet text NOT NULL,
  objet_id uuid,
  avant jsonb,
  apres jsonb,
  motif text,
  ip inet,
  horodatage timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON journal_audit (tenant_id, horodatage DESC);
CREATE INDEX ON journal_audit (objet, objet_id);
CREATE TRIGGER journal_audit_immuable BEFORE UPDATE OR DELETE ON journal_audit
  FOR EACH ROW EXECUTE FUNCTION interdire_modification();

-- §7.5 : requêtes idempotentes (clé d'idempotence par action terrain)
CREATE TABLE action_synchronisee (
  cle_idempotence text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  utilisateur_id uuid NOT NULL,
  appareil_id text,
  type_action text NOT NULL,
  reponse jsonb NOT NULL,
  recue_le timestamptz NOT NULL DEFAULT now(),
  ecart_horloge_ms integer,
  PRIMARY KEY (tenant_id, cle_idempotence)
);

-- ---------------------------------------------------------------------------
-- Déclencheurs updated_at
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT table_name FROM information_schema.columns
           WHERE table_schema = 'public' AND column_name = 'updated_at'
  LOOP
    EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t, t);
  END LOOP;
END $$;
