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
    const Sound = window.SnakeAudio;
    const FX = window.SnakeFX;
    const Account = window.SnakeAccount;
    const Quests = window.SnakeQuests;
    const SKINS = Core.SKINS;
    const WORLD_EVENTS = Core.WORLD_EVENTS;
    const POWERUPS = Core.POWERUPS;
    const LEVELS = Core.LEVELS;
    const TICK_MS = 1000 / Core.CONFIG.TICK_RATE;
    // On rend un peu dans le passé pour toujours avoir 2 snapshots entre lesquels interpoler.
    // Le délai s'adapte : écart entre snapshots + pire retard récent (réseau mobile, serveur qui hoquette)
    const jitter = { gap: TICK_MS * 2, late: 0, last: 0 };
    let interpDelay = TICK_MS * 2.5;
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
        // Sur mobile, minimap + stats + mission forment une colonne réductible en haut à gauche
        $('hudLeft').prepend($('minimapWrap'), $('stats'));
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
        chests: [],            // positions des coffres pour la minimap [x, y, légendaire]
        volcanoes: [],         // éruptions annoncées (minimap)
        seenEruptions: new Set(),
        level: 'neon',
        lastOrbs: 0,
        worldEvent: null,      // [kind, secondes restantes] de l'événement fou en cours
        lb: [],
        playerCount: 0,
        humanCount: 0,
        online: null,          // joueurs en ligne { total, playing, levels, rooms }
        room: null,            // room privée choisie { code, level }
        bubbles: new Map(),    // messages éphémères au-dessus des serpents : id -> { text, until }
        angle: 0,
        boosting: false,
        camera: { x: Core.CONFIG.ARENA_SIZE / 2, y: Core.CONFIG.ARENA_SIZE / 2, zoom: 1 },
        dpr: 1,
        ping: 0,
        fps: 0
    };

    const prefs = {
        name: store.get('snake_name', ''),
        skin: store.get('snake_skin', 'neon'),
        level: store.get('snake_level', 'neon'),
        // Photo à la place de l'emoji : '' (aucune), 'account' (photo du compte) ou 'custom' (photo importée)
        photo: ({ '1': 'account', account: 'account', custom: 'custom' })[store.get('snake_photo', '0')] || ''
    };
    let customPhoto = store.get('snake_custom_photo', '') || '';
    const levelUnlocked = (key) => !LEVELS[key].unlock || Tower.floor >= LEVELS[key].unlock;
    if (!LEVELS[prefs.level] || !levelUnlocked(prefs.level)) prefs.level = 'neon';
    const records = {
        best: parseInt(store.get('snake_best_score', '0'), 10) || 0,
        kills: parseInt(store.get('snake_total_kills', '0'), 10) || 0,
        games: parseInt(store.get('snake_games', '0'), 10) || 0
    };
    if (!Tower.isUnlocked(prefs.skin)) prefs.skin = 'neon';

    // ---------- Réseau ----------
    const net = { socket: null, connected: false };
    window.SnakeNet = net;

    function setNetStatus(kind, text) {
        $('netDot').className = 'dot ' + kind;
        $('netStatus').textContent = text;
        $('offlineBtn').classList.toggle('hidden', !net.connected);
        updatePlayButton();
        updateOnlineUI();
    }

    function updatePlayButton() {
        $('playBtn').textContent = !net.connected ? 'Jouer hors-ligne' : state.room ? `Jouer dans la room ${state.room.code}` : 'Jouer en ligne';
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
            loadServerMusic();
            Account.connected();
            // Lien d'invitation : ?room=CODE
            const code = new URLSearchParams(location.search).get('room');
            if (code && !state.room) joinRoom(code);
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
            if (d.level) state.level = d.level;
        });
        socket.on('online', (d) => { state.online = d; updateOnlineUI(); });
        socket.on('roomError', (d) => {
            toast('👥 ' + d.error, 'kill');
            setRoom(null);
            if (state.mode === 'online') { state.mode = null; state.playing = false; showScreen('menu'); }
        });
        socket.on('chat', onChat);
        // Décodé même hors partie : le différentiel de nourriture doit rester à jour
        socket.on('state', (snap) => { decodeSnapshot(snap); if (state.mode === 'online') receiveSnapshot(snap); });
        socket.on('died', (ev) => {
            if (ev.account) Account.updateUser(ev.account);
            if (state.mode === 'online') onDeath(ev);
        });
        socket.on('kill', (ev) => { if (state.mode === 'online') onKill(ev); });
        socket.on('fx', (ev) => { if (state.mode === 'online') onFx(ev); });
        // La console admin a changé une musique : on recharge chez tout le monde
        socket.on('music', (manifest) => Sound.setServerTracks(manifest, ''));

        setInterval(() => {
            if (!net.connected) return;
            const t0 = performance.now();
            socket.timeout(2000).emit('ping_check', () => { state.ping = Math.round(performance.now() - t0); });
        }, 2000);
    });

    function loadServerMusic() {
        fetch('api/music', { cache: 'no-store' })
            .then((r) => r.ok ? r.json() : null)
            .then((m) => { if (m) Sound.setServerTracks(m, ''); })
            .catch(() => { /* pas d'API musique : on garde les pistes locales */ });
    }

    // ---------- Mode hors-ligne : même moteur que le serveur, dans le navigateur ----------
    const offline = { worlds: {}, timer: null };

    function startOfflineWorld() {
        stopOfflineWorld();
        const lv = prefs.level;
        if (!offline.worlds[lv]) offline.worlds[lv] = new Core.World({ level: lv, botCount: LEVELS[lv].bots + 2 });
        const w = offline.worlds[lv];
        w.removeSnake(OFFLINE_ID);
        const mine = w.addSnake(OFFLINE_ID, prefs.name || 'Serpent', prefs.skin, false);
        if (usePhoto()) mine.avatar = usePhoto();
        state.myId = OFFLINE_ID;
        state.arenaSize = w.size;
        offline.timer = setInterval(() => {
            w.setInput(OFFLINE_ID, state.angle, state.boosting);
            w.step();
            let myDeath = null;
            for (const ev of w.drainEvents()) {
                if (ev.type !== 'death') { if (ev.id === OFFLINE_ID || !ev.id) onFx(ev); continue; }
                if (ev.id === OFFLINE_ID) myDeath = ev;
                if (ev.killerId === OFFLINE_ID) onKill({ victim: ev.name, x: ev.x, y: ev.y });
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
        prefs.name = $('playerName').value.trim().substring(0, 14) || Account.displayName();
        store.set('snake_name', prefs.name);
        state.worldEvent = null;
        updateEventBanner();
        if (prefs.level === 'volcan') Quests.track('volcan', 1);
        state.snaps = [];
        state.clockOffset = null;
        jitter.last = 0; jitter.late = 0; state.renderDelay = 0;
        state.lastMe = null;
        state.lastOrbs = 0;
        state.mode = mode;
        state.playing = true;
        const room = mode === 'online' ? state.room : null;
        const level = room ? room.level : prefs.level;
        state.level = level;
        state.arenaSize = LEVELS[level].size;
        state.bubbles.clear();
        $('chatFeed').innerHTML = '';
        closeChat();
        $('chatBtn').classList.toggle('hidden', mode !== 'online');
        state.chests = []; state.volcanoes = []; state.density = null;
        FX.clear();
        Sound.unlock();
        Sound.play('start');
        Tower.startRun(null);

        if (mode === 'online') {
            stopOfflineWorld();
            net.socket.emit('joinGame', {
                name: prefs.name || 'Serpent', skin: prefs.skin, level, room: room ? room.code : undefined, token: Account.token || undefined,
                photo: prefs.photo === 'account' && !!Account.photoUrl(), photoData: prefs.photo === 'custom' && customPhoto ? customPhoto : undefined
            });
            sendView(true);
        } else {
            startOfflineWorld();
        }
        showScreen('hud');
        updateMissionHud(null);
        const L = LEVELS[level];
        toast(room ? `👥 Room ${room.code} · ${L.icon} ${L.name}` : `${L.icon} ${L.name}`, 'info');
    }

    // ---------- Rooms privées ----------
    function setRoom(room) {
        state.room = room;
        $('roomIdle').classList.toggle('hidden', !!room);
        $('roomActive').classList.toggle('hidden', !room);
        $('roomMsg').textContent = '';
        if (room) {
            $('roomCode').textContent = room.code;
            const L = LEVELS[room.level];
            $('roomLevel').textContent = `${L.icon} ${L.name}`;
            $('roomBadge').textContent = room.players ? `👤 ${room.players} dedans` : '';
        } else {
            $('roomBadge').textContent = '';
            // On retire ?room= de l'adresse pour ne pas y retourner au prochain chargement
            if (location.search.includes('room=')) history.replaceState(null, '', location.pathname + location.hash);
        }
        updatePlayButton();
    }
    function roomMsg(text, isErr) {
        $('roomMsg').textContent = text || '';
        $('roomMsg').classList.toggle('err', !!isErr);
    }
    function joinRoom(code) {
        code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (code.length !== 5) return roomMsg('Le code fait 5 caractères', true);
        if (!net.connected) return roomMsg('Serveur non connecté', true);
        net.socket.timeout(4000).emit('roomInfo', { code }, (err, r) => {
            if (err || !r) return roomMsg('Pas de réponse du serveur', true);
            if (r.error) return roomMsg('❌ ' + r.error, true);
            setRoom(r);
            Sound.play('click');
            toast(`👥 Room ${r.code} rejointe : appuie sur Jouer !`, 'info');
        });
    }
    function inviteLink(code) { return location.origin + location.pathname + '?room=' + code; }
    $('roomCreate').addEventListener('click', () => {
        if (!net.connected) return roomMsg('Serveur non connecté', true);
        net.socket.timeout(4000).emit('createRoom', { level: prefs.level }, (err, r) => {
            if (err || !r) return roomMsg('Pas de réponse du serveur', true);
            if (r.error) return roomMsg('❌ ' + r.error, true);
            setRoom(r);
            Sound.play('levelup');
            roomMsg(`Room créée ! Envoie le code ${r.code} ou le lien à tes amis.`);
        });
    });
    $('roomJoin').addEventListener('click', () => joinRoom($('roomCodeInput').value));
    $('roomCodeInput').addEventListener('keydown', (e) => { if (e.code === 'Enter') { e.preventDefault(); e.stopPropagation(); joinRoom(e.target.value); } });
    $('roomLeave').addEventListener('click', () => { setRoom(null); Sound.play('click'); });
    $('roomShare').addEventListener('click', async () => {
        if (!state.room) return;
        const url = inviteLink(state.room.code);
        const text = `Viens jouer avec moi à Mich Snake ! Room ${state.room.code}`;
        try {
            if (navigator.share) { await navigator.share({ title: 'Mich Snake', text, url }); return; }
        } catch (e) { if (e && e.name === 'AbortError') return; }
        try { await navigator.clipboard.writeText(url); roomMsg('🔗 Lien copié : colle-le à tes amis'); }
        catch (e) { roomMsg('Lien : ' + url); }
    });

    // ---------- Joueurs en ligne ----------
    function updateOnlineUI() {
        const o = state.online;
        const show = net.connected && !!o;
        $('onlineCount').classList.toggle('hidden', !show);
        $('roomBox').classList.toggle('hidden', !net.connected);
        if (!show) return;
        $('onlineCount').textContent = `🟢 ${o.total} en ligne`;
        $('onlineCount').title = `${o.playing} en partie${o.rooms ? ` · ${o.rooms} room${o.rooms > 1 ? 's' : ''} privée${o.rooms > 1 ? 's' : ''}` : ''}`;
        document.querySelectorAll('.lv-online').forEach((el) => {
            const n = o.levels[el.dataset.level] || 0;
            el.textContent = n ? `👥 ${n} joueur${n > 1 ? 's' : ''} en ce moment` : '';
        });
    }

    // ---------- Messages éphémères ----------
    const QUICK_CHAT = ['👋', '😂', '🔥', 'GG', '😱', '❤️', '😡', 'Viens !'];
    function openChat() {
        if (state.mode !== 'online' || !state.playing) return;
        $('chatPanel').classList.remove('hidden');
        if (!isTouch) $('chatInput').focus();
    }
    function closeChat() {
        $('chatPanel').classList.add('hidden');
        $('chatInput').blur();
    }
    function sendChat(text) {
        text = String(text || '').trim();
        if (!text || !net.connected) return;
        net.socket.emit('chat', { text });
        $('chatInput').value = '';
        closeChat();
    }
    function onChat(m) {
        if (state.mode !== 'online') return;
        state.bubbles.set(m.id, { text: m.text, until: performance.now() + 5000 });
        const line = document.createElement('div');
        line.className = 'chat-line' + (m.id === state.myId ? ' me' : '');
        const who = document.createElement('b');
        who.textContent = m.name;
        line.append(who, document.createTextNode(m.text));
        const feed = $('chatFeed');
        feed.appendChild(line);
        while (feed.children.length > 5) feed.firstChild.remove();
        setTimeout(() => line.remove(), 6000);
        if (m.id !== state.myId) Sound.play('click');
    }
    for (const q of QUICK_CHAT) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = q;
        b.addEventListener('click', () => sendChat(q));
        $('chatQuick').appendChild(b);
    }
    $('chatForm').addEventListener('submit', (e) => { e.preventDefault(); sendChat($('chatInput').value); });
    $('chatInput').addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.code === 'Escape') closeChat();
    });
    $('chatBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        if ($('chatPanel').classList.contains('hidden')) openChat(); else closeChat();
    });

    // Bulle au-dessus de la tête d'un serpent
    function drawBubble(text, x, y) {
        const z = Math.max(0.7, state.camera.zoom);
        const fs = 14 / z;
        ctx.save();
        ctx.font = `bold ${fs}px 'Segoe UI', sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const w = Math.min(ctx.measureText(text).width, 260 / z) + 16 / z, h = fs + 12 / z;
        const bx = x - w / 2, by = y - h;
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx, by, w, h, h / 2); else ctx.rect(bx, by, w, h);
        ctx.moveTo(x - 6 / z, by + h); ctx.lineTo(x, by + h + 7 / z); ctx.lineTo(x + 6 / z, by + h);
        ctx.fill();
        ctx.fillStyle = '#10141f';
        ctx.fillText(text, x, by + h / 2, 260 / z);
        ctx.restore();
    }

    const levelScene = () => (state.level === 'volcan' ? 'game2' : 'game');
    // Photo utilisée comme skin (adresse ou image importée), ou null pour l'emoji
    const usePhoto = () => prefs.photo === 'custom' ? (customPhoto || null) : prefs.photo === 'account' ? Account.photoUrl() : null;

    function onDeath(ev) {
        state.playing = false;
        const skin = SKINS[prefs.skin] || SKINS.neon;
        if (state.lastMe) FX.explosion(state.lastMe.x, state.lastMe.y, skin.color);
        FX.shake(18);
        Sound.setBoost(false);
        Sound.play('gameover');
        Sound.duck('menu', 2200);
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
        Account.addRun({ score: ev.score, kills: ev.kills || 0, level: state.level, at: Date.now() });
        $('dAccount').textContent = ev.account
            ? (ev.accountBest ? `👑 Nouveau record du compte ${ev.account.pseudo} au classement mondial !` : `Record du compte : ${ev.account.best}`)
            : Account.user ? '' : '👤 Connecte-toi pour inscrire tes records au classement mondial.';
        setTimeout(() => { if (!state.playing) showScreen('death'); }, 900);
    }

    function onKill(ev) {
        Sound.play('kill');
        Quests.track('kills', 1);
        if (ev.x !== undefined) {
            FX.explosion(ev.x, ev.y, '#ff3366');
            FX.floatText(ev.x, ev.y, '+50 ⚔️', '#ff6b8a');
        }
        toast(`⚔️ Vous avez éliminé ${ev.victim} !`, 'kill');
    }

    // Coffres et bonus d'amélioration ramassés par mon serpent
    let lastChestAt = 0;
    function onFx(ev) {
        if (ev.type === 'chest') {
            const legend = ev.kind === 'legend';
            lastChestAt = performance.now();
            Sound.play('chest', ev.kind);
            FX.burst(ev.x, ev.y, legend ? ['#d78bff', '#ffd700', '#ffffff'] : ['#ffd700', '#ffae00', '#fff3a0'], legend ? 90 : 45, legend ? 11 : 8);
            FX.floatText(ev.x, ev.y - 20, `+${ev.gold}`, legend ? '#e3a8ff' : '#ffd700', legend ? 40 : 30);
            FX.shake(legend ? 12 : 5);
            toast(legend ? `👑 Coffre légendaire : +${ev.gold} points !` : `🎁 Coffre ouvert : +${ev.gold} points`, 'gold');
            Quests.track('chests', 1);
            if (legend) Quests.track('legend', 1);
        } else if (ev.type === 'power') {
            const p = POWERUPS[ev.kind];
            if (!p) return;
            // Bonus sorti d'un coffre : on le joue juste après le son du coffre
            const delay = performance.now() - lastChestAt < 200 ? 550 : 0;
            Quests.track('powers', 1);
            setTimeout(() => {
                Sound.play('power', ev.kind);
                const at = ev.kind === 'portal' ? ev : (state.lastMe || ev);
                FX.ring(at.x, at.y, p.color);
                if (ev.kind === 'shock' || ev.kind === 'freeze') {
                    for (let i = 1; i <= 3; i++) setTimeout(() => FX.ring(at.x, at.y, p.color), i * 110);
                    FX.burst(at.x, at.y, [p.color, '#ffffff'], 60, 12);
                    FX.shake(ev.kind === 'shock' ? 14 : 6);
                }
                FX.floatText(at.x, at.y - 40, `${p.icon} ${p.name}`, p.color, 22);
                toast(`${p.icon} ${p.name}${p.duration ? ` ${p.duration} s` : ''} — ${p.desc}`, 'power');
            }, delay);
        } else if (ev.type === 'powerEnd') {
            Sound.play('powerEnd');
        } else if (ev.type === 'world') {
            const E = WORLD_EVENTS[ev.kind];
            if (!E) return;
            state.worldEvent = [ev.kind, E.duration];
            Sound.play(ev.kind === 'boss' ? 'boss' : 'event');
            FX.shake(ev.kind === 'boss' ? 12 : 6);
            toast(`${E.icon} ${E.name} ! ${E.desc}`, 'event');
            Quests.track('events', 1);
            updateEventBanner();
        } else if (ev.type === 'worldEnd') {
            state.worldEvent = null;
            updateEventBanner();
        } else if (ev.type === 'bossDown') {
            FX.explosion(ev.x, ev.y, '#3dff8a');
            FX.burst(ev.x, ev.y, ['#3dff8a', '#ffd700', '#d78bff'], 120, 14);
            FX.shake(20);
            Sound.play('kill');
            setTimeout(() => Sound.play('chest', 'legend'), 300);
            Quests.track('boss', 1);
            toast(ev.killerId === state.myId ? '🐉 Vous avez abattu l\'Hydre : deux coffres légendaires !'
                : `🐉 L'Hydre est tombée${ev.killerName ? ' sous les crocs de ' + ev.killerName : ''} : coffres légendaires à prendre !`, 'gold');
        }
    }

    // Bandeau de l'événement fou en cours, avec compte à rebours
    let lastBanner = '';
    function updateEventBanner() {
        const we = state.playing && state.worldEvent;
        const E = we && WORLD_EVENTS[we[0]];
        const html = E ? `${E.icon} ${E.name}<small>${we[1]} s</small>` : '';
        if (html === lastBanner) return;
        lastBanner = html;
        const el = $('eventBanner');
        el.innerHTML = html;
        el.classList.toggle('hidden', !E);
        el.classList.toggle('boss', !!E && we[0] === 'boss');
    }

    Quests.onComplete = (q) => {
        Sound.play('quest');
        toast(`📅 Quête réussie : ${q.icon} ${q.text}`, 'quest');
        updateQuestUI();
    };
    Quests.onDayComplete = (days) => {
        const unlocked = Object.keys(SKINS).filter(k => SKINS[k].quest === days);
        setTimeout(() => {
            Sound.play('levelup');
            toast('🎉 Les 3 quêtes du jour sont réussies !', 'gold');
            for (const k of unlocked) toast(`✨ Skin débloqué : ${SKINS[k].emoji} ${SKINS[k].name}`, 'gold');
        }, 900);
        buildSkinSelector();
    };

    Tower.onComplete = (floor, reward) => {
        Sound.play('levelup');
        toast(`🗼 Étage ${floor} réussi !`, 'gold');
        if (reward) setTimeout(() => toast(`✨ Skin débloqué : ${SKINS[reward].emoji} ${SKINS[reward].name}`, 'gold'), 700);
        for (const key in LEVELS) {
            if (LEVELS[key].unlock === Tower.floor) setTimeout(() => toast(`${LEVELS[key].icon} Niveau débloqué : ${LEVELS[key].name} !`, 'gold'), 1400);
        }
        buildSkinSelector();
        updateTowerUI();
    };

    // ---------- Snapshots & interpolation ----------
    // Snapshot en ligne compact : corps codés en écarts, nourriture en différentiel (voir Core.snapshotFor)
    const knownFoods = new Map();
    function decodeSnapshot(snap) {
        if (!snap.sp) return;
        for (const sn of snap.s) {
            const g = sn.g;
            for (let i = 2; i < g.length; i++) g[i] += g[i - 2];
            sn.sp = snap.sp;
        }
        if (snap.fk) knownFoods.clear();
        for (const id of snap.fr || []) knownFoods.delete(id);
        for (const f of snap.fa || []) knownFoods.set(f[0], f);
        snap.f = Array.from(knownFoods.values());
    }

    function receiveSnapshot(snap) {
        const now = performance.now();
        // Horloge lissée : temps local estimé du tick serveur, robuste au jitter réseau
        const offset = now - snap.t * TICK_MS;
        if (state.clockOffset === null || Math.abs(offset - state.clockOffset) > 500) state.clockOffset = offset;
        else state.clockOffset += (offset - state.clockOffset) * (offset < state.clockOffset ? 0.2 : 0.02);

        if (jitter.last && snap.t > jitter.last) jitter.gap += ((snap.t - jitter.last) * TICK_MS - jitter.gap) * 0.1;
        jitter.last = snap.t;
        // Retard de ce snapshot par rapport aux plus rapides : montée immédiate, redescente lente
        jitter.late = Math.max(now - (state.clockOffset + snap.t * TICK_MS), jitter.late * 0.985);
        interpDelay = Core.clamp(jitter.gap * 1.2 + jitter.late + 8, TICK_MS * 2, 320);
        state.snaps.push({ time: snap.t * TICK_MS, data: snap });
        if (state.snaps.length > 30) state.snaps.shift();

        if (snap.d) state.density = snap.d;
        if (snap.ch) state.chests = snap.ch;
        if (snap.ec) state.volcanoes = snap.ec;
        if (snap.lv) state.level = snap.lv;
        // Éruptions : alerte quand une nouvelle apparaît à l'écran, explosion quand elle part
        for (const e of snap.er || []) {
            if (!state.seenEruptions.has(e[0])) { state.seenEruptions.add(e[0]); Sound.play('warning'); }
        }
        if (state.seenEruptions.size > 50) state.seenEruptions.clear();
        for (const [bx, by] of snap.eb || []) {
            FX.eruption(bx, by);
            Sound.play('eruption');
            const me = snap.me;
            FX.shake(me ? Math.max(3, 16 - Math.hypot(me.x - bx, me.y - by) / 60) : 6);
        }
        state.worldEvent = snap.we || null;
        if (state.playing) {
            const mine = snap.s.find(s => s.id === state.myId);
            Sound.setBoost(!!(mine && mine.b));
            if (snap.me && snap.me.orbs > state.lastOrbs) {
                Quests.track('orbs', snap.me.orbs - state.lastOrbs);
                Sound.play('eat');
                FX.sparkle(snap.me.x, snap.me.y, (SKINS[prefs.skin] || SKINS.neon).color);
                state.lastOrbs = snap.me.orbs;
            }
        }
        state.lb = snap.lb;
        state.playerCount = snap.n;
        state.humanCount = snap.h || 1;
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
        updatePowerHud(me.pw, me.fz);
        updateEventBanner();
        // Gelé par le Blizzard d'un autre serpent : on le dit, sinon ça ressemble à un ralentissement du jeu
        if (me.fz && !state.frozen) {
            Sound.play('power', 'freeze');
            toast('❄️ Gelé par un Blizzard ! Vous êtes ralenti quelques secondes', 'info');
        }
        state.frozen = !!me.fz;
        Quests.track('score', me.score);
        Quests.track('survive', me.alive);
    }

    let lastPowerHtml = '';
    function updatePowerHud(pw, frozen) {
        let html = frozen ? `<div class="power-chip ending" style="--c:#9be7ff" title="Gelé">❄️ Gelé ${frozen}s</div>` : '';
        for (const k in (pw || {})) {
            const p = POWERUPS[k];
            if (!p) continue;
            html += `<div class="power-chip${pw[k] <= 3 ? ' ending' : ''}" style="--c:${p.color}" title="${p.name}">${p.icon} ${pw[k]}s</div>`;
        }
        if (html !== lastPowerHtml) { $('powerHud').innerHTML = html; lastPowerHtml = html; }
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
        // Délai lissé pour ne pas faire accélérer / ralentir l'image quand il change
        state.renderDelay = state.renderDelay ? state.renderDelay + (interpDelay - state.renderDelay) * 0.05 : interpDelay;
        const renderTime = now - state.clockOffset - state.renderDelay;

        let a = snaps[0], b = snaps[0];
        for (let i = snaps.length - 1; i >= 0; i--) {
            if (snaps[i].time <= renderTime) { a = snaps[i]; b = snaps[i + 1] || snaps[i]; break; }
        }
        if (renderTime < snaps[0].time) { a = b = snaps[0]; }
        const span = b.time - a.time;
        const t = span > 0 ? Core.clamp((renderTime - a.time) / span, 0, 1) : 0;
        const items = b.data.it || [];
        const eruptions = b.data.er || [];
        if (a === b) return { snakes: b.data.s, foods: b.data.f, items, eruptions };

        if (!a.snakeMap) a.snakeMap = indexBy(a.data.s, s => s.id);
        if (!a.foodMap) a.foodMap = indexBy(a.data.f, f => f[0]);

        const snakes = b.data.s.map((sb) => {
            const sa = a.snakeMap.get(sb.id);
            // Pas d'interpolation sur un saut (portail, traversée de mur en fantôme)
            if (!sa || Math.abs(sa.g[0] - sb.g[0]) + Math.abs(sa.g[1] - sb.g[1]) > 200) return sb;
            const ga = sa.g, gb = sb.g;
            const n = gb.length, na = ga.length;
            const g = new Array(n);
            for (let i = 0; i < n; i++) g[i] = i < na ? lerp(ga[i], gb[i], t) : gb[i];
            return {
                id: sb.id, n: sb.n, k: sb.k, b: sb.b, sc: sb.sc, p: sb.p, v: sb.v, sp: sb.sp, m: sb.m,
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
        return { snakes, foods, items, eruptions };
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
        if (e.target && e.target.tagName === 'INPUT') return;
        if (e.code === 'KeyM') toggleMute();
        if (e.code === 'Space' && state.playing) { state.boosting = true; e.preventDefault(); }
        if (e.code === 'Enter' && state.playing && state.mode === 'online') { e.preventDefault(); openChat(); return; }
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
        if (e.target.closest && e.target.closest('.hud-btn, .collapsible.collapsed, #chatPanel')) return;   // boutons du HUD, messages
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
        // Seulement en partie : dans les menus, le doigt doit pouvoir faire défiler la page
        if (state.playing) e.preventDefault();
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
        $('adminScreen').classList.add('hidden');
        $('authScreen').classList.add('hidden');
        $('hallScreen').classList.add('hidden');
        // Après un game over, la musique de présentation revient d'elle-même (Sound.duck)
        if (which !== 'death') Sound.setScene(which === 'hud' ? levelScene() : 'menu');
        if (which !== 'hud') Sound.setBoost(false);
        $('menu').classList.toggle('hidden', which !== 'menu');
        $('deathScreen').classList.toggle('hidden', which !== 'death');
        $('hud').classList.toggle('hidden', which !== 'hud');
        $('touchControls').classList.toggle('hidden', !(which === 'hud' && isTouch));
        if (which !== 'hud') { state.boosting = false; boostOff(); joy.id = null; joyBase.style.display = 'none'; }
        if (which === 'menu') { updateTowerUI(); updateRecords(); buildLevelPicker(); updateQuestUI(); updateAccountUI(); }
        if (which !== 'hud') { state.worldEvent = null; updateEventBanner(); }
    }

    function buildLevelPicker() {
        const el = $('levelPicker');
        el.innerHTML = '';
        for (const key in LEVELS) {
            const L = LEVELS[key];
            const open = levelUnlocked(key);
            const b = document.createElement('button');
            b.className = 'level-card level-' + key + (key === prefs.level ? ' active' : '') + (open ? '' : ' locked');
            b.innerHTML = `<span class="lv-icon">${open ? L.icon : '🔒'}</span><span class="lv-text"><b>${L.name}</b><small>${open ? L.desc
                : `Atteignez l'étage ${L.unlock} de la Tour des Défis pour débloquer ce niveau (vous êtes à l'étage ${Tower.floor}).`}</small><small class="lv-online" data-level="${key}"></small></span>`;
            b.addEventListener('click', () => {
                if (!open) { Sound.play('warning'); toast(`🔒 ${L.name} : atteignez l'étage ${L.unlock} de la Tour des Défis`, 'info'); return; }
                prefs.level = key;
                store.set('snake_level', key);
                Sound.play('click');
                buildLevelPicker();
            });
            el.appendChild(b);
        }
        updateOnlineUI();
    }

    // ---------- Panneaux réductibles du HUD ----------
    function setupCollapsibles() {
        document.querySelectorAll('.collapsible').forEach((panel) => {
            const btn = panel.querySelector('.collapse-btn');
            const key = 'snake_hud_' + panel.id;
            const apply = (collapsed) => {
                panel.classList.toggle('collapsed', collapsed);
                btn.textContent = collapsed ? panel.dataset.pill : '–';
                btn.title = collapsed ? 'Agrandir' : 'Réduire';
                store.set(key, collapsed ? '1' : '0');
                if (panel.id === 'minimapWrap' && !collapsed) setTimeout(resize, 0);
            };
            apply(store.get(key, '0') === '1');
            const toggle = (e) => { e.preventDefault(); e.stopPropagation(); apply(!panel.classList.contains('collapsed')); };
            btn.addEventListener('click', toggle);
            btn.addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
        });
    }

    function setPhoto(kind) {
        prefs.photo = kind;
        store.set('snake_photo', kind || '0');
    }

    // Photo importée : recadrée en carré et réduite à 128 px (JPEG ~8 Ko), gardée sur l'appareil
    const photoInput = document.createElement('input');
    photoInput.type = 'file';
    photoInput.accept = 'image/*';
    photoInput.addEventListener('change', () => {
        const file = photoInput.files && photoInput.files[0];
        photoInput.value = '';
        if (!file) return;
        if (!/^image\//.test(file.type)) { toast('❌ Choisis une image', 'kill'); return; }
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            const S = 128, c = document.createElement('canvas');
            c.width = c.height = S;
            const g = c.getContext('2d');
            const side = Math.min(img.naturalWidth, img.naturalHeight);
            g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, S, S);
            customPhoto = c.toDataURL('image/jpeg', 0.82);
            store.set('snake_custom_photo', customPhoto);
            setPhoto('custom');
            Sound.play('levelup');
            toast('📸 Ta photo est ton nouveau skin !', 'gold');
            buildSkinSelector();
        };
        img.onerror = () => { URL.revokeObjectURL(url); toast('❌ Image illisible', 'kill'); };
        img.src = url;
    });

    function photoTile(src, active, title, onClick) {
        const b = document.createElement('div');
        b.className = 'skin-btn photo' + (active ? ' active' : '');
        b.title = title;
        if (src) {
            const img = new Image();
            img.src = src; img.alt = '';
            b.appendChild(img);
        } else {
            b.textContent = '📸';
        }
        b.style.setProperty('--glow', SKINS[prefs.skin].color);
        b.addEventListener('click', onClick);
        return b;
    }

    function buildSkinSelector() {
        const el = $('skinSelector');
        el.innerHTML = '';
        let unlocked = 0;
        const keys = Object.keys(SKINS);
        // Ma photo (importée depuis l'appareil) : un clic l'active, un 2e clic permet d'en choisir une autre
        el.appendChild(photoTile(customPhoto, prefs.photo === 'custom', customPhoto ? 'Ma photo (cliquer à nouveau pour la changer)' : 'Choisir une photo comme skin', () => {
            if (!customPhoto || prefs.photo === 'custom') { photoInput.click(); return; }
            setPhoto('custom');
            buildSkinSelector();
        }));
        // Photo de profil (compte X / Facebook, ou identité claude.ai dans la version web)
        const photo = Account.photoUrl();
        if (photo) {
            el.appendChild(photoTile(photo, prefs.photo === 'account', 'Ma photo de profil', () => {
                setPhoto(prefs.photo === 'account' ? '' : 'account');
                buildSkinSelector();
            }));
        }
        for (const key of keys) {
            const s = SKINS[key];
            const ok = Tower.isUnlocked(key);
            if (ok) unlocked++;
            const b = document.createElement('div');
            b.className = 'skin-btn' + (ok ? '' : ' locked') + (key === prefs.skin && !usePhoto() ? ' active' : '');
            b.textContent = s.emoji;
            b.style.setProperty('--glow', s.color);
            const lockText = s.quest ? `réussissez les quêtes du jour ${s.quest > 1 ? s.quest + ' jours' : 'une journée'}` : `atteignez l'étage ${s.unlock} de la Tour des Défis`;
            b.title = ok ? s.name : `${s.name} — ${lockText}`;
            b.addEventListener('click', () => {
                if (!ok) { $('skinName').textContent = `🔒 ${s.name} : ${lockText}`; return; }
                // Avec une photo active, l'emoji choisi donne la couleur du halo ; un 2e clic repasse à l'emoji
                if (usePhoto() && key === prefs.skin) setPhoto('');
                prefs.skin = key;
                store.set('snake_skin', key);
                buildSkinSelector();
            });
            el.appendChild(b);
        }
        $('skinCount').textContent = `${unlocked}/${keys.length} débloqués`;
        $('skinName').textContent = usePhoto()
            ? `📸 ${prefs.photo === 'custom' ? 'Ma photo' : 'Photo de profil'} · halo ${SKINS[prefs.skin].emoji} ${SKINS[prefs.skin].name} (re-clique l'emoji pour le reprendre)`
            : `${SKINS[prefs.skin].emoji} ${SKINS[prefs.skin].name} · 📸 pour jouer avec ta photo`;
    }

    function updateQuestUI() {
        const list = Quests.list();
        $('questList').innerHTML = list.map((q) => `
            <div class="quest${q.done ? ' done' : ''}"><span>${q.done ? '✅' : q.icon}</span><span>${escapeHtml(q.text)}</span><small>${q.value}/${q.target}</small>
            <div class="progress-bar"><div class="progress-fill" style="width:${Math.floor(q.value / q.target * 100)}%"></div></div></div>`).join('');
        $('questStreak').textContent = Quests.streak ? `🔥 ${Quests.streak} j` : '';
        const next = Object.values(SKINS).filter(s => s.quest && s.quest > Quests.daysDone).sort((a, b) => a.quest - b.quest)[0];
        $('questReward').innerHTML = next
            ? `Réussir les 3 quêtes ${next.quest - Quests.daysDone > 1 ? `pendant ${next.quest - Quests.daysDone} journées` : 'aujourd\'hui'} débloque le skin <b>${next.emoji} ${next.name}</b>`
            : `${Quests.daysDone} journées réussies : tous les skins de quêtes sont à toi 🎉`;
    }

    function updateAccountUI() {
        const u = Account.user, v = Account.viewer;
        const photo = Account.photoUrl();
        $('accAvatar').innerHTML = photo ? `<img src="${escapeHtml(photo)}" alt="">` : (u ? '🐍' : '👤');
        if (u) {
            $('accText').innerHTML = `<b>${escapeHtml(u.pseudo)}</b>${u.admin ? ' · 👑 admin' : ''}<br>Record ${u.best} · ${u.games} parties`;
            $('accountBtn').textContent = 'Mon compte';
        } else if (v && v.name && !net.connected) {
            $('accText').innerHTML = `<b>${escapeHtml(v.name)}</b>${Account.isAdmin() ? ' · 👑 admin' : ''}<br>Version web · records sur cet appareil`;
            $('accountBtn').textContent = 'Compte';
        } else {
            $('accText').textContent = 'Invité · inscris-toi pour entrer au classement mondial';
            $('accountBtn').textContent = 'Se connecter';
        }
        $('accLogout').classList.toggle('hidden', !u && !(v && !net.connected));
        if (!$('playerName').value && Account.displayName()) $('playerName').value = Account.displayName();
        buildSkinSelector();
    }
    Account.onChange(() => { if (!state.playing) updateAccountUI(); });

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
        const h = state.humanCount;
        $('playerCount').textContent = state.mode === 'online' ? `👤 ${h} joueur${h > 1 ? 's' : ''} · ${state.playerCount} serpents` : `${state.playerCount} en jeu`;
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

    // ---------- Son ----------
    // Les navigateurs n'autorisent le son qu'après une première interaction
    const unlockAudio = () => Sound.unlock();
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, unlockAudio, { capture: true, passive: true });

    function refreshSoundButtons() {
        document.querySelectorAll('.sound-toggle').forEach((b) => {
            b.textContent = Sound.settings.muted ? '🔇' : '🔊';
            b.classList.toggle('off', Sound.settings.muted);
        });
    }
    function toggleMute() {
        Sound.setMuted(!Sound.settings.muted);
        refreshSoundButtons();
        if (window.SnakeAdmin) window.SnakeAdmin.refresh();
    }
    document.querySelectorAll('.sound-toggle').forEach((b) => {
        b.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); });
        b.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    });
    window.SnakeSoundUI = { refresh: refreshSoundButtons };
    refreshSoundButtons();

    $('adminBtn').addEventListener('click', () => { Sound.play('click'); window.SnakeAdmin.open(); });
    $('accountBtn').addEventListener('click', () => { Sound.play('click'); Account.open(); });
    $('accLogout').addEventListener('click', () => {
        Sound.play('click');
        const was = Account.displayName();
        Account.signOut();
        if ($('playerName').value === was) $('playerName').value = '';
        if (prefs.photo === 'account') setPhoto('');
        toast('👋 Déconnecté', 'info');
        updateAccountUI();
    });
    $('hallBtn').addEventListener('click', () => { Sound.play('click'); Account.openHall(); });
    $('deathHallBtn').addEventListener('click', () => { Sound.play('click'); Account.openHall(); });

    $('playerName').value = prefs.name;
    $('playBtn').addEventListener('click', () => startGame(net.connected ? 'online' : 'offline'));
    $('offlineBtn').addEventListener('click', () => startGame('offline'));
    $('replayBtn').addEventListener('click', () => startGame(state.mode === 'online' && net.connected ? 'online' : 'offline'));
    $('menuBtn').addEventListener('click', () => {
        stopOfflineWorld();
        if (state.mode === 'online' && net.connected) net.socket.emit('leaveGame');
        state.mode = null;
        showScreen('menu');
    });

    // ---------- Rendu ----------
    // Qualité adaptative : si les images ralentissent, on baisse la résolution du canvas
    // (le coût de dessin est proportionnel au nombre de pixels), puis on la remonte quand ça va mieux
    // (si le JS est léger mais que les images restent longues, c'est la carte graphique : on baisse moins, jusqu'à 0,7)
    const quality = { scale: 1, acc: 0, work: 0, frames: 0, good: 0 };
    function adaptQuality(dt, work) {
        if (!state.playing || document.hidden || dt > 250) { quality.acc = quality.work = quality.frames = 0; return; }
        quality.acc += dt; quality.work += work; quality.frames++;
        if (quality.acc < 1500) return;
        const avg = quality.acc / quality.frames, avgWork = quality.work / quality.frames;
        quality.acc = quality.work = quality.frames = 0;
        // Trop lent : soit le JS (avgWork), soit la carte graphique (images longues avec peu de JS, fréquent sur mobile)
        const floor = avgWork > 7 ? 0.5 : 0.7;
        if (avg > 21 && (avgWork > 7 || avg > 26) && quality.scale > floor) {
            quality.scale = Math.max(floor, quality.scale - 0.15); quality.good = 0; resize();
        } else if (avg < 15 && quality.scale < 1 && ++quality.good >= 3) {
            quality.scale = Math.min(1, quality.scale + 0.15); quality.good = 0; resize();
        }
    }

    function resize() {
        state.dpr = Math.max(0.6, Math.min(window.devicePixelRatio || 1, 2) * quality.scale);
        canvas.width = Math.floor(window.innerWidth * state.dpr);
        canvas.height = Math.floor(window.innerHeight * state.dpr);
        canvas.style.width = window.innerWidth + 'px';
        canvas.style.height = window.innerHeight + 'px';
        const r = mini.getBoundingClientRect();
        if (r.width) {
            mini.width = Math.max(1, Math.floor(r.width * state.dpr));
            mini.height = Math.max(1, Math.floor(r.height * state.dpr));
        }
        FX.resize(canvas.width, canvas.height);
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

    // Tailles de sprites arrondies par paliers (~10 %) : le zoom qui varie en continu ne doit pas
    // recréer des sprites (fillText d'emoji = coûteux) à chaque image
    function spriteSize(px) {
        if (px <= 32) return Math.max(8, Math.ceil(px / 4) * 4);
        return Math.ceil(Math.pow(1.1, Math.ceil(Math.log(px) / Math.log(1.1))));
    }

    // Sprites emoji pré-rendus : fillText d'un emoji à chaque segment serait bien trop lent
    const emojiCache = new Map();
    function emojiSprite(emoji, px) {
        px = spriteSize(px);
        const key = emoji + '|' + px;
        let c = emojiCache.get(key);
        if (c) return c;
        if (emojiCache.size > 400) emojiCache.clear();
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

    // Photos de profil : chargées une fois, découpées en disque avec un liseré de la couleur du skin
    const avatarImgs = new Map();
    function avatarImage(v) {
        let img = avatarImgs.get(v);
        if (!img) {
            img = new Image();
            img.decoding = 'async';
            img.src = /^[a-f0-9]{16}$/.test(v) ? 'avatar/' + v + '.jpg' : v;
            avatarImgs.set(v, img);
        }
        return img.complete && img.naturalWidth ? img : null;
    }
    const avatarCache = new Map();
    function avatarSprite(v, px, color) {
        const img = avatarImage(v);
        if (!img) return null;
        px = spriteSize(px);
        const key = v + '|' + px + '|' + color;
        let c = avatarCache.get(key);
        if (c) return c;
        if (avatarCache.size > 300) avatarCache.clear();
        c = document.createElement('canvas');
        c.width = c.height = Math.ceil(px * 1.25);
        const g = c.getContext('2d');
        const cx = c.width / 2, R = px * 0.5;
        g.save();
        g.beginPath(); g.arc(cx, cx, R, 0, Math.PI * 2); g.clip();
        const k = Math.max(px / img.naturalWidth, px / img.naturalHeight);
        g.drawImage(img, cx - img.naturalWidth * k / 2, cx - img.naturalHeight * k / 2, img.naturalWidth * k, img.naturalHeight * k);
        g.restore();
        g.lineWidth = Math.max(2, px * 0.08);
        g.strokeStyle = color;
        g.beginPath(); g.arc(cx, cx, R, 0, Math.PI * 2); g.stroke();
        avatarCache.set(key, c);
        return c;
    }
    const snakeSprite = (p, skin, px) => (p.v && avatarSprite(p.v, px, skin.color)) || emojiSprite(skin.emoji, px);

    function drawSnake(p, time, x0, y0, x1, y1, isLeader) {
        const skin = SKINS[p.k] || SKINS.neon;
        const g = p.g, n = g.length / 2, r = p.r;
        const ghost = p.p & 16, frozen = p.p & 8, boss = p.p & 64;
        if (ghost) ctx.globalAlpha = 0.4 + Math.sin(time * 0.01) * 0.12;
        if (boss) {                                      // l'Hydre : aura verte menaçante
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            const spr = glowSprite('#3dff8a', r * 0.9);
            ctx.globalAlpha = 0.5 + Math.sin(time * 0.006) * 0.2;
            for (let i = 0; i < n; i += 6) ctx.drawImage(spr, g[i * 2] - spr.width / 2, g[i * 2 + 1] - spr.height / 2);
            ctx.restore();
        }

        // Corps coloré : un seul trait épais (bien moins cher qu'un shadowBlur par segment)
        ctx.save();
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        // Ombre portée : donne du relief au serpent sur le décor
        ctx.translate(r * 0.25, r * 0.45);
        ctx.beginPath();
        ctx.moveTo(g[0], g[1]);
        for (let i = 1; i < n; i++) ctx.lineTo(g[i * 2], g[i * 2 + 1]);
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = r * 2;
        ctx.stroke();
        ctx.translate(-r * 0.25, -r * 0.45);
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

        // Emojis le long du corps, de la queue vers la tête : espacés selon l'épaisseur
        // (un gros serpent n'a pas besoin d'un sprite tous les 18 px, ça coûtait des centaines de dessins)
        const scale = state.camera.zoom * state.dpr;
        const bodySize = r * 1.9;
        const bodySpr = snakeSprite(p, skin, bodySize * scale);
        const bs = bodySize * 1.25;
        const sp = p.sp || 1;                            // points espacés de sp segments en ligne
        const step = Math.max(sp > 1 ? 1 : 2, Math.round(r * 0.8 / (Core.CONFIG.SEGMENT_DISTANCE * sp)));
        for (let i = n - 1; i >= (sp > 1 ? 1 : 2); i--) {
            if (i % step) continue;
            const x = g[i * 2], y = g[i * 2 + 1];
            if (x + r < x0 || x - r > x1 || y + r < y0 || y - r > y1) continue;
            ctx.drawImage(bodySpr, x - bs / 2, y - bs / 2, bs, bs);
        }

        // Tête : l'emoji en plus grand
        const hx = g[0], hy = g[1];
        const headSize = r * 2.7;
        const hs = headSize * 1.25;
        ctx.drawImage(snakeSprite(p, skin, headSize * scale), hx - hs / 2, hy - hs / 2, hs, hs);

        if (frozen) {                                    // gelé : givre bleuté sur le corps
            ctx.save();
            ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            ctx.beginPath();
            ctx.moveTo(g[0], g[1]);
            for (let i = 1; i < n; i++) ctx.lineTo(g[i * 2], g[i * 2 + 1]);
            ctx.globalAlpha = 0.45;
            ctx.strokeStyle = '#bff3ff';
            ctx.lineWidth = r * 2.1;
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.font = `${r * 1.4}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('❄️', hx, hy - r * 1.9);
            ctx.textBaseline = 'alphabetic';
            ctx.restore();
            if (Math.random() < 0.3) FX.emit(hx, hy, 1, { colors: ['#e6fbff', '#9be7ff'], speed: 1.5, life: 700, size: 4, gravity: 0.02 });
        }
        if (p.p & 32 && Math.random() < 0.25) FX.emit(hx, hy, 1, { colors: [POWERUPS.giant.color, '#fff'], speed: 3, life: 500, size: 5 });

        if (p.p & 1) {                                   // bouclier
            ctx.save();
            ctx.globalAlpha = 0.45 + Math.sin(time * 0.012) * 0.25;
            ctx.strokeStyle = POWERUPS.shield.color;
            ctx.lineWidth = 4;
            ctx.shadowColor = POWERUPS.shield.color; ctx.shadowBlur = 14;
            ctx.beginPath(); ctx.arc(hx, hy, hs / 2 + 4, 0, Math.PI * 2); ctx.stroke();
            ctx.restore();
        }
        if (p.p & 2) {                                   // crocs : couronne de pointes rouges qui tourne
            ctx.save();
            ctx.translate(hx, hy);
            ctx.rotate(time * 0.006);
            ctx.fillStyle = POWERUPS.blade.color;
            ctx.shadowColor = POWERUPS.blade.color; ctx.shadowBlur = 12;
            const R = hs / 2 + 2;
            for (let i = 0; i < 8; i++) {
                ctx.rotate(Math.PI / 4);
                ctx.beginPath(); ctx.moveTo(R, -4); ctx.lineTo(R + 10, 0); ctx.lineTo(R, 4); ctx.fill();
            }
            ctx.restore();
        }
        if (p.b && Math.random() < 0.6) {                // traînée de particules au boost
            FX.trail(g[(n - 1) * 2], g[(n - 1) * 2 + 1], skin.color);
            FX.trail(g[0] - Math.cos(p.a) * r, g[1] - Math.sin(p.a) * r, skin.color);
        }

        ctx.textAlign = 'center';
        ctx.font = `bold ${(boss ? 18 : 13) / Math.max(0.7, state.camera.zoom)}px sans-serif`;
        ctx.fillStyle = p.id === state.myId ? '#ffcc00' : boss ? '#3dff8a' : 'rgba(255,255,255,0.9)';
        ctx.fillText(p.n, hx, hy - r * 1.4 - 8);
        ctx.globalAlpha = 1;
        if (isLeader) {
            ctx.font = `${20 / Math.max(0.7, state.camera.zoom)}px sans-serif`;
            ctx.fillText('👑', hx, hy - r * 1.4 - 26);
        }
        const bubble = state.bubbles.get(p.id);
        if (bubble) {
            if (bubble.until < time) state.bubbles.delete(p.id);
            else drawBubble(bubble.text, hx, hy - r * 1.4 - (isLeader ? 48 : 30) / Math.max(0.7, state.camera.zoom));
        }
    }

    function drawChest(x, y, now, id, legend) {
        y += Math.sin(now * 0.003 + id) * 3;
        // Faisceau de lumière qui signale le coffre de loin
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const beam = ctx.createLinearGradient(x, y - 260, x, y);
        beam.addColorStop(0, 'rgba(255,215,0,0)');
        beam.addColorStop(1, legend ? 'rgba(200,120,255,0.35)' : 'rgba(255,215,0,0.25)');
        ctx.fillStyle = beam;
        ctx.beginPath(); ctx.moveTo(x - 8, y - 260); ctx.lineTo(x + 8, y - 260); ctx.lineTo(x + 22, y); ctx.lineTo(x - 22, y); ctx.fill();
        ctx.restore();
        if (legend) {
            ctx.save();
            ctx.translate(x, y);
            ctx.scale(1.45, 1.45);
            x = 0; y = 0;
        }
        const spr = glowSprite(legend ? '#c77dff' : '#ffd700', 18);
        ctx.globalAlpha = 0.55 + Math.sin(now * 0.005 + id) * 0.2;
        ctx.drawImage(spr, x - spr.width / 2, y - spr.height / 2);
        ctx.globalAlpha = 1;
        ctx.lineWidth = 2;
        ctx.strokeStyle = legend ? '#1d0636' : '#3b1d06';
        ctx.fillStyle = legend ? '#4b1d8a' : '#8b4a17';  // caisse
        ctx.fillRect(x - 16, y - 6, 32, 18); ctx.strokeRect(x - 16, y - 6, 32, 18);
        ctx.fillStyle = legend ? '#6a2fc0' : '#a65d22';  // couvercle
        ctx.fillRect(x - 17, y - 15, 34, 10); ctx.strokeRect(x - 17, y - 15, 34, 10);
        ctx.fillStyle = '#ffd700';                       // ferrures dorées
        ctx.fillRect(x - 17, y - 6, 34, 3);
        ctx.fillRect(x - 3, y - 15, 6, 27);
        ctx.fillStyle = '#fff3a0';
        ctx.fillRect(x - 2.5, y - 4, 5, 5);
        if ((Math.floor(now / 160) + id) % 12 === 0) {   // petit éclat
            ctx.fillStyle = '#fff';
            ctx.fillRect(x + 8, y - 13, 3, 3);
        }
        if (legend) ctx.restore();
    }

    // Niveau Volcan : zone d'éruption annoncée avec compte à rebours
    function drawEruption(x, y, ticksLeft, now) {
        const t = 1 - ticksLeft / (Core.CONFIG.TICK_RATE * 3);
        const R = 220;
        ctx.save();
        const gr = ctx.createRadialGradient(x, y, 0, x, y, R);
        gr.addColorStop(0, `rgba(255, 120, 0, ${0.15 + t * 0.45})`);
        gr.addColorStop(1, 'rgba(255, 40, 0, 0)');
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = `rgba(255, 80, 0, ${0.5 + Math.sin(now * 0.02) * 0.4})`;
        ctx.lineWidth = 5;
        ctx.setLineDash([18, 12]); ctx.lineDashOffset = now * 0.08;
        ctx.beginPath(); ctx.arc(x, y, R * (1 - t * 0.5), 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = `900 ${34 + t * 20}px 'Segoe UI', sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ffd27a';
        ctx.fillText('🌋 ' + Math.max(1, Math.ceil(ticksLeft / Core.CONFIG.TICK_RATE)), x, y);
        ctx.textBaseline = 'alphabetic';
        ctx.restore();
        if (Math.random() < 0.3 + t) FX.emit(x + (Math.random() - 0.5) * 120, y + (Math.random() - 0.5) * 120, 1, { colors: ['#ff6a00', '#ffb000'], speed: 2, life: 600, size: 6, gravity: -0.05 });
    }

    // Flèche au bord de l'écran vers le coffre le plus proche (et le légendaire)
    function drawChestArrows(me, W, H, z) {
        if (!me || !state.chests.length) return;
        const hx = me.g[0], hy = me.g[1];
        const targets = [];
        let best = null, bestD = Infinity, legend = null, legendD = Infinity;
        for (const c of state.chests) {
            const d = Math.hypot(c[0] - hx, c[1] - hy);
            if (c[2] && d < legendD) { legendD = d; legend = c; }
            if (d < bestD) { bestD = d; best = c; }
        }
        if (best) targets.push([best, bestD]);
        if (legend && legend !== best) targets.push([legend, legendD]);
        const cx = W / 2, cy = H / 2, d = state.dpr;
        for (const [c, dist] of targets) {
            const sx = cx + (c[0] - hx) * z, sy = cy + (c[1] - hy) * z;
            if (sx > 0 && sx < W && sy > 0 && sy < H) continue;          // déjà visible
            const a = Math.atan2(sy - cy, sx - cx);
            const m = 46 * d;
            const ex = Math.max(m, Math.min(W - m, cx + Math.cos(a) * W));
            const ey = Math.max(m, Math.min(H - m, cy + Math.sin(a) * H));
            const color = c[2] ? '#d78bff' : '#ffd700';
            ctx.save();
            ctx.translate(ex, ey);
            ctx.fillStyle = 'rgba(10,14,24,0.75)';
            ctx.beginPath(); ctx.arc(0, 0, 22 * d, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = color; ctx.lineWidth = 2 * d; ctx.stroke();
            ctx.font = `${16 * d}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(c[2] ? '👑' : '🎁', 0, 0);
            ctx.rotate(a);
            ctx.fillStyle = color;
            ctx.beginPath(); ctx.moveTo(32 * d, 0); ctx.lineTo(24 * d, -7 * d); ctx.lineTo(24 * d, 7 * d); ctx.fill();
            ctx.rotate(-a);
            ctx.font = `bold ${10 * d}px sans-serif`;
            ctx.fillStyle = '#fff';
            ctx.fillText(Math.round(dist / 10) + ' m', 0, 32 * d);
            ctx.restore();
        }
    }

    function drawPowerUp(x, y, kind, now, id) {
        const p = POWERUPS[kind];
        if (!p) return;
        const r = 15 + Math.sin(now * 0.006 + id) * 1.5;
        const spr = glowSprite(p.color, 14);
        ctx.drawImage(spr, x - spr.width / 2, y - spr.height / 2);
        ctx.beginPath();
        ctx.fillStyle = 'rgba(10, 14, 24, 0.9)';
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(now * 0.002 + id);
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.arc(0, 0, r + 3, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.fillText(p.icon, x, y + 1);
        ctx.textBaseline = 'alphabetic';
    }

    function drawMinimap(frame, dark) {
        const W = mini.width, H = mini.height;
        const size = state.arenaSize;
        const sx = W / size, sy = H / size;
        mctx.clearRect(0, 0, W, H);
        mctx.fillStyle = 'rgba(8, 12, 20, 0.6)';
        mctx.fillRect(0, 0, W, H);

        // Zones denses en nourriture (masquées pendant l'éclipse)
        if (state.density && !dark) {
            const n = Core.CONFIG.DENSITY_GRID;
            const cw = W / n, ch = H / n;
            const tint = FX.theme(state.level).minimap;
            for (let i = 0; i < state.density.length; i++) {
                const v = state.density[i];
                if (v < 40) continue;
                mctx.fillStyle = `${tint}${(v / 255) * 0.45})`;
                mctx.fillRect((i % n) * cw, Math.floor(i / n) * ch, cw + 0.5, ch + 0.5);
            }
        }

        mctx.strokeStyle = 'rgba(255, 0, 68, 0.6)';
        mctx.lineWidth = 1.5 * state.dpr;
        mctx.strokeRect(1, 1, W - 2, H - 2);

        // Coffres (violets = légendaires) et éruptions annoncées
        const cs = 3 * state.dpr;
        for (const [x, y, legend] of dark ? [] : state.chests) {
            mctx.fillStyle = legend ? '#d78bff' : '#ffd700';
            const k = legend ? 1.6 : 1;
            mctx.fillRect(x * sx - cs * k / 2, y * sy - cs * k / 2, cs * k, cs * k);
        }
        for (const [x, y] of state.volcanoes) {
            mctx.font = `${11 * state.dpr}px sans-serif`; mctx.textAlign = 'center'; mctx.textBaseline = 'middle';
            mctx.fillText('🌋', x * sx, y * sy);
            mctx.textBaseline = 'alphabetic';
        }

        // Champ de vision
        const cam = state.camera;
        mctx.strokeStyle = 'rgba(255,255,255,0.25)';
        mctx.lineWidth = 1 * state.dpr;
        mctx.strokeRect((cam.x - viewW() / 2) * sx, (cam.y - viewH() / 2) * sy, viewW() * sx, viewH() * sy);

        // Top joueurs (positions issues du classement global)
        const d = state.dpr;
        state.lb.forEach((e, i) => {
            const [id, , , x, y] = e;
            if (id === state.myId || dark) return;
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

    let fpsFrames = 0, fpsLast = performance.now(), miniFrame = 0, lastFrame = performance.now(), lastFrameRaw = performance.now(), lastWork = 0;
    function render(now) {
        requestAnimationFrame(render);
        const dt = Math.min(50, now - lastFrame);
        lastFrame = now;
        fpsFrames++;
        adaptQuality(now - lastFrameRaw, lastWork);
        lastFrameRaw = now;
        const workStart = performance.now();
        if (now - fpsLast > 1000) {
            state.fps = fpsFrames; fpsFrames = 0; fpsLast = now;
            const L = LEVELS[state.level];
            $('netInfo').textContent = state.mode === 'online'
                ? `${state.room ? `👥 Room ${state.room.code} · ` : ''}${L.icon} ${L.name} · 🌐 ${state.ping} ms · ${state.fps} FPS`
                : state.mode === 'offline' ? `${L.icon} ${L.name} · 🤖 Hors-ligne · ${state.fps} FPS` : '';
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
            // Menu : lent panoramique sur l'arène du niveau choisi
            state.level = prefs.level;
            state.arenaSize = LEVELS[prefs.level].size;
            cam.x = state.arenaSize / 2 + Math.cos(now / 9000) * 900;
            cam.y = state.arenaSize / 2 + Math.sin(now / 7000) * 900;
        }

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const z = cam.zoom * dpr;
        const shake = FX.shakeOffset(dt);
        ctx.setTransform(z, 0, 0, z, W / 2 - cam.x * z + shake.x * dpr, H / 2 - cam.y * z + shake.y * dpr);
        const vw = W / z, vh = H / z;
        const x0 = cam.x - vw / 2, x1 = cam.x + vw / 2, y0 = cam.y - vh / 2, y1 = cam.y + vh / 2;

        FX.drawBackground(ctx, state.level, x0, y0, x1, y1, state.arenaSize, now, cam);

        if (frame) {
            for (const f of frame.foods) {
                const [, fx, fy, fr, fc] = f;
                if (fx < x0 - 20 || fx > x1 + 20 || fy < y0 - 20 || fy > y1 + 20) continue;
                const spr = glowSprite(fc, fr);
                const pulse = 1 + Math.sin(now * 0.004 + f[0]) * 0.08;
                const s = spr.width * pulse;
                ctx.drawImage(spr, fx - s / 2, fy - s / 2, s, s);
            }
            for (const [, ex, ey, left] of frame.eruptions) {
                if (ex < x0 - 240 || ex > x1 + 240 || ey < y0 - 240 || ey > y1 + 240) continue;
                drawEruption(ex, ey, left, now);
            }
            for (const it of frame.items) {
                const [id, ix, iy, t, kind] = it;
                if (ix < x0 - 60 || ix > x1 + 60 || iy < y0 - 280 || iy > y1 + 60) continue;
                if (t === 1) drawPowerUp(ix, iy, kind, now, id); else drawChest(ix, iy, now, id, t === 2);
            }
            // Rayon du super-aimant autour de ma tête
            if (me && state.lastMe && state.lastMe.pw && state.lastMe.pw.magnet) {
                ctx.save();
                ctx.globalAlpha = 0.18;
                ctx.strokeStyle = POWERUPS.magnet.color;
                ctx.lineWidth = 3;
                ctx.setLineDash([10, 10]);
                ctx.lineDashOffset = -now * 0.05;
                ctx.beginPath(); ctx.arc(me.g[0], me.g[1], me.r + Core.CONFIG.MAGNET_RANGE * Core.CONFIG.MAGNET_POWER_MULT, 0, Math.PI * 2); ctx.stroke();
                ctx.restore();
            }
            const leaderId = state.lb[0] && state.lb[0][0];
            // Mon serpent dessiné en dernier, par-dessus les autres
            const ordered = frame.snakes.slice().sort((a, b) => (a.id === state.myId) - (b.id === state.myId));
            for (const s of ordered) drawSnake(s, now, x0, y0, x1, y1, s.id === leaderId);
        }
        FX.drawWorld(ctx, dt);

        // Calques écran : braises, vignette, flèches vers les coffres
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        FX.drawScreen(ctx, state.level, W, H, dt, dpr);
        const we = state.mode && state.worldEvent && state.worldEvent[0];
        if (we === 'eclipse') {
            // Éclipse : seule une bulle de lumière autour de ma tête reste visible
            const R = (me ? me.r * 9 + 160 : 260) * z;
            const lx = W / 2 + shake.x * dpr, ly = H / 2 + shake.y * dpr;
            const dark = ctx.createRadialGradient(lx, ly, R * 0.35, lx, ly, R);
            dark.addColorStop(0, 'rgba(2,3,8,0)');
            dark.addColorStop(1, 'rgba(2,3,8,0.94)');
            ctx.fillStyle = dark;
            ctx.fillRect(0, 0, W, H);
        } else if (we === 'goldrain' && Math.random() < 0.7) {
            FX.emit(x0 + Math.random() * vw, y0, 1, { colors: ['#ffd700', '#fff3a0'], speed: 0.5, life: 1800, size: 5, gravity: 0.25 });
        } else if (we === 'frenzy' && me && Math.random() < 0.5) {
            FX.trail(me.g[0] + (Math.random() - 0.5) * 40, me.g[1] + (Math.random() - 0.5) * 40, '#ffe600');
        }
        if (state.playing) drawChestArrows(me, W, H, z);

        if (state.mode && ++miniFrame % 4 === 0 && !$('minimapWrap').classList.contains('collapsed')) drawMinimap(frame, we === 'eclipse');
        lastWork = performance.now() - workStart;
    }

    // ---------- Démarrage ----------
    buildSkinSelector();
    setupCollapsibles();
    updateTowerUI();
    updateRecords();
    showScreen('menu');
    requestAnimationFrame(render);
    if (Account.pendingError) setTimeout(() => toast('❌ ' + Account.pendingError, 'kill'), 600);
    if (Account.justLoggedIn) {
        setPhoto('account');
        setTimeout(() => toast('✅ Connecté ! Ta photo de profil sert de skin 📸', 'gold'), 1200);
    }

    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
        navigator.serviceWorker.register('sw.js').catch(() => { /* PWA optionnelle */ });
    }
    console.log('%c🐍 Mich Snake — by michben', 'color:#ffd700;font-weight:bold;font-size:14px');
})();
