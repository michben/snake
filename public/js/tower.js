/*
 * Tour des Défis — missions variées par étage + skins à débloquer
 * Progression sauvegardée dans localStorage.
 */
(function (root) {
    'use strict';

    const store = {
        get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
        set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } }
    };

    // Étages écrits à la main, puis génération procédurale au-delà
    const FLOORS = [
        { type: 'score', target: 500 },
        { type: 'kills', target: 1 },
        { type: 'orbs', target: 50, window: 60 },
        { type: 'survive', target: 120 },
        { type: 'score', target: 1500 },
        { type: 'kills', target: 2 },
        { type: 'rank', target: 3 },
        { type: 'orbs', target: 120, window: 90 },
        { type: 'score', target: 3000 },
        { type: 'kills', target: 3 },
        { type: 'survive', target: 300 },
        { type: 'rank', target: 1 },
        { type: 'score', target: 5000 },
        { type: 'kills', target: 5 },
        { type: 'orbs', target: 250, window: 120 },
        { type: 'score', target: 8000 }
    ];
    const CYCLE = ['score', 'kills', 'orbs', 'survive', 'rank'];

    function missionFor(floor) {
        if (floor <= FLOORS.length) return Object.assign({}, FLOORS[floor - 1]);
        const extra = floor - FLOORS.length;
        const type = CYCLE[(extra - 1) % CYCLE.length];
        const lvl = Math.ceil(extra / CYCLE.length);
        switch (type) {
            case 'score': return { type, target: 8000 + lvl * 2500 };
            case 'kills': return { type, target: 5 + lvl * 2 };
            case 'orbs': return { type, target: 250 + lvl * 60, window: 120 };
            case 'survive': return { type, target: 300 + lvl * 120 };
            default: return { type: 'rank', target: 1 };
        }
    }

    function fmtTime(s) {
        s = Math.max(0, Math.floor(s));
        const m = Math.floor(s / 60), r = s % 60;
        return m ? `${m} min${r ? ' ' + String(r).padStart(2, '0') : ''}` : `${r} s`;
    }

    function describe(m) {
        switch (m.type) {
            case 'score': return `Atteindre un score de ${m.target}`;
            case 'kills': return `Éliminer ${m.target} serpent${m.target > 1 ? 's' : ''} en une partie`;
            case 'orbs': return `Ramasser ${m.target} orbes en moins de ${m.window} s`;
            case 'survive': return `Survivre ${fmtTime(m.target)} sans mourir`;
            case 'rank': return m.target === 1 ? 'Prendre la 1re place du classement' : `Entrer dans le top ${m.target} du classement`;
        }
        return '';
    }

    function rewardFor(floor) {
        const Core = root.SnakeCore;
        for (const key in Core.SKINS) if (Core.SKINS[key].unlock === floor + 1) return key;
        return null;
    }

    const Tower = {
        floor: parseInt(store.get('snake_tower_floor', '1'), 10) || 1,
        mission: null,
        base: null,
        orbLog: [],
        lastOrbs: 0,
        onComplete: null,

        init() { this.mission = missionFor(this.floor); },

        isUnlocked(skinKey) {
            const s = root.SnakeCore.SKINS[skinKey];
            if (s && s.quest) return (root.SnakeQuests ? root.SnakeQuests.daysDone : 0) >= s.quest;
            return !!s && s.unlock <= this.floor;
        },

        describe() { return describe(this.mission); },

        nextRewardText() {
            const Core = root.SnakeCore;
            let next = null;
            for (const key in Core.SKINS) {
                const s = Core.SKINS[key];
                if (s.unlock > this.floor && (!next || s.unlock < Core.SKINS[next].unlock)) next = key;
            }
            if (!next) return 'Tous les skins sont débloqués 🎉';
            const s = Core.SKINS[next];
            const now = rewardFor(this.floor) === next;
            return now ? `Récompense de cet étage : skin <b>${s.name}</b>`
                : `Prochain skin : <b>${s.name}</b> (après l'étage ${s.unlock - 1})`;
        },

        // Appelé au début de chaque vie et à chaque nouvel étage
        startRun(me) {
            this.base = me ? { kills: me.kills, alive: me.alive } : null;
            this.orbLog = [];
            this.lastOrbs = me ? me.orbs : 0;
        },

        // Progression 0..1 et libellé, à partir des stats du joueur (`me` du snapshot)
        progress(me, nowMs) {
            const m = this.mission;
            if (!me) return { pct: 0, label: '' };
            if (!this.base) this.startRun(me);
            switch (m.type) {
                case 'score':
                    return { pct: me.score / m.target, label: `${me.score} / ${m.target}` };
                case 'kills': {
                    const k = me.kills - this.base.kills;
                    return { pct: k / m.target, label: `${k} / ${m.target}` };
                }
                case 'orbs': {
                    if (me.orbs > this.lastOrbs) this.orbLog.push({ t: nowMs, n: me.orbs - this.lastOrbs });
                    this.lastOrbs = me.orbs;
                    const since = nowMs - m.window * 1000;
                    while (this.orbLog.length && this.orbLog[0].t < since) this.orbLog.shift();
                    let n = 0;
                    for (const e of this.orbLog) n += e.n;
                    return { pct: n / m.target, label: `${n} / ${m.target} (fenêtre ${m.window} s)` };
                }
                case 'survive': {
                    const t = me.alive - this.base.alive;
                    return { pct: t / m.target, label: `${fmtTime(t)} / ${fmtTime(m.target)}` };
                }
                case 'rank':
                    return { pct: me.rank <= m.target ? 1 : Math.min(0.95, m.target / me.rank), label: `Rang actuel : #${me.rank}` };
            }
            return { pct: 0, label: '' };
        },

        // Vérifie la mission ; renvoie la progression et déclenche onComplete si réussie
        update(me, nowMs) {
            const p = this.progress(me, nowMs);
            if (p.pct >= 1) {
                const done = this.floor;
                const reward = rewardFor(done);
                this.floor++;
                store.set('snake_tower_floor', this.floor);
                this.mission = missionFor(this.floor);
                this.startRun(me);
                if (this.onComplete) this.onComplete(done, reward);
                return this.progress(me, nowMs);
            }
            return p;
        }
    };

    Tower.init();
    root.Tower = Tower;
    root.SnakeStore = store;
})(window);
