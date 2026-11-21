-- Compte rendu Adam (21/11) : un modèle de panier devient un pack (ensemble de meubles pour un logement ou un site),
-- avec une description et la pièce de chaque bien, pour la planche d'aménagement par pièce.
ALTER TABLE modele_panier ADD COLUMN IF NOT EXISTS description text CHECK (description IS NULL OR length(description) <= 500);
-- { "<article_id>": "Salon", ... } : la pièce où le bien est prévu (facultatif)
ALTER TABLE modele_panier ADD COLUMN IF NOT EXISTS pieces jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE modele_panier ADD COLUMN IF NOT EXISTS modifie_le timestamptz;

-- Activités du client : le fil se lit par date
CREATE INDEX IF NOT EXISTS mouvement_horodatage ON mouvement (tenant_id, horodatage_serveur DESC);
CREATE INDEX IF NOT EXISTS commande_creation ON commande (tenant_id, entreprise_id, created_at DESC);
