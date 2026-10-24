/*
 * Mich Snake — quêtes du jour.
 * Trois quêtes tirées au sort chaque jour (la même liste pour tout le monde : graine = date),
 * progression gardée sur l'appareil. Réussir les trois débloque des skins (Licorne, Dragon).
 */
(function (root) {
    'use strict';

    const store = root.SnakeStore;

    // `max` : la progression garde la meilleure valeur d'une partie (sinon elle s'additionne)
    const POOL = [
        { type: 'orbs',    icon: '🍬', targets: [150, 250, 400], text: (n) => `Manger ${n} orbes` },
        { type: 'kills',   icon: '⚔️', targets: [3, 5, 8],        text: (n) => `Éliminer ${n} serpents` },
        { type: 'chests',  icon: '🎁', targets: [3, 5, 8],        text: (n) => `Ouvrir ${n} coffres` },
        { type: 'legend',  icon: '👑', targets: [1, 2],           text: (n) => n > 1 ? `Ouvrir ${n} coffres légendaires` : 'Ouvrir un coffre légendaire' },
        { type: 'powers',  icon: '✨', targets: [4, 6, 10],       text: (n) => `Ramasser ${n} pouvoirs` },
        { type: 'score',   icon: '🏆', targets: [1500, 3000, 5000], max: true, text: (n) => `Atteindre ${n} points en une partie` },
        { type: 'survive', icon: '⏱️', targets: [180, 300],       max: true, text: (n) => `Survivre ${n / 60} min en une partie` },
        { type: 'volcan',  icon: '🌋', targets: [2, 3],           text: (n) => `Jouer ${n} parties au Cratère Volcan` },
        { type: 'events',  icon: '🌀', targets: [2, 3],           text: (n) => `Vivre ${n} événements fous` },
        { type: 'boss',    icon: '🐉', targets: [1],              text: () => 'Assister à la chute de l\'Hydre' }
    ];

    const today = () => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };

    // Petit générateur pseudo-aléatoire déterministe (mulberry32)
    function rng(seedStr) {
        let h = 1779033703;
        for (let i = 0; i < seedStr.length; i++) h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353), h = (h << 13) | (h >>> 19);
        return function () {
            h = (h + 0x6D2B79F5) | 0;
            let t = Math.imul(h ^ (h >>> 15), 1 | h);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function questsFor(date) {
        const r = rng('mich-snake-' + date);
        const pool = POOL.slice();
        const out = [];
        while (out.length < 3) {
            const q = pool.splice(Math.floor(r() * pool.length), 1)[0];
            const target = q.targets[Math.floor(r() * q.targets.length)];
            out.push({ type: q.type, icon: q.icon, target, max: !!q.max, text: q.text(target) });
        }
        return out;
    }

    function load() {
        let s = null;
        try { s = JSON.parse(store.get('snake_quests', 'null')); } catch (e) { s = null; }
        const d = today();
        if (!s || s.date !== d) {
            // Série : journées complètes d'affilée
            const yesterday = new Date(Date.now() - 864e5);
            const y = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
            const streak = s && s.complete && s.date === y ? s.streak : 0;
            s = { date: d, prog: {}, done: [], complete: false, streak, days: s ? s.days || 0 : 0 };
        }
        return s;
    }

    const Q = {
        state: load(),
        quests: null,
        onComplete: null,       // (quest) => void
        onDayComplete: null,    // (daysDone) => void

        refresh() {
            const s = load();
            if (s.date !== (this.state && this.state.date)) this.state = s;
            this.quests = questsFor(this.state.date);
            return this;
        },

        get daysDone() { return this.state.days || 0; },
        get streak() { return this.state.streak || 0; },

        list() {
            this.refresh();
            return this.quests.map((q, i) => {
                const v = Math.min(q.target, this.state.prog[q.type] || 0);
                return Object.assign({}, q, { value: v, done: this.state.done.includes(i) });
            });
        },

        // Enregistre un progrès : `amount` s'ajoute, ou remplace s'il est meilleur pour les quêtes "max"
        track(type, amount) {
            this.refresh();
            const i = this.quests.findIndex(q => q.type === type);
            if (i < 0 || this.state.done.includes(i)) return;
            const q = this.quests[i];
            const cur = this.state.prog[type] || 0;
            const next = q.max ? Math.max(cur, amount) : cur + amount;
            if (next === cur) return;
            this.state.prog[type] = next;
            if (next >= q.target) {
                this.state.done.push(i);
                if (this.onComplete) this.onComplete(q);
                if (this.state.done.length === this.quests.length && !this.state.complete) {
                    this.state.complete = true;
                    this.state.days = (this.state.days || 0) + 1;
                    this.state.streak = (this.state.streak || 0) + 1;
                    if (this.onDayComplete) this.onDayComplete(this.state.days);
                }
            }
            if (this.state.done.includes(i)) this.save();
            else if (!this.saveTimer) this.saveTimer = setTimeout(() => this.save(), 1500);
        },

        save() {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
            store.set('snake_quests', JSON.stringify(this.state));
        }
    };

    Q.refresh();
    root.SnakeQuests = Q;
})(window);
