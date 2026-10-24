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
const { World, CONFIG, SKINS, LEVELS } = require('./public/js/core.js');
const { createAccounts } = require('./accounts');
const { setupOAuth } = require('./oauth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { perMessageDeflate: { threshold: 1024 } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, players: Object.keys(clients).length, tick: worlds.neon.tick }));

// ---------- Musiques & console admin ----------
// Emplacements : `menu` (présentation), `game` (niveau 1) et `game2` (niveau 2). Les fichiers
// sont stockés dans MUSIC_DIR avec un petit manifeste JSON à côté.
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || path.join(__dirname, 'data', 'music'));
const MUSIC_SLOTS = ['menu', 'game', 'game2'];
const MUSIC_EXT = ['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac', 'webm'];
const MUSIC_MAX_BYTES = 20 * 1024 * 1024;
const MANIFEST = path.join(MUSIC_DIR, 'manifest.json');
fs.mkdirSync(MUSIC_DIR, { recursive: true });

// ---------- Comptes joueurs ----------
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const accounts = createAccounts({
    dataDir: DATA_DIR,
    adminEmail: process.env.ADMIN_EMAIL || 'sospchs@gmail.com',
    adminPassword: ADMIN_PASSWORD || (ADMIN_PASSWORD = crypto.randomBytes(5).toString('hex'))
});
if (!process.env.ADMIN_PASSWORD) {
    console.log(`🔑 ADMIN_PASSWORD non défini : si le compte admin ${accounts.ADMIN_EMAIL} vient d'être créé, son mot de passe est ${ADMIN_PASSWORD}`);
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

// Anti-force brute : 8 connexions ratées par IP et par tranche de 10 minutes
const failures = new Map();
function tooManyFailures(ip) {
    const f = failures.get(ip);
    return !!f && f.until > Date.now() && f.n >= 8;
}
function noteFailure(ip) {
    const f = failures.get(ip);
    const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + 10 * 60 * 1000 };
    cur.n++;
    failures.set(ip, cur);
}

function bearer(req) {
    const h = String(req.get('authorization') || '');
    return accounts.verify(h.startsWith('Bearer ') ? h.slice(7) : '');
}

// Droits admin : uniquement le compte ADMIN_EMAIL, vérifié côté serveur à chaque requête
function requireAdmin(req, res, next) {
    const u = bearer(req);
    if (!u) return res.status(401).json({ error: 'Connectez-vous avec le compte admin' });
    if (!accounts.isAdmin(u)) return res.status(403).json({ error: 'Réservé à l\'administrateur' });
    next();
}

app.post('/api/auth/register', express.json({ limit: '4kb' }), (req, res) => {
    if (tooManyFailures(req.ip)) return res.status(429).json({ error: 'Trop d\'essais, réessayez dans quelques minutes' });
    try { res.json(accounts.register(req.body || {})); } catch (e) { noteFailure(req.ip); res.status(400).json({ error: e.message }); }
});

app.post('/api/auth/login', express.json({ limit: '4kb' }), (req, res) => {
    if (tooManyFailures(req.ip)) return res.status(429).json({ error: 'Trop d\'essais, réessayez dans quelques minutes' });
    try { const out = accounts.login(req.body || {}); failures.delete(req.ip); res.json(out); } catch (e) { noteFailure(req.ip); res.status(401).json({ error: e.message }); }
});

app.get('/api/auth/me', (req, res) => {
    const u = bearer(req);
    if (!u) return res.status(401).json({ error: 'Session expirée' });
    res.json({ user: accounts.publicUser(u) });
});

setupOAuth(app, { accounts, dataDir: DATA_DIR });

app.get('/api/leaderboard', (req, res) => res.json({ top: accounts.hallOfFame(20) }));

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

const BOT_COUNT = process.env.BOT_COUNT ? parseInt(process.env.BOT_COUNT, 10) : undefined;
const MAX_VIEW_W = 4200;
const MAX_VIEW_H = 3000;

// Une arène par niveau, chacune avec ses bots
const worlds = {};
for (const key in LEVELS) worlds[key] = new World({ level: key, botCount: BOT_COUNT });

// État réseau par socket : niveau, taille de la vue (en unités monde) et dernière position connue
const clients = {};

io.on('connection', (socket) => {
    const lobby = worlds.neon;
    clients[socket.id] = { level: 'neon', view: { w: 1600, h: 1000 }, last: { x: lobby.size / 2, y: lobby.size / 2 }, playing: false };

    socket.emit('hello', { id: socket.id, arenaSize: lobby.size, tickRate: CONFIG.TICK_RATE });

    socket.on('joinGame', (data = {}) => {
        const name = typeof data.name === 'string' ? data.name.trim().substring(0, 14) : '';
        const skin = typeof data.skin === 'string' && SKINS[data.skin] ? data.skin : 'neon';
        const level = typeof data.level === 'string' && worlds[data.level] ? data.level : 'neon';
        const account = accounts.verify(data.token);
        for (const key in worlds) worlds[key].removeSnake(socket.id);
        const world = worlds[level];
        const s = world.addSnake(socket.id, name || 'Serpent', skin, false);
        // Connecté via X / Facebook : la photo de profil remplace l'emoji
        if (account && account.avatar && data.photo) s.avatar = account.avatar;
        Object.assign(clients[socket.id], { level, playing: true, last: { x: s.x, y: s.y }, email: account ? account.email : null });
        socket.emit('init', { id: socket.id, arenaSize: world.size, level, tickRate: CONFIG.TICK_RATE });
    });

    socket.on('input', (data = {}) => {
        const c = clients[socket.id];
        if (c) worlds[c.level].setInput(socket.id, Number(data.a), !!data.b);
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
        for (const key in worlds) worlds[key].removeSnake(socket.id);
        delete clients[socket.id];
    });
});

setInterval(() => {
    for (const key in worlds) {
        const world = worlds[key];
        world.step();

        for (const ev of world.drainEvents()) {
            // Événements fous et chute de l'Hydre : annoncés à toute l'arène
            if (ev.type === 'world' || ev.type === 'worldEnd' || ev.type === 'bossDown') {
                for (const id in clients) if (clients[id].level === key) io.to(id).emit('fx', ev);
                continue;
            }
            // Coffres, bonus et fins de bonus : envoyés au joueur concerné pour ses bruitages
            if (ev.type !== 'death') {
                if (clients[ev.id]) io.to(ev.id).emit('fx', ev);
                continue;
            }
            if (!ev.isBot && clients[ev.id]) {
                const c = clients[ev.id];
                c.playing = false;
                // Joueur connecté : records enregistrés sur son compte
                const rec = c.email ? accounts.recordGame(c.email, ev) : null;
                io.to(ev.id).emit('died', rec ? Object.assign({}, ev, { account: rec.user, accountBest: rec.isBest }) : ev);
            }
            if (ev.killerId && clients[ev.killerId]) {
                io.to(ev.killerId).emit('kill', { victim: ev.name, x: Math.round(ev.x), y: Math.round(ev.y) });
            }
        }
    }

    for (const id in clients) {
        const c = clients[id];
        const world = worlds[c.level];
        const me = world.snakes[id];
        if (me) c.last = { x: me.x, y: me.y };
        const snap = world.snapshotFor(id, { x: c.last.x, y: c.last.y, w: c.view.w, h: c.view.h }, world.tick % 15 === 0);
        io.to(id).volatile.emit('state', snap);
    }
}, 1000 / CONFIG.TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🐍 Mich Snake lancé sur http://localhost:${PORT}`);
});
