-- Lot 5 : tournées (FLX-04), positions des chauffeurs (FLX-05), suivi de livraison (SUI-02, LIV-02),
-- modèles d'e-mails modifiables (§6.3).

-- ---------------------------------------------------------------------------
-- FLX-04 : une tournée est une suite ordonnée d'arrêts (missions de livraison ou de collecte)
-- confiée à un chauffeur et un véhicule pour une journée. Ordre manuel ; l'ordre est mission.ordre.
-- ---------------------------------------------------------------------------
ALTER TABLE tournee ADD COLUMN numero text;
ALTER TABLE tournee ADD COLUMN depot_id uuid REFERENCES depot(id);
ALTER TABLE tournee ADD COLUMN nom text;
ALTER TABLE tournee ADD COLUMN created_by uuid REFERENCES utilisateur(id);
ALTER TABLE tournee ADD CONSTRAINT tournee_statut_check CHECK (statut IN ('PLANIFIEE', 'EN_COURS', 'TERMINEE', 'ANNULEE'));
CREATE UNIQUE INDEX tournee_numero ON tournee (tenant_id, numero) WHERE numero IS NOT NULL;
CREATE INDEX tournee_date ON tournee (tenant_id, date);
CREATE INDEX mission_tournee ON mission (tournee_id, ordre) WHERE tournee_id IS NOT NULL;

ALTER TABLE tournee ENABLE ROW LEVEL SECURITY;
ALTER TABLE tournee FORCE ROW LEVEL SECURITY;
CREATE POLICY tournee_isolation ON tournee
  USING (tenant_id = app_tenant() AND app_is_staff()) WITH CHECK (tenant_id = app_tenant() AND app_is_staff());
GRANT SELECT, INSERT, UPDATE ON tournee TO jamystock_app;

-- ---------------------------------------------------------------------------
-- FLX-05 : positions envoyées par le terminal, uniquement pendant une mission en cours (RGPD).
-- Purgées après 30 jours par la tâche quotidienne.
-- ---------------------------------------------------------------------------
CREATE TABLE position_chauffeur (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  utilisateur_id uuid NOT NULL REFERENCES utilisateur(id),
  mission_id uuid NOT NULL REFERENCES mission(id),
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  precision_m real,
  vitesse_kmh real,
  horodatage timestamptz NOT NULL,
  recue_le timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX position_chauffeur_user ON position_chauffeur (utilisateur_id, horodatage DESC);
CREATE INDEX position_chauffeur_mission ON position_chauffeur (mission_id, horodatage DESC);
CREATE INDEX position_chauffeur_purge ON position_chauffeur (horodatage);

ALTER TABLE position_chauffeur ENABLE ROW LEVEL SECURITY;
ALTER TABLE position_chauffeur FORCE ROW LEVEL SECURITY;
CREATE POLICY position_chauffeur_isolation ON position_chauffeur
  USING (tenant_id = app_tenant() AND app_is_staff()) WITH CHECK (tenant_id = app_tenant() AND app_is_staff());
GRANT SELECT, INSERT, DELETE ON position_chauffeur TO jamystock_app;

-- ---------------------------------------------------------------------------
-- §6.3 : texte des e-mails modifiable par l'exploitant. Sans ligne, le modèle d'origine s'applique.
-- ---------------------------------------------------------------------------
CREATE TABLE modele_email (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  modele text NOT NULL,
  sujet text NOT NULL,
  corps text NOT NULL,
  bouton text,
  updated_by uuid REFERENCES utilisateur(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, modele)
);
ALTER TABLE modele_email ENABLE ROW LEVEL SECURITY;
ALTER TABLE modele_email FORCE ROW LEVEL SECURITY;
CREATE POLICY modele_email_isolation ON modele_email
  USING (tenant_id = app_tenant() AND app_is_staff()) WITH CHECK (tenant_id = app_tenant() AND app_is_staff());
GRANT SELECT, INSERT, UPDATE, DELETE ON modele_email TO jamystock_app;
