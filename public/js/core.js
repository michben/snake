/*
 * Mich Snake — moteur de jeu partagé
 *
 * Ce fichier tourne à la fois côté serveur (Node, via require) et dans le
 * navigateur (window.SnakeCore) pour le mode hors-ligne. Toute la physique,
 * l'IA des bots et la génération des snapshots réseau vivent ici, ce qui
 * garantit un comportement identique en ligne et hors-ligne.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.SnakeCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const CONFIG = {
        ARENA_SIZE: 4000,
        TICK_RATE: 30,
        INITIAL_LENGTH: 15,
        INITIAL_SCORE: 100,
        SEGMENT_DISTANCE: 9,
        MAX_SEGMENTS: 700,
        BASE_SPEED: 5.5,
        BOOST_SPEED: 10,
        BOOST_COST: 0.7,
        MIN_BOOST_SCORE: 120,
        TURN_RATE: 0.2,
        MAX_FOOD: 600,
        FOOD_HARD_CAP: 1600,
        MAGNET_RANGE: 45,
        BOT_RESPAWN_TICKS: 60,
        DENSITY_GRID: 16,
        MAX_CHESTS: 5,
        MAX_POWERUPS: 8,
        ITEM_SPAWN_CHANCE: 1 / 90,   // chance par tick qu'un bonus manquant réapparaisse
        CHEST_GOLD_MIN: 150,
        CHEST_GOLD_MAX: 400
    };

    // Bonus d'amélioration : durée en secondes, rendu (icône / couleur) côté client
    const POWERUPS = {
        magnet: { name: 'Super-aimant', icon: '🧲', color: '#ff3df0', duration: 12 },
        speed:  { name: 'Turbo gratuit', icon: '⚡', color: '#ffe600', duration: 8 },
        shield: { name: 'Bouclier',      icon: '🛡️', color: '#4dd2ff', duration: 8 },
        double: { name: 'Score x2',      icon: '💎', color: '#39ff14', duration: 15 }
    };
    const POWERUP_KEYS = Object.keys(POWERUPS);

    // Couleurs de nourriture "naturelle"
    const FOOD_COLORS = ['#ff0055', '#00ffcc', '#ffcc00', '#aa00ff', '#00ff44', '#00aaff', '#ff7a00'];

    // Catalogue des skins emoji. `unlock` = étage de la Tour des Défis qui débloque le skin
    // (0 = disponible dès le départ). `color` sert au halo, à la minimap et aux restes du serpent.
    const SKINS = {
        neon:    { name: 'Serpent',     emoji: '🐍', color: '#39d353', unlock: 0 },
        fire:    { name: 'Feu',         emoji: '🔥', color: '#ff5a00', unlock: 0 },
        gold:    { name: 'Étoile',      emoji: '⭐', color: '#ffd700', unlock: 0 },
        cyber:   { name: 'Alien',       emoji: '👾', color: '#b44dff', unlock: 0 },
        toxic:   { name: 'Grenouille',  emoji: '🐸', color: '#39ff14', unlock: 0 },
        ice:     { name: 'Flocon',      emoji: '❄️', color: '#7fdcff', unlock: 3 },
        lava:    { name: 'Volcan',      emoji: '🌋', color: '#ff3c00', unlock: 5 },
        galaxy:  { name: 'Planète',     emoji: '🪐', color: '#b49cff', unlock: 8 },
        michben: { name: 'Couronne',    emoji: '👑', color: '#ffcc33', unlock: 10 },
        shadow:  { name: 'Crâne',       emoji: '💀', color: '#e6e6f0', unlock: 13 },
        rainbow: { name: 'Arc-en-ciel', emoji: '🌈', color: '#ff66cc', unlock: 16 }
    };

    const BOT_NAMES = ['Viper_FR', 'Cobrakai', 'Kaa', 'Orochimaru', 'SnackAttack', 'SlitherKing',
        'Nagini', 'PythonDev', 'Mamba', 'Boa_Boss', 'Anaconda', 'Sidewinder', 'Basilic', 'Ouroboros'];

    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
    function angleDiff(a, b) {
        let d = b - a;
        while (d < -Math.PI) d += Math.PI * 2;
        while (d > Math.PI) d -= Math.PI * 2;
        return d;
    }

    function radiusForScore(score) { return Math.min(30, 13 + Math.floor(score / 250)); }
    function lengthForScore(score) {
        return clamp(CONFIG.INITIAL_LENGTH + Math.floor((score - CONFIG.INITIAL_SCORE) / 12), CONFIG.INITIAL_LENGTH, CONFIG.MAX_SEGMENTS);
    }

    class World {
        constructor(opts = {}) {
            this.size = opts.arenaSize || CONFIG.ARENA_SIZE;
            this.botCount = opts.botCount !== undefined ? opts.botCount : 10;
            this.snakes = {};
            this.foods = [];
            this.tick = 0;
            this.nextFoodId = 1;
            this.events = [];          // événements du tick (morts, kills) consommés par l'hôte
            this.pendingBots = [];     // { id, name, skin, at }
            this.densityCache = null;
            this.items = [];           // coffres et bonus d'amélioration { id, type: 'chest' | 'power', kind, x, y }
            this.nextItemId = 1;
            for (let i = 0; i < CONFIG.MAX_FOOD; i++) this.foods.push(this.createFood());
            for (let i = 0; i < CONFIG.MAX_CHESTS; i++) this.spawnItem('chest');
            for (let i = 0; i < CONFIG.MAX_POWERUPS; i++) this.spawnItem('power');
            const skinKeys = Object.keys(SKINS);
            for (let i = 0; i < this.botCount; i++) {
                const id = 'bot_' + i;
                this.addSnake(id, BOT_NAMES[i % BOT_NAMES.length], skinKeys[i % skinKeys.length], true);
            }
        }

        createFood(x, y, value = 1, color = null) {
            const m = 50;
            return {
                id: this.nextFoodId++,
                x: x !== undefined ? clamp(x, 10, this.size - 10) : Math.random() * (this.size - 2 * m) + m,
                y: y !== undefined ? clamp(y, 10, this.size - 10) : Math.random() * (this.size - 2 * m) + m,
                value,
                radius: value > 1 ? 9 : value === 1 && color ? 4 : 5,
                color: color || FOOD_COLORS[Math.floor(Math.random() * FOOD_COLORS.length)]
            };
        }

        spawnItem(type) {
            const m = 250;
            this.items.push({
                id: this.nextItemId++,
                type,
                kind: type === 'power' ? POWERUP_KEYS[Math.floor(Math.random() * POWERUP_KEYS.length)] : null,
                x: Math.random() * (this.size - 2 * m) + m,
                y: Math.random() * (this.size - 2 * m) + m
            });
        }

        countItems(type) {
            let n = 0;
            for (const it of this.items) if (it.type === type) n++;
            return n;
        }

        hasPower(s, kind) { return (s.powers[kind] || 0) > this.tick; }

        grantPower(s, kind) {
            s.powers[kind] = Math.max(s.powers[kind] || 0, this.tick) + POWERUPS[kind].duration * CONFIG.TICK_RATE;
            this.events.push({ type: 'power', id: s.id, kind });
        }

        // Ouverture d'un coffre : trésor de points + gerbe d'orbes dorées, parfois un bonus en prime
        openChest(s, it) {
            let gold = CONFIG.CHEST_GOLD_MIN + Math.floor(Math.random() * (CONFIG.CHEST_GOLD_MAX - CONFIG.CHEST_GOLD_MIN));
            if (this.hasPower(s, 'double')) gold *= 2;
            s.score += gold;
            for (let i = 0; i < 12 && this.foods.length < CONFIG.FOOD_HARD_CAP; i++) {
                const a = (i / 12) * Math.PI * 2;
                this.foods.push(this.createFood(it.x + Math.cos(a) * 45, it.y + Math.sin(a) * 45, 2, '#ffd700'));
            }
            const power = Math.random() < 0.4 ? POWERUP_KEYS[Math.floor(Math.random() * POWERUP_KEYS.length)] : null;
            this.events.push({ type: 'chest', id: s.id, gold, power });
            if (power) this.grantPower(s, power);
        }

        // Cherche un point d'apparition loin des autres serpents
        findSpawn() {
            let best = null, bestDist = -1;
            for (let tries = 0; tries < 12; tries++) {
                const x = Math.random() * (this.size - 800) + 400;
                const y = Math.random() * (this.size - 800) + 400;
                let minD = Infinity;
                for (const id in this.snakes) {
                    const s = this.snakes[id];
                    for (let i = 0; i < s.segments.length; i += 4) {
                        const d = Math.hypot(s.segments[i].x - x, s.segments[i].y - y);
                        if (d < minD) minD = d;
                    }
                }
                if (minD > 500) return { x, y };
                if (minD > bestDist) { bestDist = minD; best = { x, y }; }
            }
            return best;
        }

        addSnake(id, name, skinKey, isBot = false) {
            const { x, y } = this.findSpawn();
            const angle = Math.atan2(this.size / 2 - y, this.size / 2 - x);
            const segments = [];
            for (let i = 0; i < CONFIG.INITIAL_LENGTH; i++) {
                segments.push({ x: x - Math.cos(angle) * i * CONFIG.SEGMENT_DISTANCE, y: y - Math.sin(angle) * i * CONFIG.SEGMENT_DISTANCE });
            }
            const snake = {
                id,
                name: String(name || 'Anonyme').substring(0, 14),
                skin: SKINS[skinKey] ? skinKey : 'neon',
                isBot,
                x, y,
                angle,
                targetAngle: angle,
                speed: CONFIG.BASE_SPEED,
                boosting: false,
                wantBoost: false,
                score: CONFIG.INITIAL_SCORE,
                radius: radiusForScore(CONFIG.INITIAL_SCORE),
                segments,
                kills: 0,
                orbs: 0,
                powers: {},            // bonus actifs : kind -> tick de fin
                bornTick: this.tick,
                ai: isBot ? { think: 0, target: null, aggression: 0.3 + Math.random() * 0.7 } : null
            };
            this.snakes[id] = snake;
            return snake;
        }

        removeSnake(id) { delete this.snakes[id]; }

        setInput(id, angle, boosting) {
            const s = this.snakes[id];
            if (!s || typeof angle !== 'number' || !isFinite(angle)) return;
            s.targetAngle = angle;
            s.wantBoost = !!boosting;
        }

        killSnake(id, killerId) {
            const s = this.snakes[id];
            if (!s) return;
            const color = SKINS[s.skin].color;
            const value = s.score > 1500 ? 4 : 3;
            for (let i = 0; i < s.segments.length; i += 2) {
                if (this.foods.length >= CONFIG.FOOD_HARD_CAP) break;
                const seg = s.segments[i];
                this.foods.push(this.createFood(seg.x + (Math.random() * 24 - 12), seg.y + (Math.random() * 24 - 12), value, color));
            }
            const killer = killerId ? this.snakes[killerId] : null;
            if (killer) { killer.kills++; killer.score += 50; }
            this.events.push({
                type: 'death', id, name: s.name, killerId: killer ? killer.id : null, killerName: killer ? killer.name : null,
                score: Math.floor(s.score), kills: s.kills, orbs: s.orbs,
                aliveSeconds: Math.floor((this.tick - s.bornTick) / CONFIG.TICK_RATE), isBot: s.isBot, x: s.x, y: s.y
            });
            delete this.snakes[id];
            if (s.isBot) this.pendingBots.push({ id, name: s.name, skin: s.skin, at: this.tick + CONFIG.BOT_RESPAWN_TICKS });
        }

        // --- IA des bots : chercher la nourriture, éviter les corps et les murs, chasser parfois ---
        thinkBot(s) {
            const ai = s.ai;
            if (--ai.think > 0) return;
            ai.think = 3 + Math.floor(Math.random() * 3);

            // 1. Danger : murs
            const wallMargin = 220 + s.radius * 4;
            if (s.x < wallMargin || s.x > this.size - wallMargin || s.y < wallMargin || s.y > this.size - wallMargin) {
                s.targetAngle = Math.atan2(this.size / 2 - s.y, this.size / 2 - s.x) + (Math.random() - 0.5) * 0.6;
                s.wantBoost = false;
                return;
            }

            // 2. Danger : corps devant (sondes à gauche / centre / droite)
            const probeLen = 90 + s.radius * 3;
            const probes = [-0.5, 0, 0.5];
            const danger = [0, 0, 0];
            for (const id in this.snakes) {
                if (id === s.id) continue;
                const o = this.snakes[id];
                // Éliminer rapidement les serpents lointains
                if (Math.abs(o.x - s.x) > 900 + o.segments.length * CONFIG.SEGMENT_DISTANCE &&
                    Math.abs(o.y - s.y) > 900 + o.segments.length * CONFIG.SEGMENT_DISTANCE) continue;
                for (let p = 0; p < 3; p++) {
                    const a = s.angle + probes[p];
                    const px = s.x + Math.cos(a) * probeLen, py = s.y + Math.sin(a) * probeLen;
                    const mx = s.x + Math.cos(a) * probeLen * 0.5, my = s.y + Math.sin(a) * probeLen * 0.5;
                    for (let i = 0; i < o.segments.length; i += 2) {
                        const g = o.segments[i];
                        const r = o.radius + s.radius + 8;
                        if (Math.abs(g.x - px) < r && Math.abs(g.y - py) < r) danger[p] += 1;
                        if (Math.abs(g.x - mx) < r && Math.abs(g.y - my) < r) danger[p] += 2;
                    }
                }
            }
            if (danger[0] + danger[1] + danger[2] > 0) {
                const turn = danger[0] < danger[2] ? -1.2 : 1.2;
                s.targetAngle = s.angle + (danger[1] > 0 ? turn : turn * 0.5);
                s.wantBoost = s.score > 300 && danger[1] > 2 && Math.random() < 0.3;
                return;
            }

            // 3. Chasse : couper la route d'un serpent plus petit proche
            if (s.score > 400 && Math.random() < ai.aggression * 0.25) {
                let prey = null, preyD = 600;
                for (const id in this.snakes) {
                    if (id === s.id) continue;
                    const o = this.snakes[id];
                    if (o.score * 1.3 > s.score) continue;
                    const d = Math.hypot(o.x - s.x, o.y - s.y);
                    if (d < preyD) { preyD = d; prey = o; }
                }
                if (prey) {
                    const lead = 80;
                    s.targetAngle = Math.atan2(prey.y + Math.sin(prey.angle) * lead - s.y, prey.x + Math.cos(prey.angle) * lead - s.x);
                    s.wantBoost = preyD < 350 && s.score > 250;
                    return;
                }
            }

            // 4. Nourriture : la meilleure valeur / distance dans un rayon
            let best = null, bestScore = 0;
            for (let i = 0; i < this.foods.length; i++) {
                const f = this.foods[i];
                const dx = f.x - s.x, dy = f.y - s.y;
                if (dx > 500 || dx < -500 || dy > 500 || dy < -500) continue;
                const d = Math.hypot(dx, dy) + 20;
                const frontBonus = Math.cos(angleDiff(s.angle, Math.atan2(dy, dx))) + 1.5;
                const v = (f.value * frontBonus) / d;
                if (v > bestScore) { bestScore = v; best = f; }
            }
            for (const it of this.items) {
                const dx = it.x - s.x, dy = it.y - s.y;
                if (dx > 500 || dx < -500 || dy > 500 || dy < -500) continue;
                const d = Math.hypot(dx, dy) + 20;
                const v = ((it.type === 'chest' ? 14 : 9) * (Math.cos(angleDiff(s.angle, Math.atan2(dy, dx))) + 1.5)) / d;
                if (v > bestScore) { bestScore = v; best = it; }
            }
            if (best) {
                s.targetAngle = Math.atan2(best.y - s.y, best.x - s.x);
            } else if (Math.random() < 0.3) {
                s.targetAngle += (Math.random() - 0.5) * 1.2;
            }
            s.wantBoost = false;
        }

        step() {
            this.tick++;
            this.densityCache = null;

            // Réapparition des bots
            for (let i = this.pendingBots.length - 1; i >= 0; i--) {
                const b = this.pendingBots[i];
                if (b.at <= this.tick) {
                    this.pendingBots.splice(i, 1);
                    this.addSnake(b.id, b.name, b.skin, true);
                }
            }

            const ids = Object.keys(this.snakes);

            // 1. Déplacement
            for (const id of ids) {
                const s = this.snakes[id];
                if (s.isBot) this.thinkBot(s);

                // Les gros serpents tournent un peu moins vite
                const turnRate = CONFIG.TURN_RATE * (1 - Math.min(0.45, (s.radius - 13) / 40));
                s.angle += angleDiff(s.angle, s.targetAngle) * turnRate;

                // Bonus expirés
                for (const k in s.powers) {
                    if (s.powers[k] <= this.tick) {
                        delete s.powers[k];
                        this.events.push({ type: 'powerEnd', id: s.id, kind: k });
                    }
                }

                // Turbo gratuit : boost sans coût ni score minimum
                const freeBoost = this.hasPower(s, 'speed');
                s.boosting = s.wantBoost && (freeBoost || s.score > CONFIG.MIN_BOOST_SCORE);
                if (s.boosting) {
                    s.speed = CONFIG.BOOST_SPEED;
                    if (!freeBoost) s.score -= CONFIG.BOOST_COST;
                    if (!freeBoost && this.tick % 4 === 0 && this.foods.length < CONFIG.FOOD_HARD_CAP) {
                        const tail = s.segments[s.segments.length - 1];
                        this.foods.push(this.createFood(tail.x, tail.y, 1, SKINS[s.skin].color));
                    }
                } else {
                    s.speed = CONFIG.BASE_SPEED;
                }

                s.x += Math.cos(s.angle) * s.speed;
                s.y += Math.sin(s.angle) * s.speed;

                // Bouclier : rebond sur la bordure au lieu de mourir
                if (this.hasPower(s, 'shield') && (s.x < 0 || s.x > this.size || s.y < 0 || s.y > this.size)) {
                    if (s.x < 0 || s.x > this.size) s.angle = Math.PI - s.angle;
                    if (s.y < 0 || s.y > this.size) s.angle = -s.angle;
                    s.targetAngle = s.angle;
                    s.x = clamp(s.x, 1, this.size - 1);
                    s.y = clamp(s.y, 1, this.size - 1);
                }

                s.radius = radiusForScore(s.score);
                const targetLength = lengthForScore(s.score);

                // Corps : chaîne à espacement constant (rendu bien plus propre que l'historique de positions)
                const segs = s.segments;
                segs[0].x = s.x; segs[0].y = s.y;
                const spacing = CONFIG.SEGMENT_DISTANCE;
                for (let i = 1; i < segs.length; i++) {
                    const a = segs[i - 1], b = segs[i];
                    const dx = b.x - a.x, dy = b.y - a.y;
                    const d = Math.hypot(dx, dy);
                    if (d > spacing) {
                        b.x = a.x + (dx / d) * spacing;
                        b.y = a.y + (dy / d) * spacing;
                    }
                }
                while (segs.length < targetLength) {
                    const t = segs[segs.length - 1];
                    segs.push({ x: t.x, y: t.y });
                }
                if (segs.length > targetLength) segs.length = targetLength;
            }

            // 2. Nourriture (aimant + ingestion)
            for (const id of ids) {
                const s = this.snakes[id];
                const eatR = s.radius + 6;
                const magR = s.radius + CONFIG.MAGNET_RANGE * (this.hasPower(s, 'magnet') ? 4 : 1);
                const mult = this.hasPower(s, 'double') ? 2 : 1;
                for (let i = this.foods.length - 1; i >= 0; i--) {
                    const f = this.foods[i];
                    const dx = s.x - f.x, dy = s.y - f.y;
                    if (dx > magR || dx < -magR || dy > magR || dy < -magR) continue;
                    const d = Math.hypot(dx, dy);
                    if (d < eatR + f.radius) {
                        s.score += f.value * 8 * mult;
                        s.orbs++;
                        this.foods[i] = this.foods[this.foods.length - 1];
                        this.foods.pop();
                    } else if (d < magR) {
                        const pull = Math.min(d, 4 + s.speed * 0.5);
                        f.x += (dx / d) * pull;
                        f.y += (dy / d) * pull;
                    }
                }
            }
            while (this.foods.length < CONFIG.MAX_FOOD) this.foods.push(this.createFood());

            // 2 bis. Coffres et bonus d'amélioration
            for (const id of ids) {
                const s = this.snakes[id];
                for (let i = this.items.length - 1; i >= 0; i--) {
                    const it = this.items[i];
                    const r = s.radius + (it.type === 'chest' ? 20 : 16);
                    const dx = s.x - it.x, dy = s.y - it.y;
                    if (dx > r || dx < -r || dy > r || dy < -r || dx * dx + dy * dy > r * r) continue;
                    this.items.splice(i, 1);
                    if (it.type === 'chest') this.openChest(s, it);
                    else this.grantPower(s, it.kind);
                }
            }
            if (this.countItems('chest') < CONFIG.MAX_CHESTS && Math.random() < CONFIG.ITEM_SPAWN_CHANCE) this.spawnItem('chest');
            if (this.countItems('power') < CONFIG.MAX_POWERUPS && Math.random() < CONFIG.ITEM_SPAWN_CHANCE * 1.5) this.spawnItem('power');

            // 3. Collisions (murs, corps des autres)
            const deaths = [];
            for (const id of ids) {
                const s = this.snakes[id];
                if (s.x < 0 || s.x > this.size || s.y < 0 || s.y > this.size) {
                    deaths.push([id, null]);
                    continue;
                }
                // Bouclier : traverse les corps sans mourir
                if (this.hasPower(s, 'shield')) continue;
                for (const oid of ids) {
                    if (oid === id) continue;
                    const o = this.snakes[oid];
                    const reach = o.segments.length * CONFIG.SEGMENT_DISTANCE + o.radius + s.radius;
                    if (Math.abs(o.x - s.x) > reach || Math.abs(o.y - s.y) > reach) continue;
                    const hitR = s.radius + o.radius - 4;
                    let hit = false;
                    for (let i = 0; i < o.segments.length; i++) {
                        const g = o.segments[i];
                        const dx = s.x - g.x, dy = s.y - g.y;
                        if (dx > hitR || dx < -hitR || dy > hitR || dy < -hitR) continue;
                        if (dx * dx + dy * dy < hitR * hitR) { hit = true; break; }
                    }
                    if (hit) {
                        // Tête contre tête : le plus petit meurt
                        const headToHead = Math.hypot(s.x - o.x, s.y - o.y) < hitR;
                        if (headToHead && s.score > o.score) continue;
                        deaths.push([id, oid]);
                        break;
                    }
                }
            }
            for (const [id, killer] of deaths) this.killSnake(id, killer);
        }

        // Secondes restantes de chaque bonus actif
        powersLeft(s) {
            const out = {};
            for (const k in s.powers) {
                const left = (s.powers[k] - this.tick) / CONFIG.TICK_RATE;
                if (left > 0) out[k] = Math.ceil(left);
            }
            return out;
        }

        drainEvents() { const e = this.events; this.events = []; return e; }

        leaderboard(limit = 10) {
            return Object.values(this.snakes)
                .sort((a, b) => b.score - a.score)
                .slice(0, limit)
                .map(s => [s.id, s.name, Math.floor(s.score), Math.round(s.x), Math.round(s.y)]);
        }

        // Grille de densité de nourriture pour la minimap (valeurs 0..255)
        density() {
            if (this.densityCache) return this.densityCache;
            const n = CONFIG.DENSITY_GRID, cell = this.size / n;
            const grid = new Array(n * n).fill(0);
            for (const f of this.foods) {
                const gx = clamp(Math.floor(f.x / cell), 0, n - 1), gy = clamp(Math.floor(f.y / cell), 0, n - 1);
                grid[gy * n + gx] += f.value;
            }
            let max = 1;
            for (const v of grid) if (v > max) max = v;
            this.densityCache = grid.map(v => Math.round((v / max) * 255));
            return this.densityCache;
        }

        /*
         * Snapshot culled pour un joueur : seules les entités dans son champ de
         * vision élargi (view = {x, y, w, h} en unités monde) sont envoyées.
         */
        snapshotFor(meId, view, withDensity) {
            const margin = 200;
            const x0 = view.x - view.w / 2 - margin, x1 = view.x + view.w / 2 + margin;
            const y0 = view.y - view.h / 2 - margin, y1 = view.y + view.h / 2 + margin;

            const snakes = [];
            for (const id in this.snakes) {
                const s = this.snakes[id];
                const segs = s.segments;
                let visible = id === meId;
                if (!visible) {
                    for (let i = 0; i < segs.length; i += 3) {
                        const g = segs[i];
                        if (g.x > x0 && g.x < x1 && g.y > y0 && g.y < y1) { visible = true; break; }
                    }
                }
                if (!visible) continue;
                const flat = new Array(segs.length * 2);
                for (let i = 0; i < segs.length; i++) {
                    flat[i * 2] = Math.round(segs[i].x);
                    flat[i * 2 + 1] = Math.round(segs[i].y);
                }
                snakes.push({
                    id: s.id, n: s.name, k: s.skin, a: Math.round(s.angle * 100) / 100,
                    r: s.radius, b: s.boosting ? 1 : 0, sc: Math.floor(s.score), g: flat,
                    p: this.hasPower(s, 'shield') ? 1 : 0
                });
            }

            const foods = [];
            for (const f of this.foods) {
                if (f.x > x0 && f.x < x1 && f.y > y0 && f.y < y1) {
                    foods.push([f.id, Math.round(f.x), Math.round(f.y), f.radius, f.color]);
                }
            }

            const items = [];
            for (const it of this.items) {
                if (it.x > x0 && it.x < x1 && it.y > y0 && it.y < y1) {
                    items.push([it.id, Math.round(it.x), Math.round(it.y), it.type === 'chest' ? 0 : 1, it.kind]);
                }
            }

            const me = this.snakes[meId];
            const lb = this.leaderboard(10);
            let rank = 0;
            if (me) {
                rank = 1;
                for (const id in this.snakes) if (this.snakes[id].score > me.score) rank++;
            }
            const snap = {
                t: this.tick,
                s: snakes,
                f: foods,
                it: items,
                lb,
                n: Object.keys(this.snakes).length,
                me: me ? {
                    score: Math.floor(me.score), kills: me.kills, orbs: me.orbs, rank,
                    alive: Math.floor((this.tick - me.bornTick) / CONFIG.TICK_RATE), x: me.x, y: me.y, r: me.radius,
                    pw: this.powersLeft(me)
                } : null
            };
            if (withDensity) {
                snap.d = this.density();
                snap.ch = this.items.filter(it => it.type === 'chest').map(it => [Math.round(it.x), Math.round(it.y)]);
            }
            return snap;
        }
    }

    return { CONFIG, SKINS, POWERUPS, FOOD_COLORS, BOT_NAMES, World, clamp, angleDiff };
});
