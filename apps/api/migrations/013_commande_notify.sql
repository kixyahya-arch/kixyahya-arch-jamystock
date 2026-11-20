-- SUI-01 : suivi en temps réel. Chaque changement de statut d'une commande est publié (LISTEN/NOTIFY) ;
-- l'API le relaie aux pages ouvertes (SSE). Le déclencheur couvre tous les points d'écriture du statut.
CREATE OR REPLACE FUNCTION notifier_statut_commande() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('commande_statut', json_build_object(
    'tenantId', NEW.tenant_id, 'id', NEW.id, 'entrepriseId', NEW.entreprise_id, 'statut', NEW.statut
  )::text);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS commande_statut_notify ON commande;
CREATE TRIGGER commande_statut_notify
  AFTER UPDATE OF statut ON commande
  FOR EACH ROW WHEN (OLD.statut IS DISTINCT FROM NEW.statut)
  EXECUTE FUNCTION notifier_statut_commande();
