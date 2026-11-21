-- §6.2 : alertes de forfait (RG-AL-01 à 05). La table des envois sert d'anti-spam (une alerte identique au plus
-- une fois tous les 7 jours) ; elle prend son organisation pour être isolée comme les autres.
ALTER TABLE alerte_envoyee ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES organisation(id);
ALTER TABLE alerte_envoyee ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'::jsonb;
UPDATE alerte_envoyee a SET tenant_id = e.tenant_id FROM entreprise e WHERE e.id = a.entreprise_id AND a.tenant_id IS NULL;
ALTER TABLE alerte_envoyee ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS alerte_envoyee_derniere ON alerte_envoyee (tenant_id, entreprise_id, regle, envoyee_le DESC);
ALTER TABLE alerte_envoyee ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerte_envoyee FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alerte_envoyee_isolation ON alerte_envoyee;
CREATE POLICY alerte_envoyee_isolation ON alerte_envoyee
  USING (tenant_id = app_tenant() AND (app_is_staff() OR entreprise_id = app_entreprise()))
  WITH CHECK (tenant_id = app_tenant() AND (app_is_staff() OR entreprise_id = app_entreprise()));

-- CMD-06 : photos facultatives prises par le client depuis son téléphone en demandant une collecte
ALTER TABLE photo ADD COLUMN IF NOT EXISTS commande_id uuid REFERENCES commande(id);
CREATE INDEX IF NOT EXISTS photo_commande ON photo (commande_id) WHERE commande_id IS NOT NULL;
