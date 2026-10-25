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
// Compression des messages au niveau le plus rapide : presque le même gain de bande passante,
// pour une fraction du CPU (la compression zlib était le premier poste de dépense du serveur)
const io = new Server(server, {
    perMessageDeflate: process.env.WS_DEFLATE === '0' ? false : {
        threshold: 1024,
        zlibDeflateOptions: { level: +(process.env.WS_DEFLATE_LEVEL || 1), memLevel: 8 }
    }
});
// Derrière l'hébergeur (Render, Railway…), le HTTPS est terminé par un proxy : on lui fait confiance
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, players: Object.keys(clients).length, rooms: Object.keys(rooms).length }));

// ---------- Musiques & console admin ----------
// Emplacements : `menu` (présentation), `game` (niveau 1) et `game2` (niveau 2). Les fichiers
// sont stockés dans MUSIC_DIR avec un petit manifeste JSON à côté.
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || path.join(DATA_DIR, 'music'));
const MUSIC_SLOTS = ['menu', 'game', 'game2'];
const MUSIC_EXT = ['mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'aac', 'flac', 'webm'];
const MUSIC_MAX_BYTES = 20 * 1024 * 1024;
const MANIFEST = path.join(MUSIC_DIR, 'manifest.json');
fs.mkdirSync(MUSIC_DIR, { recursive: true });

// ---------- Comptes joueurs ----------
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

// Arènes publiques : une par niveau, chacune avec ses bots
const worlds = {};
for (const key in LEVELS) worlds[key] = new World({ level: key, botCount: BOT_COUNT });

// ---------- Rooms privées entre amis ----------
// Une room = une arène à part (niveau au choix, moins de bots) rejointe avec un code à 5 lettres.
// Elle disparaît quelques minutes après le départ du dernier joueur.
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS || '20', 10);
const ROOM_MAX_PLAYERS = 12;
const ROOM_BOTS = 4;
const ROOM_IDLE_MS = 3 * 60 * 1000;
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';     // sans 0/O ni 1/I
const rooms = {};       // code -> { code, level, created, emptySince }
const roomKey = (code) => 'room:' + code;

function newRoomCode() {
    for (;;) {
        let code = '';
        for (let i = 0; i < 5; i++) code += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
        if (!rooms[code]) return code;
    }
}
function normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 5); }
function roomPlayers(code) {
    let n = 0;
    for (const id in clients) if (clients[id].world === roomKey(code) && clients[id].playing) n++;
    return n;
}

// ---------- Photos de skin importées par les joueurs ----------
// Petites images carrées (redimensionnées par le navigateur), gardées en mémoire et servies par /photo/<id>.jpg
const photos = new Map();   // id -> { buf, type }
const MAX_PHOTOS = 400;
const PHOTO_MAX_BYTES = 40 * 1024;
function storePhoto(dataUrl) {
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) return null;
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > PHOTO_MAX_BYTES) return null;
    const id = crypto.createHash('sha1').update(buf).digest('hex').substring(0, 16);
    if (!photos.has(id)) {
        if (photos.size >= MAX_PHOTOS) photos.delete(photos.keys().next().value);
        photos.set(id, { buf, type: 'image/' + m[1] });
    }
    return id;
}
app.get('/photo/:file', (req, res) => {
    const m = /^([a-f0-9]{16})\.jpg$/.exec(req.params.file);
    const p = m && photos.get(m[1]);
    if (!p) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(p.type).send(p.buf);
});

// État réseau par socket : arène, taille de la vue (en unités monde), dernière position connue,
// et ce que le joueur connaît déjà de la nourriture (snapshots différentiels)
const clients = {};

function inWorld(key) {
    const out = [];
    for (const id in clients) if (clients[id].world === key) out.push(id);
    return out;
}

