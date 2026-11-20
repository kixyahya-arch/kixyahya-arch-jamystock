# Points ouverts et hypothèses de mise en œuvre

Ce fichier liste les choix faits dans le code là où le cahier des charges (v1.0) laisse une marge
d'interprétation. Chaque hypothèse est isolée dans une fonction pure de `packages/domain` et couverte
par un test, pour pouvoir être changée sans toucher au reste.

## Questions du cahier des charges (§9.2), en attente de réponse

1. Calcul des m² : moyenne journalière (implémentée par défaut) ou pic du mois (implémenté, paramètre `mode_surface` du forfait). Coefficient de dégagement : 1,15 par défaut, paramètre du forfait.
2. Transport : inclus au forfait par quota (`prestations_incluses`, ex. `{"LIVRAISON": 2}`), puis facturé selon la grille. Zone, km ou forfait : la grille accepte n'importe quel code de prestation.
3. Nombre de dépôts, surface, articles, opérateurs et chauffeurs à équiper.
4. Matériel terrain (smartphones, Zebra, imprimantes thermiques).
5. App terrain native ou PWA. Choix de départ : **PWA** pour le pilote (le document la juge viable), à confirmer selon le parc.
6. Paiement B2C d'avance et durée minimale d'engagement.
7. Politique d'impayé (droit de rétention).
8. Outil comptable et banque.
9. Reprise de l'existant (clients, stock, contrats).
10. Nom commercial, domaine des QR codes (`q.jamystock.fr` par défaut, paramétrable), charte graphique.

## Hypothèses d'interprétation prises dans le code

| Règle | Hypothèse | Où |
|---|---|---|
| RG-M2-02 rack | Surface facturée d'un emplacement en rack = (surface au sol ÷ niveaux) × min(1, Σ empreintes ÷ surface). | `surface.ts` |
| RG-M2-02 empilable | Les objets empilables d'un même emplacement au sol partagent sa surface : min(Σ empreintes × k, surface). | `surface.ts` |
| RG-M2-06 prorata | Le dépassement est proratisé comme l'abonnement sur un mois incomplet. | `billing.ts` |
| RG-M2-06 quota | Le quota de prestations incluses se consomme par famille de code (`LIVRAISON_ZONE1` → `LIVRAISON`), dans l'ordre chronologique. | `billing.ts` |
| RG-CMD-01 | « 48 h ouvrées » = 2 jours ouvrés pleins entre la commande et la livraison (lundi → jeudi). Fériés paramétrables. | `scheduling.ts` |
| RG-CMD-03 | L'heure de début du créneau sert de référence pour les 24 h ; à défaut, 8 h le jour J. | `orders.service.ts` |
| Statut RESERVE | Un article passe RESERVE à la soumission de la commande (et redevient EN_STOCK à l'annulation). Ce n'est pas un mouvement physique, il n'est donc pas journalisé dans `mouvement` mais dans l'audit de la commande. | `orders.service.ts` |
| Panier | Le panier n'est pas une commande « active » : il ne bloque pas l'article. Le verrou est pris à la soumission (index unique partiel). | `001_init.sql` |
| Multi-dépôts | Une commande de restitution ne regroupe que des articles d'un même dépôt. | `orders.service.ts` |
| Article refusé | Un article refusé à la livraison reste « en transit » jusqu'au scan `RETURN` au dépôt, puis repasse en réception pour être rangé. | `field.service.ts` |
| Bien sans étiquette à l'enlèvement | Il reçoit un QR provisoire interne (`P-…`) ; l'étiquette définitive est posée à la réception. | `field.service.ts` |
| Capacité | Contrôle surface et charge à l'emplacement ; un objet empilable compte pour moitié de son empreinte. Dépassement forçable avec motif (alerte superviseur). | `field.service.ts` |
| PDF du BL | Le BL signé est scellé en base (empreinte SHA-256, GPS, terminal) ; le PDF/A et le cachet serveur sont générés par le worker documents (phase D). | — |
| Photos | Les photos sont servies par liens signés de 15 min (échéance arrondie à 5 min pour le cache navigateur). Vignette (480 px) et taille moyenne (1 200 px) en WebP sont fabriquées à la première demande à partir de l'originale, puis gardées (INV-01 : vignette ≤ 40 Ko). | `files.controller.ts` |
| Pré-chargement | Le terminal pré-charge ses missions et leurs détails à l'ouverture de l'accueil ; hors réseau, il travaille sur ce dernier chargement. | `data.ts` |
| Session terrain | Si le renouvellement du jeton échoue, le terminal revient à l'écran de connexion sans perdre sa file d'envoi, qui repart à la reconnexion. | `api.ts` |
| Jauge m² (ADM-01) | Calculée à la demande avec les mêmes règles que la facturation (RG-M2-01 à 04), sur les biens présents au dépôt (en stock, réservés, en préparation). La facture reste fondée sur les instantanés quotidiens. Un B2B Utilisateur voit la surface de ses projets, sans le forfait de l'entreprise. | `client.controller.ts` |
| Estimation du panier (CMD-04) | Coût = première ligne « LIVRAISON… » de la grille du forfait, affiché « inclus » tant que les livraisons incluses du mois ne sont pas consommées ; le retrait au dépôt est gratuit. | `orders.service.ts` |
| Panier | Un panier n'immobilise pas les biens : si un bien est commandé ailleurs entre-temps, il est signalé « plus disponible » dans le panier et l'envoi est bloqué jusqu'à son retrait. | `orders.service.ts` |
