/*
 * Mich Snake — serveur multijoueur
 * Express + Socket.io, boucle physique à 30 ticks/s partagée avec le mode hors-ligne.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { World, CONFIG, SKINS } = require('./public/js/core.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { perMessageDeflate: { threshold: 1024 } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, players: Object.keys(clients).length, tick: world.tick }));

const BOT_COUNT = parseInt(process.env.BOT_COUNT || '10', 10);
const MAX_VIEW_W = 4200;
const MAX_VIEW_H = 3000;

const world = new World({ botCount: BOT_COUNT });

// État réseau par socket : taille de la vue (en unités monde) et dernière position connue
const clients = {};

io.on('connection', (socket) => {
    clients[socket.id] = { view: { w: 1600, h: 1000 }, last: { x: world.size / 2, y: world.size / 2 }, playing: false };

    socket.emit('hello', { id: socket.id, arenaSize: world.size, tickRate: CONFIG.TICK_RATE });

    socket.on('joinGame', (data = {}) => {
        const name = typeof data.name === 'string' ? data.name.trim().substring(0, 14) : '';
        const skin = typeof data.skin === 'string' && SKINS[data.skin] ? data.skin : 'neon';
        world.removeSnake(socket.id);
        const s = world.addSnake(socket.id, name || 'Serpent', skin, false);
        clients[socket.id].playing = true;
        clients[socket.id].last = { x: s.x, y: s.y };
        socket.emit('init', { id: socket.id, arenaSize: world.size, tickRate: CONFIG.TICK_RATE });
    });

    socket.on('input', (data = {}) => {
        world.setInput(socket.id, Number(data.a), !!data.b);
    });

    socket.on('view', (data = {}) => {
        const c = clients[socket.id];
        if (!c) return;
        const w = Number(data.w), h = Number(data.h);
        if (isFinite(w) && isFinite(h)) {
            c.view.w = Math.max(400, Math.min(MAX_VIEW_W, w));
            c.view.h = Math.max(300, Math.min(MAX_VIEW_H, h));
        }
    });

    socket.on('ping_check', (ack) => { if (typeof ack === 'function') ack(); });

    socket.on('disconnect', () => {
        world.removeSnake(socket.id);
        delete clients[socket.id];
    });
});

setInterval(() => {
    world.step();

    for (const ev of world.drainEvents()) {
        if (ev.type !== 'death') continue;
        if (!ev.isBot && clients[ev.id]) {
            clients[ev.id].playing = false;
            io.to(ev.id).emit('died', ev);
        }
        if (ev.killerId && clients[ev.killerId]) {
            io.to(ev.killerId).emit('kill', { victim: ev.name });
        }
    }

    const withDensity = world.tick % 15 === 0;
    for (const id in clients) {
        const c = clients[id];
        const me = world.snakes[id];
        if (me) c.last = { x: me.x, y: me.y };
        const snap = world.snapshotFor(id, { x: c.last.x, y: c.last.y, w: c.view.w, h: c.view.h }, withDensity);
        io.to(id).volatile.emit('state', snap);
    }
}, 1000 / CONFIG.TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🐍 Mich Snake lancé sur http://localhost:${PORT}`);
});