// Joueurs en ligne : total, par arène publique, et nombre de rooms ouvertes
let lastOnline = '';
function onlineStats() {
    const levels = {};
    for (const key in LEVELS) levels[key] = 0;
    let playing = 0;
    for (const id in clients) {
        const c = clients[id];
        if (!c.playing) continue;
        playing++;
        if (levels[c.world] !== undefined) levels[c.world]++;
    }
    return { total: Object.keys(clients).length, playing, levels, rooms: Object.keys(rooms).length };
}
function broadcastOnline(force) {
    const stats = onlineStats();
    const key = JSON.stringify(stats);
    if (!force && key === lastOnline) return;
    lastOnline = key;
    io.emit('online', stats);
}
app.get('/api/online', (req, res) => res.json(onlineStats()));

function leaveWorld(id) {
    const c = clients[id];
    if (!c || !c.world) return;
    if (worlds[c.world]) worlds[c.world].removeSnake(id);
    c.world = null;
    c.playing = false;
}

io.on('connection', (socket) => {
    const lobby = worlds.neon;
    clients[socket.id] = { world: null, view: { w: 1600, h: 1000 }, last: { x: lobby.size / 2, y: lobby.size / 2 }, playing: false, sync: null, chatAt: 0, name: '' };

    socket.emit('hello', { id: socket.id, arenaSize: lobby.size, tickRate: CONFIG.TICK_RATE });
    socket.emit('online', onlineStats());

    socket.on('createRoom', (data = {}, ack) => {
        if (typeof ack !== 'function') return;
        if (Object.keys(rooms).length >= MAX_ROOMS) return ack({ error: 'Trop de rooms ouvertes en ce moment, réessaie dans quelques minutes' });
        const level = typeof data.level === 'string' && LEVELS[data.level] ? data.level : 'neon';
        const code = newRoomCode();
        rooms[code] = { code, level, created: Date.now(), emptySince: Date.now() };
        worlds[roomKey(code)] = new World({ level, botCount: ROOM_BOTS });
        broadcastOnline();
        ack({ code, level });
    });

    socket.on('roomInfo', (data = {}, ack) => {
        if (typeof ack !== 'function') return;
        const r = rooms[normCode(data.code)];
        ack(r ? { code: r.code, level: r.level, players: roomPlayers(r.code) } : { error: 'Room introuvable : vérifie le code' });
    });

    socket.on('joinGame', (data = {}) => {
        const c = clients[socket.id];
        const name = typeof data.name === 'string' ? data.name.trim().substring(0, 14) : '';
        const skin = typeof data.skin === 'string' && SKINS[data.skin] ? data.skin : 'neon';
        let key = typeof data.level === 'string' && LEVELS[data.level] ? data.level : 'neon';
        let room = null;
        if (data.room) {
            room = rooms[normCode(data.room)];
            if (!room) return socket.emit('roomError', { error: 'Cette room n\'existe plus : crée-en une nouvelle' });
            if (c.world !== roomKey(room.code) && roomPlayers(room.code) >= ROOM_MAX_PLAYERS) return socket.emit('roomError', { error: 'Room pleine (12 joueurs)' });
            key = roomKey(room.code);
        }
        const account = accounts.verify(data.token);
        leaveWorld(socket.id);
        const world = worlds[key];
        const s = world.addSnake(socket.id, name || 'Serpent', skin, false);
        // Photo choisie par le joueur, sinon photo du compte X / Facebook
        const photoId = data.photoData ? storePhoto(data.photoData) : null;
        if (photoId) s.avatar = 'photo/' + photoId + '.jpg';
        else if (account && account.avatar && data.photo) s.avatar = account.avatar;
        Object.assign(c, {
            world: key, playing: true, last: { x: s.x, y: s.y }, email: account ? account.email : null,
            name: s.name, sync: { foods: new Map(), reset: true }
        });
        if (room) room.emptySince = 0;
        socket.emit('init', { id: socket.id, arenaSize: world.size, level: world.levelKey, room: room ? room.code : null, tickRate: CONFIG.TICK_RATE });
        broadcastOnline();
    });

    // Retour au menu : plus de snapshots pour ce joueur
    socket.on('leaveGame', () => { leaveWorld(socket.id); broadcastOnline(); });

    socket.on('input', (data = {}) => {
        const c = clients[socket.id];
        if (c && c.world && worlds[c.world]) worlds[c.world].setInput(socket.id, Number(data.a), !!data.b);
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

    // Messages éphémères : affichés quelques secondes au-dessus du serpent et dans le fil de l'arène
    socket.on('chat', (data = {}) => {
        const c = clients[socket.id];
        if (!c || !c.world) return;
        const now = Date.now();
        if (now - c.chatAt < 1200) return;            // anti-spam
        const text = String(data.text || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim().substring(0, 80);
        if (!text) return;
        c.chatAt = now;
        const msg = { id: socket.id, name: c.name || 'Serpent', text };
        for (const id of inWorld(c.world)) io.to(id).emit('chat', msg);
    });

    socket.on('ping_check', (ack) => { if (typeof ack === 'function') ack(); });

    socket.on('disconnect', () => {
        leaveWorld(socket.id);
        delete clients[socket.id];
        broadcastOnline();
    });
});

// Rooms vides : fermées après ROOM_IDLE_MS
setInterval(() => {
    const now = Date.now();
    for (const code in rooms) {
        const r = rooms[code];
        const n = inWorld(roomKey(code)).length;
        if (n) { r.emptySince = 0; continue; }
        if (!r.emptySince) r.emptySince = now;
        if (now - r.emptySince > ROOM_IDLE_MS) { delete rooms[code]; delete worlds[roomKey(code)]; }
    }
    broadcastOnline();
}, 3000);

// Boucle à pas fixe : si le serveur (CPU partagé) prend du retard, on rattrape les ticks manqués
// pour garder la même vitesse de jeu, puis on n'envoie qu'un seul snapshot.
// Les snapshots partent un tick sur SNAPSHOT_EVERY (2 = 15 par seconde) : le client interpole entre eux
// et le serveur fait deux fois moins de compression et d'envois, ce qui compte sur une petite instance.
const TICK_MS = 1000 / CONFIG.TICK_RATE;
const SNAPSHOT_EVERY = Math.max(1, parseInt(process.env.SNAPSHOT_EVERY, 10) || 2);
let nextTick = performance.now(), tickCount = 0;
function gameLoop() {
    const now = performance.now();
    let steps = 0, send = false;
    while (now >= nextTick && steps < 4) {
        stepWorlds();
        nextTick += TICK_MS; steps++;
        if (++tickCount % SNAPSHOT_EVERY === 0) send = true;
    }
    if (now - nextTick > 250) nextTick = now;             // trop de retard : on repart de maintenant
    if (send) sendSnapshots();
    setTimeout(gameLoop, Math.max(1, nextTick - performance.now()));
}

function stepWorlds() {
    // Seules les arènes où quelqu'un joue sont simulées : sur un petit serveur, ça divise le travail
    const active = new Set();
    for (const id in clients) if (clients[id].world) active.add(clients[id].world);

    for (const key of active) {
        const world = worlds[key];
        if (!world) continue;
        world.step();

        for (const ev of world.drainEvents()) {
            // Événements fous et chute de l'Hydre : annoncés à toute l'arène
            if (ev.type === 'world' || ev.type === 'worldEnd' || ev.type === 'bossDown') {
                for (const id of inWorld(key)) io.to(id).emit('fx', ev);
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
}

function sendSnapshots() {
    for (const id in clients) {
        const c = clients[id];
        const world = c.world && worlds[c.world];
        if (!world) continue;
        // Connexion saturée : on saute ce snapshot plutôt que d'empiler du retard
        // (le différentiel de nourriture reste juste puisqu'il n'est mis à jour qu'à l'envoi)
        const sock = io.sockets.sockets.get(id);
        const transport = sock && sock.conn && sock.conn.transport;
        if (!transport || !transport.writable) continue;
        const me = world.snakes[id];
        if (me) c.last = { x: me.x, y: me.y };
        c.sent = (c.sent || 0) + 1;
        const snap = world.snapshotFor(id, { x: c.last.x, y: c.last.y, w: c.view.w, h: c.view.h }, c.sent % 8 === 1, c.sync);
        sock.emit('state', snap);
    }
}
gameLoop();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🐍 Mich Snake lancé sur http://localhost:${PORT}`);
});
