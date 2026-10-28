# 🍝 Pasta Share

Envoie des fichiers entre ton téléphone et tes PC, directement en Wi-Fi : aucun serveur, aucun compte, aucun service tiers.

## Installer

**Sur le PC (Linux)**, dans un terminal :

```sh
curl -fsSL https://starman-tech.github.io/pasta-share/install.sh | sh
```

Un QR code s'affiche : scanne-le avec le téléphone (même Wi-Fi), puis installe l'appli depuis le menu du navigateur (« Installer » / « Ajouter à l'écran d'accueil »).

L'appli PC est sur http://localhost:47801 (installable depuis Chrome ou Edge).

## Utiliser

- **Téléphone → PC** : bouton *Envoyer*, *Photo* ou *Texte*. Les fichiers arrivent dans `~/Téléchargements`.
- **PC → téléphone** : glisse des fichiers dans l'appli PC, clic droit → *Scripts* → *Envoyer avec Pasta*, ou `pasta send fichier…`. L'appli doit être ouverte sur le téléphone.
- Nouveau téléphone : *+ Ajouter* dans l'appli PC, ou `pasta pair`.

## Comment ça marche

Le PC écoute sur un port UDP fixe (47800) avec un certificat fixe. Le QR code d'appairage contient son adresse, l'empreinte de ce certificat et un secret dont sont dérivés les identifiants de connexion des deux côtés. L'appli du téléphone fabrique donc elle-même la négociation WebRTC et se connecte directement au PC : GitHub ne sert qu'à héberger l'appli et les binaires, il n'intervient jamais pendant un transfert.

- `docs/` : l'appli web (GitHub Pages), aussi servie par le PC en mode « appli PC »
- `*.go` : le récepteur (`pasta daemon`) et la commande `pasta`
