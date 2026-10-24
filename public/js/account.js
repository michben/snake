/*
 * Mich Snake — comptes joueurs côté client : inscription, connexion (e-mail, X, Facebook),
 * profil, et tableau des records (mondial + parties de cet appareil).
 *
 * Le jeton de session (signé par le serveur) est gardé dans localStorage et envoyé
 * en en-tête Authorization. Dans la version web (Artifact), l'identité claude.ai du
 * visiteur sert à reconnaître l'admin et fournit sa photo de profil.
 */
(function (root) {
    'use strict';

    const store = root.SnakeStore;
    const Sound = root.SnakeAudio;
    const $ = (id) => document.getElementById(id);
    const ADMIN_EMAIL = 'sospchs@gmail.com';

    const A = {
        token: store.get('snake_token', '') || '',
        user: null,             // utilisateur renvoyé par le serveur
        viewer: null,           // identité claude.ai (version web) { name, email, avatarUrl }
        providers: { x: false, facebook: false },
        listeners: [],
        onChange(fn) { this.listeners.push(fn); },
        emit() { for (const fn of this.listeners) { try { fn(this); } catch (e) { console.error(e); } } },

        authHeaders() { return this.token ? { Authorization: 'Bearer ' + this.token } : {}; },
        online() { return !!(root.SnakeNet && root.SnakeNet.connected); },

        // Droits admin : compte serveur admin, ou (version web) visiteur claude.ai sospchs@gmail.com
        isAdmin() {
            if (this.online()) return !!(this.user && this.user.admin);
            // Version web : l'adresse n'est pas toujours fournie, le propriétaire de la page (michben) fait foi
            const v = this.viewer;
            return !!v && (v.email ? v.email.toLowerCase() === ADMIN_EMAIL : v.owner);
        },

        displayName() {
            if (this.user) return this.user.pseudo;
            if (this.viewer && this.viewer.name) return this.viewer.name.substring(0, 14);
            return '';
        },

        // Photo de profil utilisable comme skin
        photoUrl() {
            if (this.user && this.user.avatar) return 'avatar/' + this.user.avatar + '.jpg';
            if (!this.online() && this.viewer && this.viewer.photo) return this.viewer.avatarUrl;
            return null;
        },

        setSession(token, user) {
            this.token = token || '';
            this.user = user || null;
            store.set('snake_token', this.token);
            this.emit();
        },

        logout() { this.setSession('', null); },

        async api(method, path, body) {
            const res = await fetch(path, {
                method,
                headers: Object.assign({ 'Content-Type': 'application/json' }, this.authHeaders()),
                body: body ? JSON.stringify(body) : undefined
            });
            let data = null;
            try { data = await res.json(); } catch (e) { /* vide */ }
            if (!res.ok) throw Object.assign(new Error((data && data.error) || `Erreur ${res.status}`), { status: res.status });
            return data;
        },

        // Appelé quand le serveur répond : session et fournisseurs sociaux
        async connected() {
            try { this.providers = await this.api('GET', 'api/auth/providers'); } catch (e) { /* ancien serveur */ }
            if (this.token) {
                try { this.user = (await this.api('GET', 'api/auth/me')).user; }
                catch (e) { if (e.status === 401) this.setSession('', null); }
            }
            this.emit();
        },

        // Fin de partie en ligne : records du compte renvoyés par le serveur
        updateUser(u) { if (u && this.user) { this.user = u; this.emit(); } },

        // ---------- Parties de cet appareil ----------
        runs() {
            try { return JSON.parse(store.get('snake_runs', '[]')) || []; } catch (e) { return []; }
        },
        addRun(run) {
            const list = this.runs();
            list.push(run);
            list.sort((a, b) => b.score - a.score);
            store.set('snake_runs', JSON.stringify(list.slice(0, 15)));
        }
    };

    // Retour de connexion X / Facebook : #auth=<jeton> ou #authError=<message>
    (function readHash() {
        const h = location.hash;
        const m = /^#auth=([^&]+)/.exec(h), err = /^#authError=([^&]+)/.exec(h);
        if (m) { A.token = decodeURIComponent(m[1]); store.set('snake_token', A.token); }
        if (m || err) {
            history.replaceState(null, '', location.pathname + location.search);
            if (err) A.pendingError = decodeURIComponent(err[1]);
            A.justLoggedIn = !!m;
        }
    })();

    // Version web : identité claude.ai du visiteur (photo + reconnaissance de l'admin)
    if (root.claude && typeof root.claude.use === 'function') {
        root.claude.use('user').then(async (user) => {
            if (!user) return;
            const me = await user.me();
            const hasPhoto = !!me.avatarUrl && !/^data:/.test(me.avatarUrl);
            A.viewer = { name: me.name || '', email: me.email || null, owner: !!me.isOwner, avatarUrl: me.avatarUrl, photo: hasPhoto };
            A.emit();
        }).catch(() => { /* pas d'identité */ });
    }

    // ---------- Écran compte ----------
    let tab = 'login';
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function authMsg(text, isErr) {
        $('authMsg').textContent = text || '';
        $('authMsg').classList.toggle('err', !!isErr);
    }
    function setTab(t) {
        tab = t;
        document.querySelectorAll('#authScreen .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
        $('authPseudo').classList.toggle('hidden', t !== 'register');
        $('authPass').autocomplete = t === 'register' ? 'new-password' : 'current-password';
        $('authSubmit').textContent = t === 'register' ? 'Créer mon compte' : 'Se connecter';
        authMsg('');
    }

    function renderAuth() {
        const u = A.user;
        const online = A.online();
        $('authForms').classList.toggle('hidden', !!u);
        $('authProfile').classList.toggle('hidden', !u);
        $('authForm').classList.toggle('hidden', !online);
        $('authOffline').classList.toggle('hidden', online);
        $('socialBox').classList.toggle('hidden', !online || !(A.providers.x || A.providers.facebook));
        $('loginX').classList.toggle('hidden', !A.providers.x);
        $('loginFb').classList.toggle('hidden', !A.providers.facebook);
        if (A.viewer && !online) {
            $('authOffline').textContent = `Version web : tu joues en tant que ${A.viewer.name || 'visiteur'}. Les comptes et le classement mondial sont sur le serveur du jeu.`;
        }
        if (u) {
            const photo = A.photoUrl();
            $('profAvatar').innerHTML = photo ? `<img src="${escapeHtml(photo)}" alt="">` : '🐍';
            $('profName').textContent = u.pseudo + (u.admin ? ' · 👑 admin' : '');
            $('profSub').textContent = u.provider ? `Connecté avec ${u.provider === 'x' ? 'X' : 'Facebook'}` : u.email;
            $('profBest').textContent = u.best;
            $('profKills').textContent = u.kills;
            $('profGames').textContent = u.games;
        }
    }

    async function submit(e) {
        e.preventDefault();
        const body = { email: $('authEmail').value, password: $('authPass').value };
        if (tab === 'register') body.pseudo = $('authPseudo').value;
        $('authSubmit').disabled = true;
        authMsg('⏳ …');
        try {
            const out = await A.api('POST', tab === 'register' ? 'api/auth/register' : 'api/auth/login', body);
            $('authPass').value = '';
            A.setSession(out.token, out.user);
            authMsg('');
            Sound.play('levelup');
            renderAuth();
        } catch (err) {
            authMsg('❌ ' + err.message, true);
        }
        $('authSubmit').disabled = false;
    }

    A.open = function (t) {
        Sound.unlock();
        if (t) setTab(t);
        $('authScreen').classList.remove('hidden');
        renderAuth();
    };
    A.close = function () { $('authScreen').classList.add('hidden'); };

    // ---------- Tableau des records ----------
    let hallTab = 'world';
    async function renderHall() {
        document.querySelectorAll('#hallScreen .tab').forEach(b => b.classList.toggle('active', b.dataset.hall === hallTab));
        const list = $('hallList'), note = $('hallNote');
        const medal = (i) => ['🥇', '🥈', '🥉'][i] || `#${i + 1}`;
        if (hallTab === 'me') {
            const runs = A.runs();
            list.innerHTML = runs.length ? runs.map((r, i) => `<div class="hall-row"><span class="rk">${medal(i)}</span><span class="nm">${r.level === 'volcan' ? '🌋' : '🌌'} ${new Date(r.at).toLocaleDateString('fr-FR')}</span><span class="sub">⚔️ ${r.kills}</span><b>${r.score}</b></div>`).join('')
                : '<p class="help">Aucune partie pour l\'instant : à toi de jouer !</p>';
            note.textContent = 'Tes 15 meilleures parties sur cet appareil.';
            return;
        }
        if (!A.online()) {
            list.innerHTML = '<p class="help">🌐 Le classement mondial s\'affiche quand le serveur du jeu est connecté.</p>';
            note.textContent = '';
            return;
        }
        list.innerHTML = '<p class="help">⏳ Chargement…</p>';
        try {
            const { top } = await A.api('GET', 'api/leaderboard');
            const mine = A.user && A.user.pseudo;
            list.innerHTML = top.length ? top.map((r, i) => {
                const av = r.avatar ? `<img class="av" src="avatar/${escapeHtml(r.avatar)}.jpg" alt="">` : '';
                return `<div class="hall-row${r.pseudo === mine ? ' me' : ''}"><span class="rk">${medal(i)}</span><span class="nm">${av}${escapeHtml(r.pseudo)}</span><span class="sub">⚔️ ${r.kills} · 🎮 ${r.games}</span><b>${r.best}</b></div>`;
            }).join('') : '<p class="help">Personne au classement pour l\'instant : sois le premier !</p>';
            note.textContent = A.user ? '' : 'Connecte-toi pour que tes records y apparaissent.';
        } catch (e) {
            list.innerHTML = `<p class="help">❌ ${escapeHtml(e.message)}</p>`;
        }
    }
    A.openHall = function () {
        Sound.unlock();
        $('hallScreen').classList.remove('hidden');
        renderHall();
    };

    // ---------- Branchements ----------
    document.querySelectorAll('#authScreen .tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
    $('authForm').addEventListener('submit', submit);
    $('authClose').addEventListener('click', A.close);
    $('authScreen').addEventListener('click', (e) => { if (e.target === $('authScreen')) A.close(); });
    $('logoutBtn').addEventListener('click', () => { A.logout(); renderAuth(); });
    document.querySelectorAll('#hallScreen .tab').forEach(b => b.addEventListener('click', () => { hallTab = b.dataset.hall; renderHall(); }));
    $('hallClose').addEventListener('click', () => $('hallScreen').classList.add('hidden'));
    $('hallScreen').addEventListener('click', (e) => { if (e.target === $('hallScreen')) $('hallScreen').classList.add('hidden'); });
    A.onChange(() => { if (!$('authScreen').classList.contains('hidden')) renderAuth(); });
    setTab('login');

    root.SnakeAccount = A;
})(window);
