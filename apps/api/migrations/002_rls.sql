-- Row-Level Security (§2.3, §5.3, §7.3) : défense en profondeur derrière les contrôles de l'API.
--
-- L'API se connecte avec le rôle jamystock_app (sans BYPASSRLS) et pose dans chaque transaction :
--   SET LOCAL app.tenant_id, app.user_id, app.role, app.entreprise_id
-- Règles :
--   * tout est cloisonné par tenant ;
--   * le personnel exploitant voit tout le tenant ;
--   * un client ne voit que son entreprise ;
--   * un B2B_USER ne voit en plus que les projets qui lui sont attribués.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jamystock_app') THEN
    CREATE ROLE jamystock_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO jamystock_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO jamystock_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO jamystock_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO jamystock_app;

-- Visibilité « client » d'une ligne portant entreprise_id (et éventuellement projet_id).
CREATE FUNCTION app_voit(p_entreprise uuid, p_projet uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT app_is_staff()
      OR (p_entreprise = app_entreprise()
          AND (app_role() <> 'B2B_USER' OR (p_projet IS NOT NULL AND p_projet IN (SELECT app_projets_visibles()))))
$$;

-- Tables avec entreprise_id + projet_id
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['article','commande','instantane_occupation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I_isolation ON %I
      USING (tenant_id = app_tenant() AND app_voit(entreprise_id, projet_id))
      WITH CHECK (tenant_id = app_tenant() AND app_voit(entreprise_id, projet_id))$p$, t, t);
  END LOOP;
END $$;

-- Projet : la ligne elle-même est le périmètre
ALTER TABLE projet ENABLE ROW LEVEL SECURITY;
ALTER TABLE projet FORCE ROW LEVEL SECURITY;
CREATE POLICY projet_isolation ON projet
  USING (tenant_id = app_tenant() AND app_voit(entreprise_id, id))
  WITH CHECK (tenant_id = app_tenant() AND app_voit(entreprise_id, id));

-- Tables avec entreprise_id seulement (factures et documents : B2B_USER exclu des montants par l'API)
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['facture','forfait','carnet_adresse','bon_de_livraison','prestation_a_facturer'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I_isolation ON %I
      USING (tenant_id = app_tenant() AND (app_is_staff() OR entreprise_id = app_entreprise()))
      WITH CHECK (tenant_id = app_tenant() AND (app_is_staff() OR entreprise_id = app_entreprise()))$p$, t, t);
  END LOOP;
END $$;

-- Entreprise : un client ne voit que la sienne
ALTER TABLE entreprise ENABLE ROW LEVEL SECURITY;
ALTER TABLE entreprise FORCE ROW LEVEL SECURITY;
CREATE POLICY entreprise_isolation ON entreprise
  USING (tenant_id = app_tenant() AND (app_is_staff() OR id = app_entreprise()))
  WITH CHECK (tenant_id = app_tenant() AND app_is_staff());

-- Lignes enfants : visibles si le parent l'est
ALTER TABLE ligne_commande ENABLE ROW LEVEL SECURITY;
ALTER TABLE ligne_commande FORCE ROW LEVEL SECURITY;
CREATE POLICY ligne_commande_isolation ON ligne_commande
  USING (tenant_id = app_tenant() AND EXISTS (SELECT 1 FROM commande c WHERE c.id = commande_id))
  WITH CHECK (tenant_id = app_tenant() AND EXISTS (SELECT 1 FROM commande c WHERE c.id = commande_id));

ALTER TABLE ligne_facture ENABLE ROW LEVEL SECURITY;
ALTER TABLE ligne_facture FORCE ROW LEVEL SECURITY;
CREATE POLICY ligne_facture_isolation ON ligne_facture
  USING (tenant_id = app_tenant() AND EXISTS (SELECT 1 FROM facture f WHERE f.id = facture_id))
  WITH CHECK (tenant_id = app_tenant() AND EXISTS (SELECT 1 FROM facture f WHERE f.id = facture_id));

ALTER TABLE photo ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo FORCE ROW LEVEL SECURITY;
CREATE POLICY photo_isolation ON photo
  USING (tenant_id = app_tenant() AND (app_is_staff() OR EXISTS (SELECT 1 FROM article a WHERE a.id = article_id)))
  WITH CHECK (tenant_id = app_tenant());

ALTER TABLE mouvement ENABLE ROW LEVEL SECURITY;
ALTER TABLE mouvement FORCE ROW LEVEL SECURITY;
CREATE POLICY mouvement_isolation ON mouvement
  USING (tenant_id = app_tenant() AND (app_is_staff() OR EXISTS (SELECT 1 FROM article a WHERE a.id = article_id)))
  WITH CHECK (tenant_id = app_tenant() AND app_is_staff());

-- Journal d'audit : B2B_ADMIN en lecture sur son entreprise (§2.2)
ALTER TABLE journal_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_audit FORCE ROW LEVEL SECURITY;
CREATE POLICY journal_audit_lecture ON journal_audit FOR SELECT
  USING (tenant_id = app_tenant() AND (app_role() = 'SUPER_ADMIN' OR (app_role() = 'B2B_ADMIN' AND entreprise_id = app_entreprise())));
CREATE POLICY journal_audit_ecriture ON journal_audit FOR INSERT
  WITH CHECK (tenant_id = app_tenant());

-- Utilisateurs : un client voit les utilisateurs de son entreprise, il ne lit jamais ceux de l'exploitant
ALTER TABLE utilisateur ENABLE ROW LEVEL SECURITY;
ALTER TABLE utilisateur FORCE ROW LEVEL SECURITY;
CREATE POLICY utilisateur_isolation ON utilisateur
  USING (tenant_id = app_tenant() AND (app_is_staff() OR entreprise_id = app_entreprise() OR id = app_user()))
  WITH CHECK (tenant_id = app_tenant() AND (app_is_staff() OR (app_role() = 'B2B_ADMIN' AND entreprise_id = app_entreprise())));

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jamystock_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO jamystock_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO jamystock_app;
