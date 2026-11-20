-- Reprise des données de l'ancien logiciel (Monstock / « JAMYSO STOCK ») : comptes clients, stock, photos.
-- L'import est rejouable : chaque article garde la clé de sa ligne d'origine, un second passage ne crée pas de doublon.

ALTER TABLE article ADD COLUMN origine_import text;
-- Code-barres ou étiquette de l'ancien logiciel : retrouve l'objet en scannant l'ancienne étiquette pendant la transition.
ALTER TABLE article ADD COLUMN ancien_code text;
CREATE UNIQUE INDEX article_origine_import ON article (tenant_id, origine_import) WHERE origine_import IS NOT NULL;
CREATE INDEX article_ancien_code ON article (tenant_id, ancien_code) WHERE ancien_code IS NOT NULL;

-- Photos de l'ancien logiciel à rapatrier : téléchargées par lots depuis le Back-Office, puis versées dans `photo`.
CREATE TABLE reprise_photo (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  article_id uuid NOT NULL REFERENCES article(id),
  url text NOT NULL,
  statut text NOT NULL DEFAULT 'A_TELECHARGER' CHECK (statut IN ('A_TELECHARGER', 'TELECHARGEE', 'ECHEC')),
  essais integer NOT NULL DEFAULT 0,
  erreur text,
  photo_id uuid REFERENCES photo(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (article_id, url)
);
CREATE INDEX reprise_photo_a_faire ON reprise_photo (tenant_id, statut);

ALTER TABLE reprise_photo ENABLE ROW LEVEL SECURITY;
ALTER TABLE reprise_photo FORCE ROW LEVEL SECURITY;
CREATE POLICY reprise_photo_isolation ON reprise_photo
  USING (tenant_id = app_tenant() AND app_is_staff()) WITH CHECK (tenant_id = app_tenant() AND app_is_staff());
GRANT SELECT, INSERT, UPDATE ON reprise_photo TO jamystock_app;
