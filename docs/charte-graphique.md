# Charte graphique JAMYSTOCK

S'applique à l'app terrain et aux futurs Espace Client et Back-Office. Les règles s'inspirent d'une
référence visuelle fournie par le client (style éditorial, contrastes francs). Le nom, le logo et le
wordmark restent ceux de JAMYSTOCK.

## Couleurs

| Rôle | Jeton | Valeur | Usage |
|---|---|---|---|
| Encre | `--ink` | `#000000` | Texte, contours des boutons secondaires, onglet actif |
| Fond | `--bg` | `#ffffff` | Pages |
| Gris doux | `--muted-bg` | `#f0f0f0` | Panneaux, onglets inactifs, cartes d'information, mentions |
| Citron | `--lime` | `#e5ff31` | **Une seule action principale par écran** (bouton plein, texte noir), points d'état actifs |
| Bordeaux | `--maroon` | `#7e2b24` | Bandeau d'appel à l'action pleine largeur, actions destructrices, alertes |
| Barre | `--bar` | `#000000` | En-tête et pied de page, écran de connexion |

Le citron ne porte jamais de texte blanc et ne sert pas de couleur de texte sur fond blanc. Ses usages
lisibles sont un fond sous du texte noir, ou un texte et un trait sur fond noir.
Le mode sombre inverse fond et encre, sans toucher au citron ni au bordeaux.

## Typographie

- **Titres** : *Instrument Serif* (OFL), poids 400, interlettrage −1 %, interligne serré (1,1).
  Les grands titres de section sont centrés sur le web.
- **Texte et interface** : *Inter* (OFL, variable), 400 pour le texte, 600 pour les libellés et boutons.
- **Wordmark** : « jamystock » en minuscules, Inter 800, interlettrage serré. Il est très grand sur fond noir
  à la connexion et dans le pied de page.
- Les polices sont auto-hébergées (`@fontsource`), donc aucun appel à un service tiers, et elles restent
  disponibles hors-ligne.

## Formes

- **Boutons en pilule** (`border-radius: 999px`) :
  - principal : fond citron, contour noir ;
  - secondaire : fond blanc, contour noir 1,5 px ;
  - danger : bordeaux.
- **Onglets et filtres en pilule** : gris doux à l'état inactif, noir avec texte blanc à l'état actif.
- **Cartes** : peu ou pas de bordure, rayon de 8 px, fond gris doux pour l'information et fond blanc à contour
  noir pour un récapitulatif à valider.
- **Icônes** : pastille carrée de 40 px, rayon de 8 px, fond citron.

## Mise en page (web)

- En-tête noir avec, à droite, un lien « Se connecter » souligné, un bouton secondaire en pilule (contour blanc)
  et le bouton principal citron.
- Le héros associe une image arrondie et un grand titre serif, avec le texte d'accroche en Inter.
- Les grilles de fonctionnalités s'organisent en 3 colonnes. Chaque élément a son icône, un titre serif,
  2 à 3 lignes de texte et un lien « EN SAVOIR PLUS ↗ » en petites capitales.
- Un bandeau bordeaux pleine largeur, à coins arrondis, porte un titre serif blanc et un bouton citron.
- Le pied de page est noir, sur 4 colonnes de liens, avec le wordmark géant en bas.

## Terrain (contraintes propres)

Cibles tactiles d'au moins 56 px, contraste AA minimum, un seul bouton citron par écran, texte jamais
sous 16 px. L'état de synchronisation est un point citron (envoyé), un cercle citron (en attente) ou
un point rouge (hors réseau).
