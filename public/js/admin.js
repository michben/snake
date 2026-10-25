/*
 * Mich Snake — console admin : volumes, test des bruitages et gestion des
 * musiques (présentation, niveau 1, niveau 2).
 *
 * Seul le compte admin (sospchs@gmail.com) peut changer les musiques : le serveur
 * le vérifie à chaque envoi (jeton de session). Serveur connecté : les fichiers sont
 * joués chez tous les joueurs ; version web : ils restent sur l'appareil de l'admin.
 */
(function (root) {
    'use strict';

    const Sound = root.SnakeAudio;
    const Account = root.SnakeAccount;
    const $ = (id) => document.getElementById(id);
    const MAX_BYTES = 20 * 1024 * 1024;

    const SFX_LIST = [
        ['eat', '🍬 Manger'], ['boost', '💨 Boost'], ['kill', '⚔️ Élimination'], ['gameover', '💀 Game over'],
        ['chest', '🎁 Coffre'], ['chest:legend', '👑 Coffre légendaire'], ['power:magnet', '🧲 Aimant'], ['power:speed', '⚡ Turbo'],
        ['power:shield', '🛡️ Bouclier'], ['power:triple', '💎 Score x3'], ['power:blade', '🗡️ Crocs'], ['power:feast', '🍖 Festin'],
        ['power:freeze', '❄️ Blizzard'], ['power:ghost', '👻 Fantôme'], ['power:giant', '🍄 Géant'], ['power:shock', '💥 Onde de choc'],
        ['power:portal', '🌀 Portail'], ['event', '📣 Événement fou'], ['boss', '🐉 Hydre'], ['quest', '📅 Quête réussie'],
        ['powerEnd', '⏳ Fin de bonus'], ['eruption', '🌋 Éruption'], ['levelup', '🗼 Étage réussi'], ['start', '🚀 Départ']
    ];

    let previewing = null;

    const online = () => !!(root.SnakeNet && root.SnakeNet.connected);

    function msg(text, isErr) {
        const el = $('adminMsg');
        el.textContent = text || '';
        el.classList.toggle('err', !!isErr);
    }

    function fmtSize(n) {
        if (!n) return '';
        return n > 1048576 ? (n / 1048576).toFixed(1) + ' Mo' : Math.round(n / 1024) + ' Ko';
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function refresh() {
        const st = Sound.settings;
        $('volMusic').value = Math.round(st.music * 100);
        $('volSfx').value = Math.round(st.sfx * 100);
        $('volMusicVal').textContent = Math.round(st.music * 100) + '%';
        $('volSfxVal').textContent = Math.round(st.sfx * 100) + '%';
        $('muteBox').checked = st.muted;

        const srv = online();
        const admin = Account.isAdmin();
        // Les joueurs ne voient que les volumes : musiques et bruitages de test sont réservés à l'admin
        $('adminTitle').textContent = admin ? '⚙️ Son & console admin' : '🔊 Réglages du son';
        $('adminMusicSection').classList.toggle('hidden', !admin);
        $('adminSfxSection').classList.toggle('hidden', !admin);
        $('adminTarget').textContent = admin ? (srv ? '🌐 Serveur · 👑 admin' : '📱 Cet appareil · 👑 admin') : '🔒 Admin';
        $('adminLogin').classList.toggle('hidden', admin);
        $('adminLoginBtn').classList.toggle('hidden', !srv);
        $('adminTracks').classList.toggle('hidden', !admin);

        document.querySelectorAll('.track-card').forEach((card) => {
            const slot = card.dataset.slot;
            const info = Sound.trackInfo(slot);
            const where = !info ? '' : info.source === 'device' ? '📱 sur cet appareil' : info.source === 'default' ? '🎵 musique intégrée' : '🌐 sur le serveur';
            card.querySelector('.track-info').innerHTML = info
                ? [`<b>${escapeHtml(info.name || 'piste')}</b>`, fmtSize(info.size), where].filter(Boolean).join(' · ')
                : 'Aucune musique — ajoutez votre fichier';
            card.querySelector('[data-act=play]').textContent = previewing === slot ? '⏸️ Stop' : '▶️ Écouter';
            card.querySelector('[data-act=play]').disabled = !info;
            const del = card.querySelector('[data-act=delete]');
            del.disabled = !info || info.source === 'default';
            del.title = info && info.source === 'default' ? 'Musique intégrée au jeu : importez un fichier pour la remplacer' : 'Retirer cette musique';
        });
    }

    async function api(method, path, body, headers = {}) {
        const res = await fetch(path, { method, body, headers: Object.assign(Account.authHeaders(), headers) });
        let data = null;
        try { data = await res.json(); } catch (e) { /* réponse vide */ }
        if (!res.ok) throw Object.assign(new Error((data && data.error) || `Erreur ${res.status}`), { status: res.status });
        return data;
    }

    async function upload(slot, file) {
        if (!file) return;
        if (!Account.isAdmin()) return msg('🔒 Réservé à l\'administrateur', true);
        if (!/^audio\//.test(file.type) && !/\.(mp3|ogg|oga|opus|wav|m4a|aac|flac|webm)$/i.test(file.name)) {
            return msg('❌ Ce fichier n\'est pas un fichier audio', true);
        }
        if (file.size > MAX_BYTES) return msg('❌ Fichier trop lourd (20 Mo max)', true);
        try {
            if (online()) {
                msg('⏳ Envoi au serveur…');
                const manifest = await api('PUT', `api/admin/music/${slot}?name=${encodeURIComponent(file.name)}`, file,
                    { 'Content-Type': file.type || 'application/octet-stream' });
                await Sound.setServerTracks(manifest, '');
                msg('✅ Musique enregistrée sur le serveur — tous les joueurs l\'entendent');
            } else {
                await Sound.setLocalTrack(slot, file);
                msg('✅ Musique enregistrée sur cet appareil');
            }
        } catch (e) {
            msg('❌ ' + e.message, true);
        }
        refresh();
    }

    async function remove(slot) {
        const info = Sound.trackInfo(slot);
        if (!info) return;
        try {
            if (info.source === 'device') {
                await Sound.setLocalTrack(slot, null);
            } else {
                const manifest = await api('DELETE', `api/admin/music/${slot}`);
                await Sound.setServerTracks(manifest, '');
            }
            msg('🗑️ Musique retirée');
        } catch (e) {
            msg('❌ ' + e.message, true);
        }
        refresh();
    }

    function togglePreview(slot) {
        if (previewing === slot) { previewing = null; Sound.setScene('menu'); }
        else if (Sound.preview(slot)) previewing = slot;
        refresh();
    }

    function buildSfxGrid() {
        const grid = $('sfxGrid');
        for (const [id, label] of SFX_LIST) {
            const b = document.createElement('button');
            b.className = 'btn btn-small btn-ghost';
            b.textContent = label;
            b.addEventListener('click', () => {
                Sound.unlock();
                const [name, arg] = id.split(':');
                Sound.play(name, arg);
            });
            grid.appendChild(b);
        }
    }

    function open() {
        Sound.unlock();
        $('adminScreen').classList.remove('hidden');
        msg('');
        refresh();
    }

    function close() {
        $('adminScreen').classList.add('hidden');
        if (previewing) { previewing = null; Sound.setScene('menu'); }
        if (location.hash === '#admin') history.replaceState(null, '', location.pathname + location.search);
    }

    // ---------- Branchements ----------
    $('adminClose').addEventListener('click', close);
    $('adminScreen').addEventListener('click', (e) => { if (e.target === $('adminScreen')) close(); });
    $('volMusic').addEventListener('input', (e) => { Sound.setVolume('music', e.target.value / 100); refresh(); });
    $('volSfx').addEventListener('input', (e) => { Sound.setVolume('sfx', e.target.value / 100); refresh(); });
    $('volSfx').addEventListener('change', () => Sound.play('eat'));
    $('muteBox').addEventListener('change', (e) => {
        Sound.setMuted(e.target.checked);
        if (root.SnakeSoundUI) root.SnakeSoundUI.refresh();
        refresh();
    });
    $('adminLoginBtn').addEventListener('click', () => { close(); Account.open('login'); });

    document.querySelectorAll('.track-card').forEach((card) => {
        const slot = card.dataset.slot;
        const input = card.querySelector('input[type=file]');
        input.addEventListener('change', () => { upload(slot, input.files[0]); input.value = ''; });
        // Bouton dédié (plus fiable qu'un <label> autour d'un champ caché) + glisser-déposer
        card.querySelector('[data-act=pick]').addEventListener('click', () => { input.value = ''; input.click(); });
        card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('drop'); });
        card.addEventListener('dragleave', () => card.classList.remove('drop'));
        card.addEventListener('drop', (e) => {
            e.preventDefault();
            card.classList.remove('drop');
            const f = e.dataTransfer && e.dataTransfer.files[0];
            if (f) upload(slot, f);
        });
        card.querySelector('[data-act=play]').addEventListener('click', () => togglePreview(slot));
        card.querySelector('[data-act=delete]').addEventListener('click', () => remove(slot));
    });

    buildSfxGrid();
    Sound.onTracksChanged = refresh;
    Account.onChange(() => { if (!$('adminScreen').classList.contains('hidden')) refresh(); });
    root.SnakeAdmin = { open, close, refresh };

    if (location.hash === '#admin') open();
})(window);
