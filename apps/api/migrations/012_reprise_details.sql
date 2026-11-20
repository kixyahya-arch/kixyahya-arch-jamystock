-- Détails repris de l'ancien logiciel et utiles au quotidien : couleur de l'objet (distingue des objets identiques)
-- et emplacement noté dans l'ancien logiciel (« allée G3 haut »), affiché pendant la transition.
ALTER TABLE article ADD COLUMN couleur text CHECK (couleur IS NULL OR length(couleur) <= 60);
ALTER TABLE article ADD COLUMN emplacement_origine text CHECK (emplacement_origine IS NULL OR length(emplacement_origine) <= 120);

-- Objets installés chez le client : une collecte peut porter sur des objets déjà connus (avec leur QR) au lieu de
-- nouveaux biens. RETOUR : ils reviennent au dépôt et sont rangés ; TRANSFERT : ils partent d'un site client vers un autre.
ALTER TABLE commande ADD COLUMN nature_collecte text NOT NULL DEFAULT 'NOUVEAUX'
  CHECK (nature_collecte IN ('NOUVEAUX', 'RETOUR', 'TRANSFERT'));
ALTER TABLE commande ADD COLUMN destination jsonb;
ALTER TABLE commande ADD COLUMN destination_projet_id uuid REFERENCES projet(id);
ALTER TABLE commande ADD CONSTRAINT transfert_avec_destination CHECK (nature_collecte <> 'TRANSFERT' OR destination IS NOT NULL);
