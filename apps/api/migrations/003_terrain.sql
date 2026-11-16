-- Phase B : app terrain hors-ligne (§7.5) et preuves de livraison (§4.3)

-- Horodatage terminal du dernier mouvement appliqué : sert à détecter un mouvement arrivé en retard
-- (conflit entre deux opérateurs, « le plus récent l'emporte »).
ALTER TABLE article ADD COLUMN dernier_mouvement_terminal timestamptz;
ALTER TABLE unite_manutention ADD COLUMN dernier_mouvement_terminal timestamptz;

-- Le mouvement indique s'il a été appliqué à la projection ou seulement journalisé (conflit).
ALTER TABLE mouvement ADD COLUMN applique boolean NOT NULL DEFAULT true;

-- Alertes de réconciliation et anomalies terrain à arbitrer par le superviseur.
CREATE TABLE alerte_terrain (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  type text NOT NULL CHECK (type IN ('RECONCILIATION','ARTICLE_INTROUVABLE','HORLOGE','GPS_ELOIGNE','CAPACITE_FORCEE')),
  article_id uuid REFERENCES article(id),
  mission_id uuid REFERENCES mission(id),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  auteur_id uuid,
  traitee_le timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON alerte_terrain (tenant_id, traitee_le);
ALTER TABLE alerte_terrain ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerte_terrain FORCE ROW LEVEL SECURITY;
CREATE POLICY alerte_terrain_isolation ON alerte_terrain
  USING (tenant_id = app_tenant() AND app_is_staff()) WITH CHECK (tenant_id = app_tenant() AND app_is_staff());

-- Réserves : ligne commande concernée pour le suivi des litiges (SUI-04, phase 1.5)
ALTER TABLE reserve ADD COLUMN photo_ids uuid[] NOT NULL DEFAULT '{}';

-- Taille et type du binaire réellement reçu
ALTER TABLE photo ADD COLUMN type_mime text;
ALTER TABLE photo ADD COLUMN taille_octets integer;
