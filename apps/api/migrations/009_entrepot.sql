-- Lot 4 : plan du dépôt (WMS-04), inventaire tournant (WMS-05), duplication à la réception (REC-05).

-- ---------------------------------------------------------------------------
-- REC-05 : une copie reprend la photo de l'article modèle. La ligne pointe le même fichier ;
-- quand l'original arrive (terminal hors réseau), les copies deviennent visibles en même temps.
-- ---------------------------------------------------------------------------
ALTER TABLE photo ADD COLUMN copie_de uuid;
CREATE INDEX photo_copie_de ON photo (copie_de) WHERE copie_de IS NOT NULL;

-- ---------------------------------------------------------------------------
-- WMS-05 : inventaire tournant d'une zone, compté en aveugle, écarts arbitrés au Back-Office
-- ---------------------------------------------------------------------------
CREATE TABLE inventaire (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  numero text NOT NULL,
  depot_id uuid NOT NULL REFERENCES depot(id),
  zone_id uuid NOT NULL REFERENCES zone(id),
  statut text NOT NULL DEFAULT 'EN_COURS' CHECK (statut IN ('EN_COURS', 'A_ARBITRER', 'CLOS', 'ANNULE')),
  nb_emplacements integer NOT NULL,
  lance_par uuid REFERENCES utilisateur(id),
  lance_le timestamptz NOT NULL DEFAULT now(),
  termine_le timestamptz,
  clos_le timestamptz,
  UNIQUE (tenant_id, numero)
);
-- une seule campagne ouverte par zone
CREATE UNIQUE INDEX inventaire_zone_ouverte ON inventaire (zone_id) WHERE statut IN ('EN_COURS', 'A_ARBITRER');

CREATE TABLE inventaire_comptage (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  inventaire_id uuid NOT NULL REFERENCES inventaire(id),
  mission_id uuid NOT NULL REFERENCES mission(id),
  emplacement_id uuid NOT NULL REFERENCES emplacement(id),
  ordre integer NOT NULL,
  attendus uuid[] NOT NULL DEFAULT '{}',
  trouves uuid[] NOT NULL DEFAULT '{}',
  inconnus text[] NOT NULL DEFAULT '{}',
  compte_le timestamptz,
  compte_par uuid REFERENCES utilisateur(id),
  UNIQUE (inventaire_id, emplacement_id)
);
CREATE INDEX inventaire_comptage_mission ON inventaire_comptage (mission_id, ordre);

CREATE TABLE inventaire_ecart (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  inventaire_id uuid NOT NULL REFERENCES inventaire(id),
  emplacement_id uuid NOT NULL REFERENCES emplacement(id),
  type text NOT NULL CHECK (type IN ('MANQUANT', 'DEPLACE', 'INCONNU')),
  article_id uuid REFERENCES article(id),
  qr text,
  -- DEPLACE : où le système plaçait l'article avant le comptage
  emplacement_systeme_id uuid REFERENCES emplacement(id),
  decision text CHECK (decision IN ('CORRIGE', 'PERDU', 'IGNORE')),
  motif text,
  decide_par uuid REFERENCES utilisateur(id),
  decide_le timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventaire_ecart_inv ON inventaire_ecart (inventaire_id);

ALTER TABLE inventaire ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventaire FORCE ROW LEVEL SECURITY;
CREATE POLICY inventaire_isolation ON inventaire
  USING (tenant_id = app_tenant() AND app_is_staff()) WITH CHECK (tenant_id = app_tenant() AND app_is_staff());
ALTER TABLE inventaire_comptage ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventaire_comptage FORCE ROW LEVEL SECURITY;
CREATE POLICY inventaire_comptage_isolation ON inventaire_comptage
  USING (tenant_id = app_tenant() AND app_is_staff()) WITH CHECK (tenant_id = app_tenant() AND app_is_staff());
ALTER TABLE inventaire_ecart ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventaire_ecart FORCE ROW LEVEL SECURITY;
CREATE POLICY inventaire_ecart_isolation ON inventaire_ecart
  USING (tenant_id = app_tenant() AND app_is_staff()) WITH CHECK (tenant_id = app_tenant() AND app_is_staff());
GRANT SELECT, INSERT, UPDATE ON inventaire, inventaire_comptage, inventaire_ecart TO jamystock_app;
