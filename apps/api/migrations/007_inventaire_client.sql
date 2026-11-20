-- Lot 2 : export de l'inventaire (INV-05), annotations client (INV-06), photo ou constat à la demande (INV-07).

-- ---------------------------------------------------------------------------
-- INV-06 : vocabulaire du client, distinct du libellé opérateur (nom_client et reference_interne existent déjà)
-- ---------------------------------------------------------------------------
ALTER TABLE article ADD COLUMN categorie_client text;
ALTER TABLE article ADD COLUMN note_client text;
ALTER TABLE article ADD COLUMN annote_le timestamptz;
ALTER TABLE article ADD COLUMN annote_par uuid REFERENCES utilisateur(id);

-- la recherche plein texte couvre aussi la catégorie et la note du client
DROP INDEX IF EXISTS article_recherche;
ALTER TABLE article DROP COLUMN recherche;
ALTER TABLE article ADD COLUMN recherche tsvector GENERATED ALWAYS AS (
  to_tsvector('simple', coalesce(libelle,'') || ' ' || coalesce(nom_client,'') || ' ' || coalesce(description,'') || ' ' ||
    coalesce(reference_interne,'') || ' ' || coalesce(categorie_client,'') || ' ' || coalesce(note_client,''))
) STORED;
CREATE INDEX article_recherche ON article USING gin (recherche);

-- ---------------------------------------------------------------------------
-- INV-05 : exports PDF illustrés, préparés en tâche de fond
-- ---------------------------------------------------------------------------
CREATE TABLE export_inventaire (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  entreprise_id uuid REFERENCES entreprise(id),
  utilisateur_id uuid NOT NULL REFERENCES utilisateur(id),
  format text NOT NULL CHECK (format IN ('PDF')),
  filtres jsonb NOT NULL DEFAULT '{}'::jsonb,
  statut text NOT NULL DEFAULT 'EN_COURS' CHECK (statut IN ('EN_COURS','PRET','ECHEC')),
  cle text,
  nb_articles integer,
  erreur text,
  cree_le timestamptz NOT NULL DEFAULT now(),
  pret_le timestamptz,
  expire_le timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE INDEX export_inventaire_utilisateur ON export_inventaire (utilisateur_id, cree_le DESC);
ALTER TABLE export_inventaire ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_inventaire FORCE ROW LEVEL SECURITY;
CREATE POLICY export_inventaire_isolation ON export_inventaire
  USING (tenant_id = app_tenant() AND (app_is_staff() OR utilisateur_id = app_user()))
  WITH CHECK (tenant_id = app_tenant() AND (app_is_staff() OR utilisateur_id = app_user()));
GRANT SELECT, INSERT, UPDATE, DELETE ON export_inventaire TO jamystock_app;

-- ---------------------------------------------------------------------------
-- INV-07 : la photo prise à la demande d'un client a son propre contexte
-- ---------------------------------------------------------------------------
ALTER TABLE photo DROP CONSTRAINT photo_contexte_check;
ALTER TABLE photo ADD CONSTRAINT photo_contexte_check
  CHECK (contexte IN ('RECEPTION','LIVRAISON','RESERVE','A_LA_DEMANDE','ENLEVEMENT','ANOMALIE','DEPOT','CONSTAT'));
CREATE INDEX mission_demande_article ON mission ((donnees->>'articleId')) WHERE type = 'PHOTO';
