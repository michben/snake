# 🐍 Mich Snake

Jeu `.io` multijoueur temps réel : mangez, grandissez et dominez l'arène. Jouable **en ligne** (Node.js + Socket.io) ou **100 % hors-ligne** contre des bots, sur PC comme sur mobile.

## Lancer le jeu

```bash
npm install
npm start          # http://localhost:3000
npm test           # simulation de 2 min du moteur (fumée)
```

Variables d'environnement : `PORT` (3000 par défaut), `BOT_COUNT` (10 par défaut).

Le dossier `public/` peut aussi être servi par n'importe quel hébergeur statique (GitHub Pages…) : le jeu détecte l'absence de serveur et passe automatiquement en mode hors-ligne avec bots.

## Nouveautés de la v2

| Fonctionnalité | Détail |
| --- | --- |
| 🧠 Moteur partagé | `public/js/core.js` tourne côté serveur **et** dans le navigateur : physique, IA des bots et snapshots identiques en ligne et hors-ligne. |
| 📡 Viewport culling | Le serveur n'envoie à chaque joueur que les entités de son champ de vision élargi (~3× moins de données), compression WebSocket activée. |
| 🎞️ Interpolation | Tampon de snapshots + horloge lissée : rendu fluide à 60/120 FPS avec un tick serveur à 30 Hz. |
| 🗺️ Minimap radar | Position du joueur et champ de vision, leader avec couronne 👑, top 10, zones denses en nourriture. |
| 🗼 Tour des Défis avancée | Missions variées (score, éliminations, orbes chronométrés, survie, classement), étages infinis générés au-delà du 16e. |
| 🎨 Skins emoji | 11 skins emoji (🐍 🔥 ⭐ 👾 🐸 de base, puis ❄️ 🌋 🪐 👑 💀 🌈 à débloquer). |
| 📱 Contrôles mobiles | Joystick virtuel dynamique + bouton Boost dédié, HUD réorganisé pour le tactile. |
| 🔌 Hors-ligne / PWA | Service Worker, manifest installable, bascule automatique en local si le serveur tombe en pleine partie. |
| 🤖 Bots plus malins | Évitement des corps et murs, recherche de nourriture, chasse des petits serpents. |
| ✨ Divers | Aimant à nourriture, tête-à-tête (le plus gros gagne), dézoom quand on grossit, écran de fin avec stats et records. |

## Contrôles

- **PC** : souris pour diriger, clic ou `Espace` pour booster, `Entrée` pour (re)jouer.
- **Mobile** : glissez n'importe où pour diriger, bouton ⚡ pour booster.

## Structure

```text
├── server.js              # Express + Socket.io, boucle 30 Hz, culling par joueur
├── public/
│   ├── index.html
│   ├── css/style.css
│   ├── js/core.js         # moteur partagé (Node + navigateur)
│   ├── js/tower.js        # Tour des Défis & déblocages
│   ├── js/client.js       # rendu, interpolation, minimap, contrôles, mode hors-ligne
│   ├── sw.js / manifest.webmanifest / icon.svg
└── test/simulate.js
```

---
by michben
