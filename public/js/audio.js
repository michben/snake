/*
 * Mich Snake — audio : bruitages synthétisés (Web Audio) + deux musiques
 * personnalisables (présentation / en partie).
 *
 * Les bruitages sont générés à la volée : aucun fichier à télécharger.
 * Les musiques viennent soit du serveur (console admin, pour tous les joueurs),
 * soit de l'appareil (IndexedDB, quand on joue sans serveur).
 */
(function (root) {
    'use strict';

    const store = root.SnakeStore;
    const SLOTS = ['menu', 'game'];

    const settings = {
        music: parseFloat(store.get('snake_vol_music', '0.6')),
        sfx: parseFloat(store.get('snake_vol_sfx', '0.8')),
        muted: store.get('snake_muted', '0') === '1'
    };
    if (!isFinite(settings.music)) settings.music = 0.6;
    if (!isFinite(settings.sfx)) settings.sfx = 0.8;

    let ctx = null, sfxBus = null, noiseBuf = null;
    let boostNode = null;
    let lastEatAt = 0, eatCombo = 0;

    function ensureCtx() {
        if (ctx) return ctx;
        const AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        sfxBus = ctx.createGain();
        const comp = ctx.createDynamicsCompressor();
        sfxBus.connect(comp).connect(ctx.destination);
        applyVolumes();
        // Bruit blanc réutilisé par les effets « souffle » (boost, coffre, impact)
        noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        return ctx;
    }

    function applyVolumes() {
        if (sfxBus) sfxBus.gain.value = settings.muted ? 0 : settings.sfx * 0.9;
        for (const slot of SLOTS) {
            const t = music.tracks[slot];
            if (t.el) t.el.volume = settings.muted ? 0 : settings.music * t.fade;
        }
    }

    // ---------- Briques de synthèse ----------
    function tone(freq, dur, opts = {}) {
        if (!ctx) return;
        const t0 = ctx.currentTime + (opts.delay || 0);
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = opts.type || 'sine';
        osc.frequency.setValueAtTime(freq, t0);
        if (opts.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slide), t0 + dur);
        if (opts.detune) osc.detune.value = opts.detune;
        const vol = opts.vol !== undefined ? opts.vol : 0.25;
        const att = opts.attack || 0.005;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(vol, t0 + att);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g).connect(sfxBus);
        osc.start(t0);
        osc.stop(t0 + dur + 0.05);
    }

    function noise(dur, opts = {}) {
        if (!ctx) return null;
        const t0 = ctx.currentTime + (opts.delay || 0);
        const src = ctx.createBufferSource();
        src.buffer = noiseBuf;
        src.loop = true;
        const f = ctx.createBiquadFilter();
        f.type = opts.filter || 'bandpass';
        f.frequency.setValueAtTime(opts.freq || 1000, t0);
        if (opts.sweep) f.frequency.exponentialRampToValueAtTime(opts.sweep, t0 + dur);
        f.Q.value = opts.q || 1;
        const g = ctx.createGain();
        const vol = opts.vol !== undefined ? opts.vol : 0.2;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(vol, t0 + (opts.attack || 0.01));
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        src.connect(f).connect(g).connect(sfxBus);
        src.start(t0);
        src.stop(t0 + dur + 0.05);
        return src;
    }

    function arp(freqs, step, opts) {
        freqs.forEach((f, i) => tone(f, opts.dur || 0.18, Object.assign({}, opts, { delay: (opts.delay || 0) + i * step })));
    }

    // ---------- Catalogue des bruitages ----------
    const SFX = {
        // Orbe mangée : petit « blip » dont la hauteur monte quand on enchaîne
        eat() {
            const now = performance.now();
            if (now - lastEatAt < 45) return;
            eatCombo = now - lastEatAt < 450 ? Math.min(eatCombo + 1, 14) : 0;
            lastEatAt = now;
            const f = 520 * Math.pow(2, eatCombo / 12);
            tone(f, 0.07, { type: 'sine', vol: 0.12, slide: f * 1.5 });
        },
        boost() {
            noise(0.3, { freq: 400, sweep: 2200, q: 2, vol: 0.18 });
            tone(140, 0.25, { type: 'sawtooth', vol: 0.05, slide: 320 });
        },
        kill() {
            noise(0.18, { filter: 'lowpass', freq: 1800, sweep: 200, vol: 0.35 });
            tone(110, 0.25, { type: 'square', vol: 0.12, slide: 55 });
            arp([523, 659, 784, 1047], 0.06, { type: 'square', vol: 0.08, dur: 0.16, delay: 0.05 });
        },
        gameover() {
            tone(440, 0.9, { type: 'sawtooth', vol: 0.16, slide: 70 });
            noise(0.5, { filter: 'lowpass', freq: 600, sweep: 80, vol: 0.3 });
            arp([392, 330, 262], 0.28, { type: 'triangle', vol: 0.2, dur: 0.38, delay: 0.55 });
            tone(196, 0.9, { type: 'triangle', vol: 0.18, delay: 1.4 });
        },
        chest() {
            noise(0.22, { freq: 320, sweep: 180, q: 6, vol: 0.25 });                 // grincement du couvercle
            tone(988, 0.12, { type: 'square', vol: 0.08, delay: 0.12 });             // pièce
            tone(1319, 0.3, { type: 'square', vol: 0.08, delay: 0.2 });
            arp([1047, 1319, 1568, 2093, 2637], 0.05, { type: 'sine', vol: 0.12, dur: 0.25, delay: 0.3 }); // scintillement
        },
        power(kind) {
            switch (kind) {
                case 'magnet':
                    tone(220, 0.5, { type: 'sine', vol: 0.18, slide: 880 });
                    tone(226, 0.5, { type: 'sine', vol: 0.12, slide: 890 });
                    break;
                case 'speed':
                    noise(0.35, { freq: 600, sweep: 4000, q: 3, vol: 0.18 });
                    arp([440, 660, 880, 1320], 0.04, { type: 'sawtooth', vol: 0.06, dur: 0.12 });
                    break;
                case 'shield':
                    arp([392, 494, 587, 784], 0.07, { type: 'triangle', vol: 0.16, dur: 0.6 });
                    break;
                case 'double':
                    tone(1319, 0.12, { type: 'square', vol: 0.08 });
                    tone(1760, 0.35, { type: 'square', vol: 0.08, delay: 0.09 });
                    break;
                default:
                    arp([523, 784, 1047], 0.06, { type: 'triangle', vol: 0.15, dur: 0.3 });
            }
        },
        powerEnd() {
            arp([660, 440], 0.1, { type: 'triangle', vol: 0.1, dur: 0.18 });
        },
        levelup() {
            arp([523, 659, 784], 0.11, { type: 'square', vol: 0.09, dur: 0.16 });
            tone(1047, 0.6, { type: 'square', vol: 0.1, delay: 0.33 });
            tone(1319, 0.6, { type: 'triangle', vol: 0.1, delay: 0.33 });
        },
        start() {
            tone(262, 0.3, { type: 'triangle', vol: 0.15, slide: 784 });
            noise(0.25, { freq: 800, sweep: 3000, q: 1, vol: 0.08 });
        },
        click() {
            tone(1200, 0.04, { type: 'square', vol: 0.05 });
        }
    };

    // Souffle continu pendant le boost
    function setBoost(on) {
        if (!ctx) return;
        if (on && !boostNode) {
            const src = ctx.createBufferSource();
            src.buffer = noiseBuf; src.loop = true;
            const f = ctx.createBiquadFilter();
            f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.8;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.15);
            src.connect(f).connect(g).connect(sfxBus);
            src.start();
            boostNode = { src, g };
            SFX.boost();
        } else if (!on && boostNode) {
            const { src, g } = boostNode;
            g.gain.cancelScheduledValues(ctx.currentTime);
            g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
            src.stop(ctx.currentTime + 0.25);
            boostNode = null;
        }
    }

    // ---------- Stockage local des musiques (IndexedDB) ----------
    const local = {
        db: null,
        memory: {},     // repli si IndexedDB est indisponible (navigation privée, iframe…)
        open() {
            if (this.db) return Promise.resolve(this.db);
            return new Promise((resolve) => {
                try {
                    const req = indexedDB.open('mich-snake-audio', 1);
                    req.onupgradeneeded = () => req.result.createObjectStore('tracks');
                    req.onsuccess = () => { this.db = req.result; resolve(this.db); };
                    req.onerror = () => resolve(null);
                } catch (e) { resolve(null); }
            });
        },
        async get(slot) {
            const db = await this.open();
            if (!db) return this.memory[slot] || null;
            return new Promise((resolve) => {
                try {
                    const r = db.transaction('tracks').objectStore('tracks').get(slot);
                    r.onsuccess = () => resolve(r.result || null);
                    r.onerror = () => resolve(this.memory[slot] || null);
                } catch (e) { resolve(this.memory[slot] || null); }
            });
        },
        async put(slot, rec) {
            this.memory[slot] = rec;
            const db = await this.open();
            if (!db) return false;
            return new Promise((resolve) => {
                try {
                    const tx = db.transaction('tracks', 'readwrite');
                    if (rec) tx.objectStore('tracks').put(rec, slot); else tx.objectStore('tracks').delete(slot);
                    tx.oncomplete = () => resolve(true);
                    tx.onerror = () => resolve(false);
                } catch (e) { resolve(false); }
            });
        }
    };

    // ---------- Musiques ----------
    const music = {
        scene: null,           // 'menu' | 'game' | null
        server: { menu: null, game: null },   // manifeste renvoyé par le serveur
        base: '',
        tracks: {
            menu: { el: null, src: null, info: null, fade: 0, target: 0 },
            game: { el: null, src: null, info: null, fade: 0, target: 0 }
        }
    };

    // Source effective d'une piste : celle de l'appareil d'abord, sinon celle du serveur
    async function resolveTrack(slot) {
        const t = music.tracks[slot];
        const rec = await local.get(slot);
        let src = null, info = null;
        if (rec && rec.blob) {
            if (t.objectUrl) URL.revokeObjectURL(t.objectUrl);
            t.objectUrl = URL.createObjectURL(rec.blob);
            src = t.objectUrl;
            info = { name: rec.name, source: 'device', size: rec.blob.size };
        } else if (music.server[slot]) {
            const m = music.server[slot];
            src = `${music.base}music/${slot}?v=${m.v}`;
            info = { name: m.name, source: 'server', size: m.size };
        }
        t.info = info;
        if (src === t.src) return;
        t.src = src;
        if (t.el) { t.el.pause(); t.el.removeAttribute('src'); t.el.load(); t.el = null; }
        if (src) {
            const el = new root.Audio();
            el.loop = true;
            el.preload = 'auto';
            el.src = src;
            el.volume = 0;
            t.el = el;
            t.fade = 0;
        }
        updateScene();
    }

    async function refreshTracks() {
        await Promise.all(SLOTS.map(resolveTrack));
        if (API.onTracksChanged) API.onTracksChanged();
    }

    // Fondu enchaîné entre la musique de présentation et celle de la partie
    function updateScene() {
        for (const slot of SLOTS) music.tracks[slot].target = music.scene === slot ? 1 : 0;
    }
    setInterval(() => {
        for (const slot of SLOTS) {
            const t = music.tracks[slot];
            if (!t.el) continue;
            const step = 0.06;
            t.fade += Math.sign(t.target - t.fade) * Math.min(step, Math.abs(t.target - t.fade));
            if (t.fade > 0 && t.el.paused && ctx && ctx.state === 'running') {
                t.el.play().catch(() => { /* lecture bloquée tant qu'il n'y a pas d'interaction */ });
            }
            if (t.fade <= 0 && !t.el.paused) {
                t.el.pause();
                if (t.target === 0 && slot === 'game') t.el.currentTime = 0;   // la musique de partie repart du début
            }
            t.el.volume = settings.muted ? 0 : Math.max(0, Math.min(1, settings.music * t.fade));
        }
    }, 50);

    const API = {
        SLOTS,
        settings,
        onTracksChanged: null,

        // À appeler sur la première interaction : les navigateurs bloquent le son avant
        unlock() {
            const c = ensureCtx();
            if (c && c.state === 'suspended') c.resume();
        },

        play(name, arg) {
            if (!ensureCtx() || settings.muted || !SFX[name]) return;
            if (ctx.state !== 'running') return;
            try { SFX[name](arg); } catch (e) { /* un effet raté ne doit jamais casser le jeu */ }
        },

        setBoost(on) { if (ctx && ctx.state === 'running') setBoost(on && !settings.muted); },

        setScene(scene) { music.scene = scene; updateScene(); },

        // Musique en pause temporaire (game over) puis reprise de la scène voulue
        duck(scene, ms) {
            music.scene = null; updateScene();
            setTimeout(() => { if (music.scene === null) this.setScene(scene); }, ms);
        },

        setVolume(kind, v) {
            settings[kind] = Math.max(0, Math.min(1, v));
            store.set(kind === 'music' ? 'snake_vol_music' : 'snake_vol_sfx', settings[kind]);
            applyVolumes();
        },

        setMuted(m) {
            settings.muted = !!m;
            store.set('snake_muted', settings.muted ? '1' : '0');
            if (settings.muted) setBoost(false);
            applyVolumes();
        },

        // Manifeste des musiques du serveur : { menu: { name, size, v } | null, game: … }
        setServerTracks(manifest, base) {
            music.server = { menu: (manifest && manifest.menu) || null, game: (manifest && manifest.game) || null };
            if (base !== undefined) music.base = base;
            return refreshTracks();
        },

        async setLocalTrack(slot, file) {
            await local.put(slot, file ? { blob: file, name: file.name, type: file.type } : null);
            return refreshTracks();
        },

        trackInfo(slot) { return music.tracks[slot].info; },
        serverInfo(slot) { return music.server[slot]; },

        // Écoute rapide depuis la console admin
        preview(slot) {
            const t = music.tracks[slot];
            if (!t.el) return false;
            this.unlock();
            this.setScene(slot);
            return true;
        },

        refresh: refreshTracks
    };

    refreshTracks();
    root.SnakeAudio = API;
})(window);
