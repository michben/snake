/*
 * Mich Snake — client
 * Rendu Canvas interpolé, minimap radar, contrôles souris / tactiles,
 * Tour des Défis et bascule automatique en mode hors-ligne.
 */
(function () {
    'use strict';

    const Core = window.SnakeCore;
    const Tower = window.Tower;
    const store = window.SnakeStore;
    const SKINS = Core.SKINS;
    const TICK_MS = 1000 / Core.CONFIG.TICK_RATE;
    const INTERP_DELAY = TICK_MS * 2.5;   // on rend ~2,5 ticks dans le passé pour toujours avoir 2 snapshots
    const OFFLINE_ID = 'me';

    const $ = (id) => document.getElementById(id);
    const canvas = $('gameCanvas');
    const ctx = canvas.getContext('2d');
    const mini = $('minimap');
    const mctx = mini.getContext('2d');

    // Mode tactile : écran tactile sans pointeur précis, ou dès le premier toucher (ex. PC hybride)
    let isTouch = false, lastTouchAt = 0;
    function setTouchMode() {
        if (isTouch) return;
        isTouch = true;
        document.body.classList.add('touch');
        $('helpText').textContent = '🕹️ Glissez n\'importe où pour diriger · Bouton ⚡ pour booster';
        if (!$('hud').classList.contains('hidden')) $('touchControls').classList.remove('hidden');
        setTimeout(resize, 0);
    }
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) setTouchMode();

    // ---------- État global ----------
    const state = {
        mode: null,            // 'online' | 'offline' | null
        playing: false,
        myId: null,
        arenaSize: Core.CONFIG.ARENA_SIZE,
        snaps: [],             // tampon de snapshots { time, data }
        clockOffset: null,
        lastMe: null,
        density: null,
        lb: [],
        playerCount: 0,
        angle: 0,
        boosting: false,
        camera: { x: Core.CONFIG.ARENA_SIZE / 2, y: Core.CONFIG.ARENA_SIZE / 2, zoom: 1 },
        dpr: 1,
        ping: 0,
        fps: 0
    };

    const prefs = {
        name: store.get('snake_name', ''),
        skin: store.get('snake_skin', 'neon')
    };
    const records = {
        best: parseInt(store.get('snake_best_score', '0'), 10) || 0,
        kills: parseInt(store.get('snake_total_kills', '0'), 10) || 0,
        games: parseInt(store.get('snake_games', '0'), 10) || 0
    };
    if (!Tower.isUnlocked(prefs.skin)) prefs.skin = 'neon';

    // ---------- Réseau ----------
    const net = { socket: null, connected: false };

    function setNetStatus(kind, text) {
        $('netDot').className = 'dot ' + kind;
        $('netStatus').textContent = text;
        $('playBtn').textContent = net.connected ? 'Jouer en ligne' : 'Jouer hors-ligne';
        $('offlineBtn').classList.toggle('hidden', !net.connected);
    }

    window.__ioLoaded.then((ok) => {
        if (!ok || typeof window.io !== 'function') {
            setNetStatus('off', 'Serveur indisponible — mode hors-ligne avec bots');
            return;
        }
        const socket = window.io({ reconnectionDelayMax: 5000, timeout: 4000 });
        net.socket = socket;
        const offlineTimer = setTimeout(() => {
            if (!net.connected) setNetStatus('off', 'Serveur injoignable — mode hors-ligne avec bots');
        }, 3500);

        socket.on('connect', () => {
            clearTimeout(offlineTimer);
            net.connected = true;
            setNetStatus('on', 'Serveur connecté');
        });
        socket.on('disconnect', () => {
            net.connected = false;
            setNetStatus('off', 'Connexion perdue — mode hors-ligne disponible');
            if (state.mode === 'online' && state.playing) {
                toast('📡 Connexion perdue — bascule en mode hors-ligne', 'info');
                startGame('offline');
            }
        });
        socket.on('init', (d) => {
            state.myId = d.id;
            state.arenaSize = d.arenaSize;
        });
        socket.on('state', (snap) => { if (state.mode === 'online') receiveSnapshot(snap); });
        socket.on('died', (ev) => { if (state.mode === 'online') onDeath(ev); });
        socket.on('kill', (ev) => { if (state.mode === 'online') onKill(ev); });

        setInterval(() => {
            if (!net.connected) return;
            const t0 = performance.now();
            socket.timeout(2000).emit('ping_check', () => { state.ping = Math.round(performance.now() - t0); });
        }, 2000);
    });

    // ---------- Mode hors-ligne : même moteur que le serveur, dans le navigateur ----------
    const offline = { world: null, timer: null };

    function startOfflineWorld() {
        stopOfflineWorld();
        if (!offline.world) offline.world = new Core.World({ botCount: 12 });
        const w = offline.world;
        w.removeSnake(OFFLINE_ID);
        w.addSnake(OFFLINE_ID, prefs.name || 'Serpent', prefs.skin, false);
        state.myId = OFFLINE_ID;
        state.arenaSize = w.size;
        offline.timer = setInterval(() => {
            w.setInput(OFFLINE_ID, state.angle, state.boosting);
            w.step();
            let myDeath = null;
            for (const ev of w.drainEvents()) {
                if (ev.id === OFFLINE_ID) myDeath = ev;
                if (ev.killerId === OFFLINE_ID) onKill({ victim: ev.name });
            }
            const me = w.snakes[OFFLINE_ID];
            const at = me ? me : state.camera;
            receiveSnapshot(w.snapshotFor(OFFLINE_ID, { x: at.x, y: at.y, w: viewW(), h: viewH() }, w.tick % 15 === 0));
            if (myDeath) onDeath(myDeath);
        }, TICK_MS);
    }
    function stopOfflineWorld() {
        if (offline.timer) clearInterval(offline.timer);
        offline.timer = null;
    }

    // ---------- Partie ----------
    function startGame(mode) {
        prefs.name = $('playerName').value.trim().substring(0, 14);
        store.set('snake_name', prefs.name);
        state.snaps = [];
        state.clockOffset = null;
        state.lastMe = null;
        state.mode = mode;
        state.playing = true;
        Tower.startRun(null);

        if (mode === 'online') {
            stopOfflineWorld();
            net.socket.emit('joinGame', { name: prefs.name || 'Serpent', skin: prefs.skin });
            sendView(true);
        } else {
            startOfflineWorld();
        }
        showScreen('hud');
        updateMissionHud(null);
    }

    function onDeath(ev) {
        state.playing = false;
        records.games++;
        records.kills += ev.kills || 0;
        const isRecord = ev.score > records.best;
        if (isRecord) records.best = ev.score;
        store.set('snake_best_score', records.best);
        store.set('snake_total_kills', records.kills);
        store.set('snake_games', records.games);

        $('dScore').textContent = ev.score;
        $('dKills').textContent = ev.kills;
        $('dOrbs').textContent = ev.orbs;
        $('dTime').textContent = formatTime(ev.aliveSeconds);
        $('dRecord').classList.toggle('hidden', !isRecord);
        $('deathSub').textContent = ev.killerName ? `Éliminé par ${ev.killerName}` : 'Vous avez percuté la bordure de l\'arène';
        setTimeout(() => { if (!state.playing) showScreen('death'); }, 900);
    }

    function onKill(ev) {
        toast(`⚔️ Vous avez éliminé ${ev.victim} !`, 'kill');
    }

    Tower.onComplete = (floor, reward) => {
        toast(`🗼 Étage ${floor} réussi !`, 'gold');
        if (reward) setTimeout(() => toast(`✨ Skin débloqué : ${SKINS[reward].emoji} ${SKINS[reward].name}`, 'gold'), 700);
        buildSkinSelector();
        updateTowerUI();
    };

    // ---------- Snapshots & interpolation ----------
    function receiveSnapshot(snap) {
        const now = performance.now();
        // Horloge lissée : temps local estimé du tick serveur, robuste au jitter réseau
        const offset = now - snap.t * TICK_MS;
        if (state.clockOffset === null || Math.abs(offset - state.clockOffset) > 500) state.clockOffset = offset;
        else state.clockOffset += (offset - state.clockOffset) * (offset < state.clockOffset ? 0.2 : 0.02);

        state.snaps.push({ time: snap.t * TICK_MS, data: snap });
        if (state.snaps.length > 30) state.snaps.shift();

        if (snap.d) state.density = snap.d;
        state.lb = snap.lb;
        state.playerCount = snap.n;
        if (snap.me) {
            state.lastMe = snap.me;
            onStats(snap.me, now);
        }
    }

    let lastStatsUi = 0;
    function onStats(me, now) {
        const p = Tower.update(me, now);
        if (now - lastStatsUi < 120) return;
        lastStatsUi = now;
        $('currentScore').textContent = me.score;
        $('currentKills').textContent = me.kills;
        $('currentRank').textContent = '#' + me.rank;
        updateMissionHud(p);
        updateLeaderboard();
    }

    function lerp(a, b, t) { return a + (b - a) * t; }

    function indexBy(list, key) {
        const m = new Map();
        for (const it of list) m.set(key(it), it);
        return m;
    }

    // Construit l'état interpolé à afficher à l'instant `renderTime`
    function interpolatedFrame(now) {
        const snaps = state.snaps;
        if (!snaps.length) return null;
        const renderTime = now - state.clockOffset - INTERP_DELAY;

        let a = snaps[0], b = snaps[0];
        for (let i = snaps.length - 1; i >= 0; i--) {
            if (snaps[i].time <= renderTime) { a = snaps[i]; b = snaps[i + 1] || snaps[i]; break; }
        }
        if (renderTime < snaps[0].time) { a = b = snaps[0]; }
        const span = b.time - a.time;
        const t = span > 0 ? Core.clamp((renderTime - a.time) / span, 0, 1) : 0;
        if (a === b) return { snakes: b.data.s, foods: b.data.f };

        if (!a.snakeMap) a.snakeMap = indexBy(a.data.s, s => s.id);
        if (!a.foodMap) a.foodMap = indexBy(a.data.f, f => f[0]);

        const snakes = b.data.s.map((sb) => {
            const sa = a.snakeMap.get(sb.id);
            if (!sa) return sb;
            const ga = sa.g, gb = sb.g;
            const n = gb.length, na = ga.length;
            const g = new Array(n);
            for (let i = 0; i < n; i++) g[i] = i < na ? lerp(ga[i], gb[i], t) : gb[i];
            return {
                id: sb.id, n: sb.n, k: sb.k, b: sb.b, sc: sb.sc,
                r: lerp(sa.r, sb.r, t),
                a: sa.a + Core.angleDiff(sa.a, sb.a) * t,
                g
            };
        });
        const foods = b.data.f.map((fb) => {
            const fa = a.foodMap.get(fb[0]);
            if (!fa || (fa[1] === fb[1] && fa[2] === fb[2])) return fb;
            return [fb[0], lerp(fa[1], fb[1], t), lerp(fa[2], fb[2], t), fb[3], fb[4]];
        });
        return { snakes, foods };
    }

    // ---------- Entrées ----------
    function viewW() { return canvas.width / state.dpr / state.camera.zoom; }
    function viewH() { return canvas.height / state.dpr / state.camera.zoom; }

    let lastView = { w: 0, h: 0 }, lastViewSent = 0;
    function sendView(force) {
        if (state.mode !== 'online' || !net.socket) return;
        const w = Math.round(viewW()), h = Math.round(viewH());
        const now = performance.now();
        if (!force && (Math.abs(w - lastView.w) < 40 && Math.abs(h - lastView.h) < 40 || now - lastViewSent < 500)) return;
        lastView = { w, h }; lastViewSent = now;
        net.socket.emit('view', { w, h });
    }

    let lastInput = { a: 0, b: false, at: 0 };
    setInterval(() => {
        if (state.mode !== 'online' || !state.playing || !net.connected) return;
        const now = performance.now();
        if (Math.abs(state.angle - lastInput.a) > 0.01 || state.boosting !== lastInput.b || now - lastInput.at > 250) {
            net.socket.emit('input', { a: Math.round(state.angle * 1000) / 1000, b: state.boosting });
            lastInput = { a: state.angle, b: state.boosting, at: now };
        }
    }, TICK_MS);

    // Souris / clavier
    window.addEventListener('mousemove', (e) => {
        if (performance.now() - lastTouchAt < 800) return;
        state.angle = Math.atan2(e.clientY - window.innerHeight / 2, e.clientX - window.innerWidth / 2);
    });
    canvas.addEventListener('mousedown', () => { state.boosting = true; });
    window.addEventListener('mouseup', () => { state.boosting = false; });
    window.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && state.playing) { state.boosting = true; e.preventDefault(); }
        if (e.code === 'Enter' && !state.playing) {
            if (!$('menu').classList.contains('hidden')) $('playBtn').click();
            else if (!$('deathScreen').classList.contains('hidden')) $('replayBtn').click();
        }
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') state.boosting = false; });
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    // Joystick virtuel dynamique + bouton boost
    const joy = { id: null, ox: 0, oy: 0 };
    const joyBase = $('joyBase'), joyKnob = $('joyKnob'), boostBtn = $('boostBtn');
    const JOY_R = 50;

    function onTouchStart(e) {
        lastTouchAt = performance.now();
        setTouchMode();
        if (!state.playing) return;
        for (const t of e.changedTouches) {
            if (t.target === boostBtn || boostBtn.contains(t.target)) continue;
            if (joy.id === null) {
                joy.id = t.identifier; joy.ox = t.clientX; joy.oy = t.clientY;
                joyBase.style.left = t.clientX + 'px';
                joyBase.style.top = t.clientY + 'px';
                joyBase.style.display = 'block';
                joyKnob.style.transform = 'translate(0,0)';
                $('joyHint').style.display = 'none';
            }
        }
        e.preventDefault();
    }
    function onTouchMove(e) {
        lastTouchAt = performance.now();
        for (const t of e.changedTouches) {
            if (t.identifier !== joy.id) continue;
            const dx = t.clientX - joy.ox, dy = t.clientY - joy.oy;
            const d = Math.hypot(dx, dy);
            if (d > 6) state.angle = Math.atan2(dy, dx);
            const k = d > JOY_R ? JOY_R / d : 1;
            joyKnob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
        }
        e.preventDefault();
    }
    function onTouchEnd(e) {
        for (const t of e.changedTouches) {
            if (t.identifier === joy.id) { joy.id = null; joyBase.style.display = 'none'; }
        }
    }
    document.addEventListener('touchstart', onTouchStart, { passive: false });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
    document.addEventListener('touchcancel', onTouchEnd);

    const boostOn = (e) => { state.boosting = true; boostBtn.classList.add('active'); e.preventDefault(); e.stopPropagation(); };
    const boostOff = (e) => { state.boosting = false; boostBtn.classList.remove('active'); if (e) e.preventDefault(); };
    boostBtn.addEventListener('touchstart', boostOn, { passive: false });
    boostBtn.addEventListener('touchend', boostOff);
    boostBtn.addEventListener('touchcancel', boostOff);

    // ---------- UI : menu, skins, tour ----------
    function showScreen(which) {
        $('menu').classList.toggle('hidden', which !== 'menu');
        $('deathScreen').classList.toggle('hidden', which !== 'death');
        $('hud').classList.toggle('hidden', which !== 'hud');
        $('touchControls').classList.toggle('hidden', !(which === 'hud' && isTouch));
        if (which !== 'hud') { state.boosting = false; boostOff(); joy.id = null; joyBase.style.display = 'none'; }
        if (which === 'menu') { updateTowerUI(); updateRecords(); }
    }

    function buildSkinSelector() {
        const el = $('skinSelector');
        el.innerHTML = '';
        let unlocked = 0;
        const keys = Object.keys(SKINS);
        for (const key of keys) {
            const s = SKINS[key];
            const ok = Tower.isUnlocked(key);
            if (ok) unlocked++;
            const b = document.createElement('div');
            b.className = 'skin-btn' + (ok ? '' : ' locked') + (key === prefs.skin ? ' active' : '');
            b.textContent = s.emoji;
            b.style.setProperty('--glow', s.color);
            b.title = ok ? s.name : `${s.name} — débloqué à l'étage ${s.unlock}`;
            b.addEventListener('click', () => {
                if (!ok) { $('skinName').textContent = `🔒 ${s.name} : atteignez l'étage ${s.unlock} de la Tour des Défis`; return; }
                prefs.skin = key;
                store.set('snake_skin', key);
                buildSkinSelector();
            });
            el.appendChild(b);
        }
        $('skinCount').textContent = `${unlocked}/${keys.length} débloqués`;
        $('skinName').textContent = `${SKINS[prefs.skin].emoji} ${SKINS[prefs.skin].name}`;
    }

    function updateTowerUI() {
        $('towerFloor').textContent = `Étage ${Tower.floor}`;
        $('towerGoal').textContent = 'Objectif : ' + Tower.describe();
        const m = Tower.mission;
        const pct = m.type === 'score' ? Math.min(1, records.best / m.target) : 0;
        $('towerProgress').style.width = Math.floor(pct * 100) + '%';
        $('towerReward').innerHTML = Tower.nextRewardText();
    }

    function updateMissionHud(p) {
        $('mhTitle').textContent = `🗼 Étage ${Tower.floor}`;
        $('mhGoal').textContent = Tower.describe();
        $('mhProgress').style.width = Math.floor(Core.clamp(p ? p.pct : 0, 0, 1) * 100) + '%';
        $('mhVal').textContent = p ? p.label : '';
    }

    function updateRecords() {
        $('bestScore').textContent = records.best;
        $('totalKills').textContent = records.kills;
        $('gamesPlayed').textContent = records.games;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function updateLeaderboard() {
        const max = isTouch ? 5 : 10;
        const rows = state.lb.slice(0, max).map((e, i) => {
            const [id, name, score] = e;
            return `<div class="lb-item ${id === state.myId ? 'me' : ''}"><span class="nm">${i === 0 ? '👑' : '#' + (i + 1)} ${escapeHtml(name)}</span><span>${score}</span></div>`;
        });
        const me = state.lastMe;
        if (me && me.rank > max) {
            rows.push(`<div class="lb-item me"><span class="nm">#${me.rank} ${escapeHtml(prefs.name || 'Serpent')}</span><span>${me.score}</span></div>`);
        }
        $('lbList').innerHTML = rows.join('');
        $('playerCount').textContent = `${state.playerCount} en jeu`;
    }

    const toastsEl = $('toasts');
    function toast(text, kind = 'info') {
        const t = document.createElement('div');
        t.className = 'toast ' + kind;
        t.textContent = text;
        toastsEl.appendChild(t);
        setTimeout(() => t.remove(), 3100);
        while (toastsEl.children.length > 4) toastsEl.firstChild.remove();
    }

    function formatTime(s) {
        const m = Math.floor(s / 60), r = s % 60;
        return m ? `${m}m${String(r).padStart(2, '0')}` : `${r}s`;
    }

    $('playerName').value = prefs.name;
    $('playBtn').addEventListener('click', () => startGame(net.connected ? 'online' : 'offline'));
    $('offlineBtn').addEventListener('click', () => startGame('offline'));
    $('replayBtn').addEventListener('click', () => startGame(state.mode === 'online' && net.connected ? 'online' : 'offline'));
    $('menuBtn').addEventListener('click', () => { stopOfflineWorld(); state.mode = null; showScreen('menu'); });

    // ---------- Rendu ----------
    function resize() {
        state.dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(window.innerWidth * state.dpr);
        canvas.height = Math.floor(window.innerHeight * state.dpr);
        canvas.style.width = window.innerWidth + 'px';
        canvas.style.height = window.innerHeight + 'px';
        const r = mini.getBoundingClientRect();
        mini.width = Math.max(1, Math.floor((r.width || 170) * state.dpr));
        mini.height = Math.max(1, Math.floor((r.height || 170) * state.dpr));
        sendView(true);
    }
    window.addEventListener('resize', resize);
    resize();

    // Sprites de lueur pré-rendus (shadowBlur est trop coûteux pour des centaines d'orbes)
    const glowCache = new Map();
    function glowSprite(color, radius) {
        const key = color + '|' + radius;
        let c = glowCache.get(key);
        if (c) return c;
        const size = Math.ceil(radius * 5);
        c = document.createElement('canvas');
        c.width = c.height = size;
        const g = c.getContext('2d');
        const cx = size / 2;
        const grad = g.createRadialGradient(cx, cx, 0, cx, cx, cx);
        grad.addColorStop(0, color);
        grad.addColorStop(0.3, color);
        grad.addColorStop(0.32, hexA(color, 0.45));
        grad.addColorStop(1, hexA(color, 0));
        g.fillStyle = grad;
        g.fillRect(0, 0, size, size);
        g.fillStyle = 'rgba(255,255,255,0.55)';
        g.beginPath(); g.arc(cx - radius * 0.3, cx - radius * 0.3, radius * 0.35, 0, Math.PI * 2); g.fill();
        glowCache.set(key, c);
        return c;
    }

    function hexToRgb(hex) {
        const n = parseInt(hex.slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    function hexA(hex, a) { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }
    function mix(h1, h2, t) {
        const a = hexToRgb(h1), b = hexToRgb(h2);
        return `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(lerp(a[1], b[1], t))},${Math.round(lerp(a[2], b[2], t))})`;
    }

    // Sprites emoji pré-rendus : fillText d'un emoji à chaque segment serait bien trop lent
    const emojiCache = new Map();
    function emojiSprite(emoji, px) {
        px = Math.max(8, Math.ceil(px / 4) * 4);
        const key = emoji + '|' + px;
        let c = emojiCache.get(key);
        if (c) return c;
        c = document.createElement('canvas');
        c.width = c.height = Math.ceil(px * 1.25);
        const g = c.getContext('2d');
        g.font = `${px}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(emoji, c.width / 2, c.height / 2 + px * 0.06);
        emojiCache.set(key, c);
        return c;
    }

    function drawGrid(x0, y0, x1, y1) {
        const size = state.arenaSize;
        // Hors arène : zone sombre
        ctx.fillStyle = '#05070b';
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.fillStyle = '#0d1119';
        ctx.fillRect(0, 0, size, size);

        const grid = 80;
        ctx.strokeStyle = '#171e2e';
        ctx.lineWidth = 2;
        ctx.beginPath();
        const gx0 = Math.max(0, Math.floor(x0 / grid) * grid), gx1 = Math.min(size, x1);
        const gy0 = Math.max(0, Math.floor(y0 / grid) * grid), gy1 = Math.min(size, y1);
        for (let x = gx0; x <= gx1; x += grid) { ctx.moveTo(x, Math.max(0, y0)); ctx.lineTo(x, Math.min(size, y1)); }
        for (let y = gy0; y <= gy1; y += grid) { ctx.moveTo(Math.max(0, x0), y); ctx.lineTo(Math.min(size, x1), y); }
        ctx.stroke();

        ctx.strokeStyle = '#ff0044';
        ctx.lineWidth = 10;
        ctx.shadowColor = '#ff0044';
        ctx.shadowBlur = 20;
        ctx.strokeRect(0, 0, size, size);
        ctx.shadowBlur = 0;
    }

    function drawSnake(p, time, x0, y0, x1, y1, isLeader) {
        const skin = SKINS[p.k] || SKINS.neon;
        const g = p.g, n = g.length / 2, r = p.r;

        // Corps coloré : un seul trait épais (bien moins cher qu'un shadowBlur par segment)
        ctx.save();
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(g[0], g[1]);
        for (let i = 1; i < n; i++) ctx.lineTo(g[i * 2], g[i * 2 + 1]);
        if (p.b) {
            ctx.globalAlpha = 0.35;
            ctx.strokeStyle = skin.color;
            ctx.lineWidth = r * 2 + 16;
            ctx.stroke();
        }
        ctx.globalAlpha = 0.28;
        ctx.strokeStyle = skin.color;
        ctx.lineWidth = r * 1.6;
        ctx.stroke();
        ctx.restore();

        // Emojis le long du corps (un segment sur deux), de la queue vers la tête
        const scale = state.camera.zoom * state.dpr;
        const bodySize = r * 1.9;
        const bodySpr = emojiSprite(skin.emoji, bodySize * scale);
        const bs = bodySize * 1.25;
        for (let i = n - 1; i >= 2; i--) {
            if (i % 2) continue;
            const x = g[i * 2], y = g[i * 2 + 1];
            if (x + r < x0 || x - r > x1 || y + r < y0 || y - r > y1) continue;
            ctx.drawImage(bodySpr, x - bs / 2, y - bs / 2, bs, bs);
        }

        // Tête : l'emoji en plus grand
        const hx = g[0], hy = g[1];
        const headSize = r * 2.7;
        const hs = headSize * 1.25;
        ctx.drawImage(emojiSprite(skin.emoji, headSize * scale), hx - hs / 2, hy - hs / 2, hs, hs);

        ctx.textAlign = 'center';
        ctx.font = `bold ${13 / Math.max(0.7, state.camera.zoom)}px sans-serif`;
        ctx.fillStyle = p.id === state.myId ? '#ffcc00' : 'rgba(255,255,255,0.9)';
        ctx.fillText(p.n, hx, hy - r * 1.4 - 8);
        if (isLeader) {
            ctx.font = `${20 / Math.max(0.7, state.camera.zoom)}px sans-serif`;
            ctx.fillText('👑', hx, hy - r * 1.4 - 26);
        }
    }

    function drawMinimap(frame) {
        const W = mini.width, H = mini.height;
        const size = state.arenaSize;
        const sx = W / size, sy = H / size;
        mctx.clearRect(0, 0, W, H);
        mctx.fillStyle = 'rgba(8, 12, 20, 0.6)';
        mctx.fillRect(0, 0, W, H);

        // Zones denses en nourriture
        if (state.density) {
            const n = Core.CONFIG.DENSITY_GRID;
            const cw = W / n, ch = H / n;
            for (let i = 0; i < state.density.length; i++) {
                const v = state.density[i];
                if (v < 40) continue;
                mctx.fillStyle = `rgba(0, 255, 204, ${(v / 255) * 0.45})`;
                mctx.fillRect((i % n) * cw, Math.floor(i / n) * ch, cw + 0.5, ch + 0.5);
            }
        }

        mctx.strokeStyle = 'rgba(255, 0, 68, 0.6)';
        mctx.lineWidth = 1.5 * state.dpr;
        mctx.strokeRect(1, 1, W - 2, H - 2);

        // Champ de vision
        const cam = state.camera;
        mctx.strokeStyle = 'rgba(255,255,255,0.25)';
        mctx.lineWidth = 1 * state.dpr;
        mctx.strokeRect((cam.x - viewW() / 2) * sx, (cam.y - viewH() / 2) * sy, viewW() * sx, viewH() * sy);

        // Top joueurs (positions issues du classement global)
        const d = state.dpr;
        state.lb.forEach((e, i) => {
            const [id, , , x, y] = e;
            if (id === state.myId) return;
            mctx.beginPath();
            mctx.fillStyle = i === 0 ? '#ffd700' : 'rgba(255, 80, 120, 0.85)';
            mctx.arc(x * sx, y * sy, (i === 0 ? 3.5 : 2.2) * d, 0, Math.PI * 2);
            mctx.fill();
            if (i === 0) {
                mctx.font = `${12 * d}px sans-serif`;
                mctx.textAlign = 'center';
                mctx.fillText('👑', x * sx, y * sy - 5 * d);
            }
        });

        // Moi
        const meSnake = frame && frame.snakes.find(s => s.id === state.myId);
        if (meSnake) {
            const mx = meSnake.g[0] * sx, my = meSnake.g[1] * sy;
            mctx.save();
            mctx.translate(mx, my);
            mctx.rotate(meSnake.a);
            mctx.fillStyle = '#ffffff';
            mctx.shadowColor = '#00ffcc'; mctx.shadowBlur = 8 * d;
            mctx.beginPath();
            mctx.moveTo(6 * d, 0); mctx.lineTo(-4 * d, -4 * d); mctx.lineTo(-2 * d, 0); mctx.lineTo(-4 * d, 4 * d);
            mctx.closePath(); mctx.fill();
            mctx.restore();
            if (state.lb[0] && state.lb[0][0] === state.myId) {
                mctx.font = `${12 * d}px sans-serif`; mctx.textAlign = 'center';
                mctx.fillText('👑', mx, my - 6 * d);
            }
        }
    }

    let fpsFrames = 0, fpsLast = performance.now(), miniFrame = 0;
    function render(now) {
        requestAnimationFrame(render);
        fpsFrames++;
        if (now - fpsLast > 1000) {
            state.fps = fpsFrames; fpsFrames = 0; fpsLast = now;
            $('netInfo').textContent = state.mode === 'online'
                ? `🌐 En ligne · ${state.ping} ms · ${state.fps} FPS`
                : state.mode === 'offline' ? `🤖 Hors-ligne · ${state.fps} FPS` : '';
        }

        const W = canvas.width, H = canvas.height, dpr = state.dpr;
        const frame = state.mode ? interpolatedFrame(now) : null;
        const me = frame && frame.snakes.find(s => s.id === state.myId);
        const cam = state.camera;

        if (me) {
            cam.x = me.g[0]; cam.y = me.g[1];
            // Dézoom progressif quand le serpent grossit, adapté à la taille d'écran
            const base = Core.clamp(Math.max(window.innerWidth, window.innerHeight) / 1500, 0.6, 1.15);
            const targetZoom = base * Core.clamp(1.1 - (me.r - 13) * 0.025, 0.6, 1.1);
            cam.zoom += (targetZoom - cam.zoom) * 0.05;
            sendView(false);
        } else if (!state.mode) {
            // Menu : lent panoramique sur l'arène de démo
            cam.x = state.arenaSize / 2 + Math.cos(now / 9000) * 900;
            cam.y = state.arenaSize / 2 + Math.sin(now / 7000) * 900;
        }

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const z = cam.zoom * dpr;
        ctx.setTransform(z, 0, 0, z, W / 2 - cam.x * z, H / 2 - cam.y * z);
        const vw = W / z, vh = H / z;
        const x0 = cam.x - vw / 2, x1 = cam.x + vw / 2, y0 = cam.y - vh / 2, y1 = cam.y + vh / 2;

        drawGrid(x0, y0, x1, y1);

        if (frame) {
            for (const f of frame.foods) {
                const [, fx, fy, fr, fc] = f;
                if (fx < x0 - 20 || fx > x1 + 20 || fy < y0 - 20 || fy > y1 + 20) continue;
                const spr = glowSprite(fc, fr);
                const pulse = 1 + Math.sin(now * 0.004 + f[0]) * 0.08;
                const s = spr.width * pulse;
                ctx.drawImage(spr, fx - s / 2, fy - s / 2, s, s);
            }
            const leaderId = state.lb[0] && state.lb[0][0];
            // Mon serpent dessiné en dernier, par-dessus les autres
            const ordered = frame.snakes.slice().sort((a, b) => (a.id === state.myId) - (b.id === state.myId));
            for (const s of ordered) drawSnake(s, now, x0, y0, x1, y1, s.id === leaderId);
        }

        if (state.mode && ++miniFrame % 4 === 0) drawMinimap(frame);
    }

    // ---------- Démarrage ----------
    buildSkinSelector();
    updateTowerUI();
    updateRecords();
    showScreen('menu');
    requestAnimationFrame(render);

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
        navigator.serviceWorker.register('sw.js').catch(() => { /* PWA optionnelle */ });
    }
    console.log('%c🐍 Mich Snake — by michben', 'color:#ffd700;font-weight:bold;font-size:14px');
})();
