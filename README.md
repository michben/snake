# 🐍 Mich Snake

Jeu `.io` multijoueur temps réel : mangez, grandissez et dominez l'arène. Jouable **en ligne** (Node.js + Socket.io) ou **100 % hors-ligne** contre des bots, sur PC comme sur mobile.

## Lancer le jeu

```bash
npm install
npm start          # http://localhost:3000
npm test           # simulation du moteur + parcours de connexion X / Facebook simulé
```

Variables d'environnement : `PORT` (3000 par défaut), `BOT_COUNT` (bots par arène), `MUSIC_DIR` (musiques envoyées depuis la console, `data/music` par défaut) ; comptes et connexion sociale : voir plus bas.

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

## Niveaux

| Niveau | Ambiance |
| --- | --- |
| 🌌 Arène Néon | Grande arène sous les étoiles (4000 px, 10 bots). |
| 🌋 Cratère Volcan | Arène plus serrée, bots agressifs, éruptions annoncées qui crachent orbes et coffres. Musique dédiée. |

## Son, musiques et console admin

- **Musiques intégrées** (par michben) : `public/music/intro.mp3` (snake.mp3) pour le menu, `public/music/game.mp3` (snake 1.mp3) en partie. Lecture en Web Audio : la boucle est continue, sans blanc, avec un fondu entre menu et partie.
- **Bruitages** générés en direct (Web Audio, aucun fichier) : orbe, boost, élimination, game over, coffres, chaque pouvoir, éruption, événements fous, Hydre, quête réussie…
- **Console admin** : bouton ⚙️ (ou `…/#admin`). Volumes et test des bruitages pour tout le monde ; la gestion des musiques (importer, écouter, retirer) est **réservée au compte admin** `ADMIN_EMAIL` (sospchs@gmail.com par défaut), vérifié par le serveur à chaque envoi. Import par bouton ou glisser-déposer (MP3, OGG, WAV, M4A…, 20 Mo max) ; la musique est jouée chez tous les joueurs.

## Comptes, classement et quêtes

- **Inscription / connexion** par e-mail + mot de passe (haché en scrypt, sessions signées de 30 jours). Les records des joueurs connectés alimentent le **🏆 tableau des records mondial** ; l'onglet « Mes parties » garde les 15 meilleures parties de l'appareil.
- **Connexion X et Facebook** : la photo de profil devient le skin du serpent (📸 dans le choix des skins). À activer en créant une application chez chaque fournisseur, avec comme URL de retour `<PUBLIC_URL>/auth/x/callback` et `<PUBLIC_URL>/auth/facebook/callback`.
- **Compte admin** : `ADMIN_EMAIL` + `ADMIN_PASSWORD`. L'adresse admin ne peut pas être prise à l'inscription et un compte X / Facebook n'est jamais admin.
- **📅 Quêtes du jour** : 3 quêtes tirées chaque jour (orbes, kills, coffres, pouvoirs, score, survie, Volcan, événements, Hydre). Réussir les 3 une journée débloque 🦄 Licorne, trois journées 🐉 Dragon.

| Variable | Rôle |
| --- | --- |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Compte admin (sans `ADMIN_PASSWORD`, un mot de passe temporaire est affiché au premier démarrage). |
| `DATA_DIR` | Comptes, sessions et photos de profil (`data/` par défaut). |
| `PUBLIC_URL` | Adresse publique du jeu, pour les retours de connexion X / Facebook. |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` | Application X (OAuth 2.0, developer.x.com). |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` | Application Facebook Login (developers.facebook.com). |

## Coffres, pouvoirs et événements fous

Les coffres 🎁 (et légendaires 👑, plus gros) donnent des points, une gerbe d'orbes et souvent un pouvoir ; une flèche au bord de l'écran indique le plus proche.

| Pouvoir | Effet |
| --- | --- |
| 🧲 Super-aimant (15 s) | Attire la nourriture 5× plus loin. |
| ⚡ Turbo (10 s) | Boost gratuit et plus rapide. |
| 🛡️ Bouclier (10 s) | Traverse les serpents, rebondit sur la bordure. |
| 💎 Score x3 (20 s) | Triple les points. |
| 🗡️ Crocs (8 s) | Les serpents que vous touchez meurent. |
| 🍖 Festin | Pluie d'orbes devant vous. |
| ❄️ Blizzard | Gèle les serpents proches 5 s (lents, tournent mal). |
| 👻 Fantôme (10 s) | Traversez les murs ; les autres passent à travers vous. |
| 🍄 Géant (12 s) | Serpent énorme qui gagne tous les face-à-face. |
| 💥 Onde de choc | Les serpents proches lâchent un quart de leurs points en orbes. |
| 🌀 Portail | Téléporte à côté d'un coffre. |

Toutes les 45 à 80 s, un **événement fou** tombe sur l'arène : 🌧️ Pluie d'or, 🐉 l'Hydre (boss géant qui lâche deux coffres légendaires), ⚡ Frénésie, 🌑 Éclipse, 🎁 Déluge de coffres, 🔄 Monde à l'envers (commandes inversées).

## Contrôles

- **PC** : souris pour diriger, clic ou `Espace` pour booster, `Entrée` pour (re)jouer, `M` pour couper le son.
- **Mobile** : glissez n'importe où pour diriger, bouton ⚡ pour booster.

## Structure

```text
├── server.js              # Express + Socket.io, boucle 30 Hz, culling par joueur, API musiques/admin/comptes
├── accounts.js            # comptes, sessions signées, records, droits admin
├── oauth.js               # connexion X / Facebook et photos de profil
├── public/
│   ├── index.html
│   ├── css/style.css
│   ├── js/core.js         # moteur partagé (Node + navigateur)
│   ├── js/tower.js        # Tour des Défis & déblocages
│   ├── js/client.js       # rendu, interpolation, minimap, contrôles, mode hors-ligne
│   ├── js/audio.js        # bruitages synthétisés + musiques (fondu, serveur ou appareil)
│   ├── js/admin.js        # console admin (volumes, musiques, test des bruitages)
│   ├── js/account.js      # inscription, connexion, profil, tableau des records
│   ├── js/quests.js       # quêtes du jour
│   ├── js/fx.js           # décors des niveaux, particules, secousses
│   ├── music/             # musiques intégrées (menu, partie)
│   ├── sw.js / manifest.webmanifest / icon.svg
└── test/simulate.js, test/oauth.js
```

---
by michben
