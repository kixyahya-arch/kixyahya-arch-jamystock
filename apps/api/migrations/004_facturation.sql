-- Phase C : moteur de facturation (§6.1, FAC-01 à FAC-04) et documents client (SUI-03)

-- Origine d'un instantané : calcul automatique de 23 h 59, rattrapage (service indisponible à l'heure prévue)
-- ou correction manuelle motivée (FAC-02 « recalcul possible sur une période, avec trace »).
ALTER TABLE instantane_occupation ADD COLUMN source text NOT NULL DEFAULT 'AUTO'
  CHECK (source IN ('AUTO','RATTRAPAGE','CORRECTION'));

-- Facture : revue des brouillons, émission automatique à J+2 sauf blocage, empreinte du PDF émis.
ALTER TABLE facture ADD COLUMN emission_prevue date;
ALTER TABLE facture ADD COLUMN bloquee boolean NOT NULL DEFAULT false;
ALTER TABLE facture ADD COLUMN motif_blocage text;
ALTER TABLE facture ADD COLUMN motif text;               -- motif d'un avoir (RG-SEC-01)
ALTER TABLE facture ADD COLUMN empreinte_sha256 text;    -- empreinte du PDF émis (§7.6)
ALTER TABLE facture ADD COLUMN paye_le date;
CREATE INDEX facture_entreprise_statut ON facture (entreprise_id, statut, emise_le);
CREATE INDEX prestation_entreprise_date ON prestation_a_facturer (entreprise_id, date_prestation) WHERE facture_id IS NULL;

-- Le PDF d'une facture émise est figé : sa clé et son empreinte ne s'écrivent qu'une fois.
CREATE OR REPLACE FUNCTION facture_immuable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.statut <> 'BROUILLON' THEN RAISE EXCEPTION 'Facture émise : suppression interdite (émettre un avoir)'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.statut <> 'BROUILLON' AND (
      NEW.numero IS DISTINCT FROM OLD.numero OR NEW.total_ht_cents <> OLD.total_ht_cents OR NEW.tva_cents <> OLD.tva_cents
      OR NEW.total_ttc_cents <> OLD.total_ttc_cents OR NEW.entreprise_id <> OLD.entreprise_id
      OR NEW.periode_debut IS DISTINCT FROM OLD.periode_debut OR NEW.emise_le IS DISTINCT FROM OLD.emise_le
      OR NEW.facture_origine_id IS DISTINCT FROM OLD.facture_origine_id OR NEW.type <> OLD.type
      OR (OLD.cle_pdf IS NOT NULL AND NEW.cle_pdf IS DISTINCT FROM OLD.cle_pdf)
      OR (OLD.empreinte_sha256 IS NOT NULL AND NEW.empreinte_sha256 IS DISTINCT FROM OLD.empreinte_sha256)
      OR NEW.statut = 'BROUILLON') THEN
    RAISE EXCEPTION 'Facture émise : modification interdite (émettre un avoir)';
  END IF;
  RETURN NEW;
END $$;

-- BL : le PDF est généré une fois, à la première demande, puis figé (SUI-03 « PDF horodatés et non modifiables »).
ALTER TABLE bon_de_livraison ADD COLUMN empreinte_pdf_sha256 text;

-- Tâches planifiées déjà exécutées (instantanés du jour, brouillons du mois) : évite de les rejouer
-- quand plusieurs instances tournent ou que le service redémarre.
CREATE TABLE tache_planifiee (
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  cle text NOT NULL,
  executee_le timestamptz NOT NULL DEFAULT now(),
  resultat jsonb,
  PRIMARY KEY (tenant_id, cle)
);
ALTER TABLE tache_planifiee ENABLE ROW LEVEL SECURITY;
ALTER TABLE tache_planifiee FORCE ROW LEVEL SECURITY;
CREATE POLICY tache_planifiee_isolation ON tache_planifiee
  USING (tenant_id = app_tenant() AND app_is_staff()) WITH CHECK (tenant_id = app_tenant() AND app_is_staff());
