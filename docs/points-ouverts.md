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
