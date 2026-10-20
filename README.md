# CRM Brûlée — site vitrine

Site d'une page de CRM Brûlée (growth et GTM engineering B2B) : une flamme en verre de
sucre cuit en 3D (Three.js) qui accompagne le défilement sur quatre chapitres, puis un
chapitre contact.

## Dossiers

| Dossier | Contenu |
|---|---|
| `site/` | Le site prêt à héberger. C'est ce dossier qu'on met en ligne. |
| `site/version-monofichier.html` | Tout le site dans un seul fichier, qui s'ouvre d'un double-clic. |
| `source/` | Le gabarit et le brief (`source/site.json`) qui servent à régénérer `site/`. |

## Voir le site en local

```bash
python site/serve.py 5180
```

Puis ouvrir http://127.0.0.1:5180. Ajouter `0.0.0.0` après le port pour l'ouvrir depuis
un téléphone sur le même Wi-Fi.

## Version sans 3D

Si le navigateur ne peut pas afficher la 3D (pas de WebGL 2, ancien iPhone, JavaScript
coupé, appareil beaucoup trop lent, plantage), le site passe tout seul sur une page
classique : mêmes textes, mêmes couleurs, une image fixe de la flamme
(`assets/brand/flamme.jpg`). Pour la voir sur n'importe quel appareil, ajouter
`?sans-3d` à l'adresse : https://crm-brulee.vercel.app/?sans-3d

## Modifier

- **Petite retouche de texte** : directement dans `site/index.html`, puis
  `python site/build_monofichier.py` pour mettre à jour la version monofichier.
- **Modifications durables** : éditer `source/site.json` (textes, chiffres, e-mail), puis
  régénérer tout le site :

  ```bash
  python source/tools/build_site.py source/site.json --out site
  ```

  Attention : cette commande remplace entièrement le dossier `site/`.

## À compléter avant la mise en ligne

- L'adresse e-mail `bonjour@crmbrulee.fr` est provisoire (`email` dans `source/site.json`).
- `site_url` dans `source/site.json` : l'adresse du site, nécessaire pour l'aperçu des
  liens sur LinkedIn.

Crédits des polices, logos et chiffres cités : `source/SOURCES.md`.
