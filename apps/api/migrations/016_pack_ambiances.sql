-- Visuel d'aménagement de chaque pièce d'un pack : généré par IA (Higgsfield) à partir des meubles de la pièce,
-- ou image ajoutée à la main (photo de l'appartement témoin). L'historique sert au plafond mensuel de générations :
-- un visuel retiré passe en SUPPRIME mais reste compté.
CREATE TABLE pack_ambiance (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  -- un pack supprimé laisse la ligne (sans pack) : la génération reste comptée dans le plafond
  pack_id uuid REFERENCES modele_panier(id) ON DELETE SET NULL,
  entreprise_id uuid NOT NULL REFERENCES entreprise(id),
  projet_id uuid REFERENCES projet(id),
  piece text NOT NULL CHECK (length(piece) BETWEEN 1 AND 80),
  source text NOT NULL CHECK (source IN ('IA', 'MANUEL')),
  statut text NOT NULL CHECK (statut IN ('EN_COURS', 'PRET', 'ECHEC', 'SUPPRIME')),
  cle text,
  request_id text,
  erreur text CHECK (erreur IS NULL OR length(erreur) <= 300),
  cree_par uuid REFERENCES utilisateur(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  termine_le timestamptz
);
CREATE INDEX pack_ambiance_pack ON pack_ambiance (pack_id, piece, created_at DESC);
CREATE INDEX pack_ambiance_quota ON pack_ambiance (tenant_id, created_at) WHERE source = 'IA';
ALTER TABLE pack_ambiance ENABLE ROW LEVEL SECURITY;
ALTER TABLE pack_ambiance FORCE ROW LEVEL SECURITY;
CREATE POLICY pack_ambiance_isolation ON pack_ambiance
  USING (tenant_id = app_tenant() AND app_voit(entreprise_id, projet_id))
  WITH CHECK (tenant_id = app_tenant() AND app_voit(entreprise_id, projet_id));
GRANT SELECT, INSERT, UPDATE ON pack_ambiance TO jamystock_app;
