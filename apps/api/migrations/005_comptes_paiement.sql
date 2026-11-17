-- Phase D : utilisateurs clients et invitations (ADM-03), moyens de paiement Stripe (ADM-04), envoi des e-mails (§6.3).

-- ---------------------------------------------------------------------------
-- ADM-03 : invitation par e-mail, lien valable 7 jours, à usage unique
-- ---------------------------------------------------------------------------
CREATE TABLE invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  entreprise_id uuid REFERENCES entreprise(id),
  utilisateur_id uuid NOT NULL REFERENCES utilisateur(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,         -- seul le hash est conservé : le lien n'existe que dans l'e-mail
  expire_le timestamptz NOT NULL,
  acceptee_le timestamptz,
  revoquee_le timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
CREATE INDEX ON invitation (utilisateur_id);
ALTER TABLE invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitation FORCE ROW LEVEL SECURITY;
CREATE POLICY invitation_isolation ON invitation
  USING (tenant_id = app_tenant() AND (app_is_staff() OR (app_role() = 'B2B_ADMIN' AND entreprise_id = app_entreprise())))
  WITH CHECK (tenant_id = app_tenant() AND (app_is_staff() OR (app_role() = 'B2B_ADMIN' AND entreprise_id = app_entreprise())));

-- Préférences de notification par type d'événement (§6.3) : { "COMMANDE_SOUMISE": false, ... }.
-- Les messages transactionnels (invitation, BL, facture, paiement) partent toujours.
ALTER TABLE utilisateur ADD COLUMN preferences_notification jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- ADM-04 : informations de facturation et moyen de paiement
-- ---------------------------------------------------------------------------
ALTER TABLE entreprise ADD COLUMN email_facturation text;
ALTER TABLE entreprise ADD COLUMN bon_de_commande text;       -- rappelé sur les factures émises
ALTER TABLE entreprise ADD COLUMN moyen_paiement text CHECK (moyen_paiement IN ('CARTE','SEPA','VIREMENT'));
ALTER TABLE entreprise ADD COLUMN stripe_customer_id text;
ALTER TABLE entreprise ADD COLUMN stripe_payment_method_id text;
ALTER TABLE entreprise ADD COLUMN moyen_paiement_detail jsonb;  -- { marque, derniers4, expire } : jamais le numéro complet

-- Prélèvement automatique d'une facture émise (une seule tentative automatique, idempotente côté Stripe)
ALTER TABLE facture ADD COLUMN prelevement_le timestamptz;
ALTER TABLE facture ADD COLUMN prelevement_ref text;
ALTER TABLE facture ADD COLUMN prelevement_erreur text;

CREATE UNIQUE INDEX paiement_reference_unique ON paiement (reference_psp) WHERE reference_psp IS NOT NULL;
ALTER TABLE paiement ENABLE ROW LEVEL SECURITY;
ALTER TABLE paiement FORCE ROW LEVEL SECURITY;
CREATE POLICY paiement_isolation ON paiement
  USING (tenant_id = app_tenant() AND EXISTS (SELECT 1 FROM facture f WHERE f.id = facture_id))
  WITH CHECK (tenant_id = app_tenant() AND app_is_staff());

-- Événements Stripe déjà traités : un webhook rejoué ne compte pas deux fois un paiement
CREATE TABLE stripe_evenement (
  id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES organisation(id),
  type text NOT NULL,
  recu_le timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE stripe_evenement ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_evenement FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_evenement_isolation ON stripe_evenement
  USING (tenant_id = app_tenant() AND app_is_staff()) WITH CHECK (tenant_id = app_tenant() AND app_is_staff());

-- ---------------------------------------------------------------------------
-- §6.3 : file d'envoi des e-mails
-- ---------------------------------------------------------------------------
ALTER TABLE notification DROP CONSTRAINT notification_statut_check;
ALTER TABLE notification ADD CONSTRAINT notification_statut_check
  CHECK (statut IN ('EN_ATTENTE','ENVOYEE','ECHEC','LUE','IGNOREE'));
ALTER TABLE notification ADD COLUMN objet text;            -- sujet rendu au moment de l'envoi
ALTER TABLE notification ADD COLUMN fournisseur text;      -- BREVO, ou JOURNAL quand aucun service n'est configuré
ALTER TABLE notification ADD COLUMN tentatives integer NOT NULL DEFAULT 0;
ALTER TABLE notification ADD COLUMN erreur text;
ALTER TABLE notification ADD COLUMN prochaine_tentative timestamptz;
CREATE INDEX notification_a_envoyer ON notification (created_at) WHERE statut = 'EN_ATTENTE' AND canal = 'EMAIL';
ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_isolation ON notification
  USING (tenant_id = app_tenant() AND (app_is_staff() OR destinataire_id = app_user()))
  WITH CHECK (tenant_id = app_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON invitation, stripe_evenement TO jamystock_app;
