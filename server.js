const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Paramètres de l'arène
const ARENA_SIZE = 3000;
const INITIAL_LENGTH = 15;
const SEGMENT_DISTANCE = 10;
const BASE_SPEED = 5.5;
const BOOST_SPEED = 9.5;
const MAX_FOOD = 350;
const BOT_COUNT = 8;

let players = {};
let foods = [];

// Skins disponibles
const SKINS = {
    neon: { primary: '#00ffcc', secondary: '#00997a', glow: '#00ffcc' },
    fire: { primary: '#ff3300', secondary: '#ff9900', glow: '#ff3300' },
    gold: { primary: '#ffd700', secondary: '#b8860b', glow: '#ffd700' },
    cyber: { primary: '#ff00ff', secondary: '#7700ff', glow: '#ff00ff' },
    toxic: { primary: '#39ff14', secondary: '#1b8a06', glow: '#39ff14' }
};

// Génération de nourriture
function createFood(x, y, value = 1, color = null) {
    const colors = ['#ff0055', '#00ffcc', '#ffcc00', '#aa00ff', '#00ff44', '#00aaff'];
    return {
        id: Math.random().toString(36).substr(2, 9),
        x: x !== undefined ? x : Math.random() * (ARENA_SIZE - 100) + 50,
        y: y !== undefined ? y : Math.random() * (ARENA_SIZE - 100) + 50,
        value: value,
        radius: value > 1 ? 9 : 5,
        color: color || colors[Math.floor(Math.random() * colors.length)]
    };
}

for (let i = 0; i < MAX_FOOD; i++) {
    foods.push(createFood());
}

// Création d'un serpent (Joueur ou Bot)
function createSnake(id, name, skinKey, isBot = false) {
    const startX = Math.random() * (ARENA_SIZE - 600) + 300;
    const startY = Math.random() * (ARENA_SIZE - 600) + 300;
    const segments = [];
    for (let i = 0; i < INITIAL_LENGTH; i++) {
        segments.push({ x: startX - i * SEGMENT_DISTANCE, y: startY });
    }
    return {
        id,
        name: name || 'Anonyme',
        skin: SKINS[skinKey] ? skinKey : 'neon',
        isBot,
        x: startX,
        y: startY,
        angle: Math.random() * Math.PI * 2,
        targetAngle: 0,
        speed: BASE_SPEED,
        boosting: false,
        score: 100,
        radius: 14,
        segments
    };
}

// Initialisation des Bots
const botNames = ['Viper_FR', 'Cobrakai', 'Kaa', 'Orochimaru', 'SnackAttack', 'SlitherKing', 'Nagini', 'PythonDev'];
const skinKeys = Object.keys(SKINS);
for (let i = 0; i < BOT_COUNT; i++) {
    const botId = `bot_${i}`;
    players[botId] = createSnake(botId, botNames[i], skinKeys[i % skinKeys.length], true);
}

// Connexion Socket.io
io.on('connection', (socket) => {
    socket.on('joinGame', ({ name, skin }) => {
        players[socket.id] = createSnake(socket.id, name.substring(0, 14), skin, false);
        socket.emit('init', { id: socket.id, arenaSize: ARENA_SIZE, skins: SKINS });
    });

    socket.on('input', ({ angle, boosting }) => {
        const p = players[socket.id];
        if (p) {
            p.targetAngle = angle;
            p.boosting = boosting && p.score > 120;
        }
    });

    socket.on('disconnect', () => {
        delete players[socket.id];
    });
});

// Logique de mort et transformation du corps en nourriture
function killSnake(id) {
    const p = players[id];
    if (!p) return;

    for (let i = 0; i < p.segments.length; i += 2) {
        const seg = p.segments[i];
        foods.push(createFood(
            seg.x + (Math.random() * 20 - 10),
            seg.y + (Math.random() * 20 - 10),
            3,
            SKINS[p.skin].primary
        ));
    }

    if (p.isBot) {
        players[id] = createSnake(id, p.name, p.skin, true);
    } else {
        io.to(id).emit('died', { score: Math.floor(p.score) });
        delete players[id];
    }
}

// Boucle principale du jeu (30 FPS côté serveur)
setInterval(() => {
    const playerIds = Object.keys(players);

    playerIds.forEach((id) => {
        const p = players[id];
        if (!p) return;

        // Comportement IA simple pour les Bots
        if (p.isBot) {
            const margin = 250;
            if (p.x < margin) p.targetAngle = 0;
            else if (p.x > ARENA_SIZE - margin) p.targetAngle = Math.PI;
            else if (p.y < margin) p.targetAngle = Math.PI / 2;
            else if (p.y > ARENA_SIZE - margin) p.targetAngle = -Math.PI / 2;
            else if (Math.random() < 0.05) {
                p.targetAngle += (Math.random() - 0.5) * 1.5;
            }
        }

        // Rotation fluide
        let diff = p.targetAngle - p.angle;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        p.angle += diff * 0.18;

        // Gestion du Boost
        if (p.boosting && p.score > 120) {
            p.speed = BOOST_SPEED;
            p.score -= 0.6;
            if (Math.random() < 0.25) {
                const tail = p.segments[p.segments.length - 1];
                foods.push(createFood(tail.x, tail.y, 1, SKINS[p.skin].primary));
            }
        } else {
            p.boosting = false;
            p.speed = BASE_SPEED;
        }

        // Déplacement de la tête
        p.x += Math.cos(p.angle) * p.speed;
        p.y += Math.sin(p.angle) * p.speed;

        // Collision avec les bordures de l'arène
        if (p.x < 0 || p.x > ARENA_SIZE || p.y < 0 || p.y > ARENA_SIZE) {
            killSnake(id);
            return;
        }

        // Ajustement de la taille selon le score
        p.radius = Math.min(28, 13 + Math.floor(p.score / 250));
        const targetLength = INITIAL_LENGTH + Math.floor((p.score - 100) / 15);

        p.segments.unshift({ x: p.x, y: p.y });
        while (p.segments.length > targetLength) {
            p.segments.pop();
        }

        // Manger de la nourriture
        for (let i = foods.length - 1; i >= 0; i--) {
            const f = foods[i];
            const dist = Math.hypot(p.x - f.x, p.y - f.y);
            if (dist < p.radius + f.radius + 5) {
                p.score += f.value * 8;
                foods.splice(i, 1);
                if (foods.length < MAX_FOOD) foods.push(createFood());
            }
        }

        // Collision avec les autres serpents
        playerIds.forEach((otherId) => {
            if (id === otherId) return;
            const other = players[otherId];
            if (!other) return;

            for (let i = 0; i < other.segments.length; i++) {
                const seg = other.segments[i];
                const dist = Math.hypot(p.x - seg.x, p.y - seg.y);
                if (dist < p.radius + other.radius - 4) {
                    other.score += 50;
                    killSnake(id);
                    break;
                }
            }
        });
    });

    io.emit('gameState', { players, foods });
}, 1000 / 30);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur Snake Clash lancé sur http://localhost:${PORT}`);
});
