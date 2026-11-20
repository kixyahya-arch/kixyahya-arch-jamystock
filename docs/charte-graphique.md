# Charte graphique JAMYSTOCK

Source : [charte-graphique.pdf](charte-graphique.pdf) (« Système d'identité visuelle », Mobydev, novembre 2026).
JAMYSTOCK reprend le système de JAMYS : même palette, même dégradé, même reflet, même épaisseur de trait blanc.
La charte s'applique au Back-Office, à l'Espace Client, à l'app terrain, à la page de suivi publique, aux e-mails
et aux documents PDF (factures, avoirs, BL, inventaires, étiquettes).

## Marque

- **Symbole** : la goutte de JAMYS devient un repère de carte, le colis (cube) remplace la coche. Trait blanc à 7 %
  du symbole, reflet clair en haut à gauche. Code : `components/Brand.tsx` (dans chaque appli) et
  `apps/api/src/common/brand-pdf.ts` pour les PDF.
- **Nom** : « JAMYSTOCK » en capitales, Sora SemiBold. Signature « STOCKAGE & LOGISTIQUE » en petites capitales
  espacées, Vert frais.
- **Déclinaisons** : couleur (dégradé) sur fond clair, **blanche sur fond foncé** (en-têtes encre, écrans de
  connexion), monochrome encre quand la couleur n'est pas possible (PDF imprimés, étiquettes noir sur blanc).
- **Marque responsive** : logo complet (A), symbole seul (B, barre de l'app terrain, icône), « JAMYSTOCK » seul
  (C, grand mot du pied de page), symbole minimal (D).
- **Icône d'application** (PWA, favicon) : carré arrondi au dégradé officiel, symbole blanc.

| À faire | À éviter |
|---|---|
| Conserver la zone de protection | Déformer ou étirer le logo |
| Utiliser le dégradé officiel | Modifier les couleurs |
| Version blanche sur fond foncé | Ajouter ombre ou contour |
| Garder symbole et nom alignés | Logo couleur sur fond chargé |

## Couleurs

| Rôle | Jeton CSS | Valeur | Usage |
|---|---|---|---|
| Azur | `--azur` | `#0EA5E9` | Début du dégradé, onglet actif de la navigation, « en cours de livraison » |
| Vert frais | `--vert` | `#16C47F` | Fin du dégradé, signature du logo, point « envoyé » du terrain |
| Encre | `--encre` / `--ink` | `#0A2A43` | Texte, en-têtes et pieds de page, « stocké » |
| Clair | `--clair` / `--ok-bg` | `#ECFBF4` | Fond « livré », total des factures |
| Dégradé officiel | `--gradient` | 135°, Azur → Vert frais | Porte le volume de la marque : action principale, filet en haut des en-têtes et des PDF, bandeau d'appel, icône |
| Gris neutre | `--muted-bg` | `#EEF2F6` | Panneaux, onglets inactifs, « annulé / archivé » |
| Rouge alerte | `--alert` / `--danger` | `#DC2626` / `#B91C1C` | Alertes, actions destructrices, dépassement de forfait. **Jamais décoratif** |

Le mode sombre passe le fond en encre profonde (`#061A2B`) et le texte en clair, sans toucher à l'Azur, au Vert ni
au dégradé.

### Couleurs fonctionnelles (pastilles de statut)

| Statut | Ton (`StatusPill`) | Rendu |
|---|---|---|
| En préparation, à traiter, planifiée | `accent` | Azur, fond éclairci |
| En cours de livraison, tournée en route | `route` | Azur plein |
| Livré, payé, résolu | `ok` | Clair + vert foncé |
| Stocké (en stock) | `dark` | Encre |
| Dépassement de forfait, refus, échec, retard | `alert` | Rouge alerte sur fond rosé |
| Annulé / archivé, brouillon | `neutral` | Gris neutre |

### Contraste

Texte sur Azur, Vert ou dégradé : **toujours en encre** (≥ 5:1, AA). Le blanc sur Azur ou Vert (≈ 2,8:1 et 2,3:1)
n'atteint pas AA : il est réservé au logo, jamais aux libellés ni aux boutons. Le Vert frais n'est pas une couleur de
texte sur fond blanc (sauf la signature du logo) : le texte « livré » utilise le vert foncé `#0B7A4F`.

## Typographie

- **Titres et nom** : *Sora* SemiBold (600), interlettrage −2 %, interligne 1,1.
- **Texte et interface** : *Manrope* (variable), 400 pour le texte, 600–700 pour les libellés et boutons.
- Polices auto-hébergées (`@fontsource-variable/sora`, `@fontsource-variable/manrope`, licence OFL) : aucun appel à
  un service tiers, disponibles hors-ligne sur le terrain.
- E-mails : Sora / Manrope si installées, repli Segoe UI, Helvetica, Arial. PDF : Helvetica (polices standard PDF,
  aucun fichier de police à embarquer).

## Formes

- **Boutons en pilule** (`border-radius: 999px`) :
  - principal : dégradé officiel, texte encre, une seule action principale par écran ;
  - secondaire : fond blanc, contour encre 1,5 px ;
  - danger : rouge alerte.
- **Onglets et filtres en pilule** : gris neutre à l'état inactif, encre avec texte blanc à l'état actif.
- **Cartes** : rayon 8 px (12–16 px pour les blocs de mise en avant), fond gris neutre pour l'information.
- **Icônes** : pastille carrée de 40 px, rayon 8 px, dégradé officiel, pictogramme encre.

## Applications

- **En-têtes web** : barre encre, filet du dégradé en haut, logo en version blanche, lien actif souligné Azur.
- **Connexion** : fond encre, logo complet blanc avec sa signature.
- **Pied de page (Espace Client)** : encre, colonnes de liens, « JAMYSTOCK » géant en Sora.
- **Bandeau d'appel** : dégradé officiel, titre encre, bouton encre.
- **App terrain** : barre encre avec le symbole blanc, cibles tactiles ≥ 56 px, texte ≥ 16 px. État de
  synchronisation : point vert (envoyé), cercle azur (en attente), point rouge (hors réseau).
- **E-mails** : filet dégradé, « JAMYSTOCK » + signature en texte (les SVG sont bloqués par les messageries),
  bouton au dégradé à texte encre, pied encre.
- **PDF** (factures, avoirs, BL, inventaires) : filet dégradé en haut de page, symbole monochrome encre devant la
  raison sociale, texte encre, total TTC sur fond Clair.
- **Étiquettes** (emplacement / article) : impression noir sur blanc, scannable en entrepôt ; symbole et
  « JAMYSTOCK » en tête quand l'étiquette est assez haute (≥ 25 mm).
