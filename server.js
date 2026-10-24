/*
 * Mich Snake — serveur multijoueur
 * Express + Socket.io, boucle physique à 30 ticks/s partagée avec le mode hors-ligne.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { World, CONFIG, SKINS } = require('./public/js/core.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { perMessageDeflate: { threshold: 1024 } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, players: Object.keys(clients).length, tick: world.tick }));

// ---------- Musiques & console admin ----------
// Deux emplacements : `menu` (présentation) et `game` (en partie). Les fichiers
// sont stockés dans MUSIC_DIR avec un petit manifeste JSON à côté.
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || path.join(__dirname, 'data', 'music'));
const MUSIC_SLOTS = ['menu', 'game'];
const MUSIC_EXT = ['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac', 'webm'];
const MUSIC_MAX_BYTES = 20 * 1024 * 1024;
const MANIFEST = path.join(MUSIC_DIR, 'manifest.json');
fs.mkdirSync(MUSIC_DIR, { recursive: true });

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!ADMIN_PASSWORD) {
    ADMIN_PASSWORD = crypto.randomBytes(4).toString('hex');
    console.log(`🔑 ADMIN_PASSWORD non défini : mot de passe admin temporaire = ${ADMIN_PASSWORD}`);
}

function readManifest() {
    try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) { return {}; }
}
function publicManifest() {
    const m = readManifest(), out = {};
    for (const slot of MUSIC_SLOTS) {
        out[slot] = m[slot] && fs.existsSync(path.join(MUSIC_DIR, m[slot].file))
            ? { name: m[slot].name, size: m[slot].size, v: m[slot].v } : null;
    }
    return out;
}

// Anti-force brute : 8 essais ratés par IP et par tranche de 10 minutes
const failures = new Map();
function requireAdmin(req, res, next) {
    const ip = req.ip;
    const f = failures.get(ip);
    if (f && f.until > Date.now() && f.n >= 8) return res.status(429).json({ error: 'Trop d\'essais, réessayez dans quelques minutes' });
    const given = Buffer.from(String(req.get('x-admin-key') || ''));
    const want = Buffer.from(ADMIN_PASSWORD);
    if (given.length === want.length && crypto.timingSafeEqual(given, want)) { failures.delete(ip); return next(); }
    const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + 10 * 60 * 1000 };
    cur.n++;
    failures.set(ip, cur);
    res.status(401).json({ error: 'Mot de passe admin incorrect' });
}

function slotParam(req, res) {
    const slot = req.params.slot;
    if (!MUSIC_SLOTS.includes(slot)) { res.status(404).json({ error: 'Emplacement inconnu' }); return null; }
    return slot;
}

app.get('/api/music', (req, res) => res.json(publicManifest()));

app.get('/music/:slot', (req, res) => {
    const slot = slotParam(req, res);
    if (!slot) return;
    const entry = readManifest()[slot];
    if (!entry) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=31536000, immutable');   // l'URL change (?v=) à chaque nouvel envoi
    res.sendFile(path.join(MUSIC_DIR, entry.file));
});

app.post('/api/admin/check', requireAdmin, (req, res) => res.json({ ok: true }));

app.put('/api/admin/music/:slot', requireAdmin, express.raw({ type: () => true, limit: MUSIC_MAX_BYTES }), (req, res) => {
    const slot = slotParam(req, res);
    if (!slot) return;
    const name = String(req.query.name || 'musique').replace(/[\u0000-\u001f]/g, '').substring(0, 120);
    const ext = (path.extname(name).slice(1) || '').toLowerCase();
    if (!MUSIC_EXT.includes(ext)) return res.status(400).json({ error: `Format non pris en charge (${MUSIC_EXT.join(', ')})` });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Fichier vide' });

    const m = readManifest();
    const file = `${slot}.${ext}`;
    if (m[slot] && m[slot].file !== file) fs.rmSync(path.join(MUSIC_DIR, m[slot].file), { force: true });
    fs.writeFileSync(path.join(MUSIC_DIR, file), req.body);
    m[slot] = { file, name, size: req.body.length, v: Date.now() };
    fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
    const pub = publicManifest();
    io.emit('music', pub);
    res.json(pub);
});

app.delete('/api/admin/music/:slot', requireAdmin, (req, res) => {
    const slot = slotParam(req, res);
    if (!slot) return;
    const m = readManifest();
    if (m[slot]) fs.rmSync(path.join(MUSIC_DIR, m[slot].file), { force: true });
    delete m[slot];
    fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
    const pub = publicManifest();
    io.emit('music', pub);
    res.json(pub);
});

app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Fichier trop lourd (20 Mo max)' });
    next(err);
});

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
        // Coffres, bonus et fins de bonus : envoyés au joueur concerné pour ses bruitages
        if (ev.type !== 'death') {
            if (clients[ev.id]) io.to(ev.id).emit('fx', ev);
            continue;
        }
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
