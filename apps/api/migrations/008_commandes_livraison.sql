-- Lot 3 : modèles de panier (CMD-08), restitution partielle d'une UM (CMD-09), litiges (SUI-04), dépôt sans signature (LIV-05).

-- ---------------------------------------------------------------------------
-- CMD-08 : un modèle est une liste d'articles nommée, réutilisable en un clic
-- ---------------------------------------------------------------------------
CREATE TABLE modele_panier (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  entreprise_id uuid NOT NULL REFERENCES entreprise(id),
  projet_id uuid REFERENCES projet(id),
  nom text NOT NULL CHECK (length(nom) BETWEEN 1 AND 80),
  article_ids uuid[] NOT NULL,
  cree_par uuid NOT NULL REFERENCES utilisateur(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  utilise_le timestamptz
);
CREATE INDEX modele_panier_entreprise ON modele_panier (entreprise_id, projet_id);
ALTER TABLE modele_panier ENABLE ROW LEVEL SECURITY;
ALTER TABLE modele_panier FORCE ROW LEVEL SECURITY;
CREATE POLICY modele_panier_isolation ON modele_panier
  USING (tenant_id = app_tenant() AND app_voit(entreprise_id, projet_id))
  WITH CHECK (tenant_id = app_tenant() AND app_voit(entreprise_id, projet_id));
GRANT SELECT, INSERT, UPDATE, DELETE ON modele_panier TO jamystock_app;

-- ---------------------------------------------------------------------------
-- CMD-09 : article à sortir de son UM avant la préparation (les autres y restent)
-- ---------------------------------------------------------------------------
ALTER TABLE ligne_commande ADD COLUMN um_a_degrouper uuid REFERENCES unite_manutention(id);

-- ---------------------------------------------------------------------------
-- LIV-05 : le client autorise, commande par commande, le dépôt sans signature
-- ---------------------------------------------------------------------------
ALTER TABLE commande ADD COLUMN depot_sans_signature boolean NOT NULL DEFAULT false;
ALTER TABLE bon_de_livraison ADD COLUMN lieu_depot text;

-- ---------------------------------------------------------------------------
-- SUI-04 : réserve ou litige signalé par le client dans les 48 h suivant la livraison
-- ---------------------------------------------------------------------------
CREATE TABLE litige (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  numero text NOT NULL,
  entreprise_id uuid NOT NULL REFERENCES entreprise(id),
  projet_id uuid REFERENCES projet(id),
  commande_id uuid NOT NULL REFERENCES commande(id),
  bl_id uuid NOT NULL REFERENCES bon_de_livraison(id),
  motif text NOT NULL CHECK (motif IN ('CASSE','RAYURE','MANQUANT','ERREUR','AUTRE')),
  description text NOT NULL,
  article_ids uuid[] NOT NULL DEFAULT '{}',
  photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  statut text NOT NULL DEFAULT 'OUVERT' CHECK (statut IN ('OUVERT','EN_COURS','RESOLU','REJETE')),
  reponse text,
  geste_cents integer,
  cree_par uuid NOT NULL REFERENCES utilisateur(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  traite_par uuid REFERENCES utilisateur(id),
  traite_le timestamptz,
  UNIQUE (tenant_id, numero)
);
CREATE INDEX litige_bl ON litige (bl_id);
CREATE INDEX litige_statut ON litige (tenant_id, statut, created_at DESC);
ALTER TABLE litige ENABLE ROW LEVEL SECURITY;
ALTER TABLE litige FORCE ROW LEVEL SECURITY;
CREATE POLICY litige_isolation ON litige
  USING (tenant_id = app_tenant() AND app_voit(entreprise_id, projet_id))
  WITH CHECK (tenant_id = app_tenant() AND app_voit(entreprise_id, projet_id));
GRANT SELECT, INSERT, UPDATE ON litige TO jamystock_app;
