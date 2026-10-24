/*
 * Mich Snake — connexion via X (Twitter) et Facebook.
 *
 * Chaque fournisseur s'active dès que ses identifiants d'application sont fournis :
 *   X        : X_CLIENT_ID, X_CLIENT_SECRET        (developer.x.com, OAuth 2.0, type « Web App »)
 *   Facebook : FACEBOOK_APP_ID, FACEBOOK_APP_SECRET (developers.facebook.com, « Facebook Login »)
 * URL de retour à déclarer chez le fournisseur : <PUBLIC_URL>/auth/x/callback et <PUBLIC_URL>/auth/facebook/callback.
 *
 * La photo de profil est téléchargée dans DATA_DIR/avatars puis servie par /avatar/<id>.jpg :
 * le jeu l'affiche à la place de l'emoji du serpent.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FB_API = 'v19.0';

function setupOAuth(app, { accounts, dataDir }) {
    const AVATAR_DIR = path.join(dataDir, 'avatars');
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    const env = process.env;

    const providers = {
        x: {
            enabled: !!(env.X_CLIENT_ID && env.X_CLIENT_SECRET),
            authorizeUrl(redirect, state, challenge) {
                const q = new URLSearchParams({
                    response_type: 'code', client_id: env.X_CLIENT_ID, redirect_uri: redirect,
                    scope: 'users.read tweet.read', state, code_challenge: challenge, code_challenge_method: 'S256'
                });
                return 'https://x.com/i/oauth2/authorize?' + q;
            },
            async profile(code, redirect, verifier) {
                const basic = Buffer.from(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`).toString('base64');
                const tok = await json('https://api.x.com/2/oauth2/token', {
                    method: 'POST',
                    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier, client_id: env.X_CLIENT_ID })
                });
                const me = await json('https://api.x.com/2/users/me?user.fields=profile_image_url', {
                    headers: { Authorization: 'Bearer ' + tok.access_token }
                });
                const d = me.data || {};
                // "_normal" = 48 px : on demande la version 400 px
                return { id: d.id, name: d.name || d.username, picture: d.profile_image_url && d.profile_image_url.replace('_normal', '_400x400') };
            }
        },
        facebook: {
            enabled: !!(env.FACEBOOK_APP_ID && env.FACEBOOK_APP_SECRET),
            authorizeUrl(redirect, state) {
                const q = new URLSearchParams({ client_id: env.FACEBOOK_APP_ID, redirect_uri: redirect, state, scope: 'public_profile', response_type: 'code' });
                return `https://www.facebook.com/${FB_API}/dialog/oauth?` + q;
            },
            async profile(code, redirect) {
                const q = new URLSearchParams({ client_id: env.FACEBOOK_APP_ID, client_secret: env.FACEBOOK_APP_SECRET, redirect_uri: redirect, code });
                const tok = await json(`https://graph.facebook.com/${FB_API}/oauth/access_token?` + q);
                const me = await json(`https://graph.facebook.com/me?fields=id,name,picture.width(256).height(256)&access_token=${encodeURIComponent(tok.access_token)}`);
                return { id: me.id, name: me.name, picture: me.picture && me.picture.data && !me.picture.data.is_silhouette ? me.picture.data.url : null };
            }
        }
    };

    async function json(url, opts) {
        const res = await fetch(url, opts);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((data.error && (data.error.message || data.error)) || data.error_description || `HTTP ${res.status}`);
        return data;
    }

    // L'image est copiée chez nous : les liens X / Facebook expirent et ne sont pas lisibles depuis le canvas
    async function saveAvatar(key, url) {
        if (!url) return null;
        try {
            const res = await fetch(url);
            if (!res.ok || !/^image\//.test(res.headers.get('content-type') || '')) return null;
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > 2 * 1024 * 1024) return null;
            const id = crypto.createHash('sha256').update(key + '|' + buf.length + '|' + Date.now()).digest('hex').substring(0, 16);
            fs.writeFileSync(path.join(AVATAR_DIR, id + '.jpg'), buf);
            return id;
        } catch (e) {
            return null;
        }
    }

    const publicUrl = (req) => (env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const pending = new Map();   // state -> { provider, verifier, at }

    app.get('/api/auth/providers', (req, res) => res.json({ x: providers.x.enabled, facebook: providers.facebook.enabled }));

    app.get('/auth/:provider', (req, res) => {
        const p = providers[req.params.provider];
        if (!p || !p.enabled) return res.redirect('/#authError=' + encodeURIComponent('Connexion non configurée sur ce serveur'));
        for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60 * 1000) pending.delete(k);
        const state = crypto.randomBytes(16).toString('hex');
        const verifier = crypto.randomBytes(32).toString('base64url');
        const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
        pending.set(state, { provider: req.params.provider, verifier, at: Date.now() });
        res.redirect(p.authorizeUrl(`${publicUrl(req)}/auth/${req.params.provider}/callback`, state, challenge));
    });

    app.get('/auth/:provider/callback', async (req, res) => {
        const name = req.params.provider;
        const p = providers[name];
        const st = pending.get(String(req.query.state || ''));
        pending.delete(String(req.query.state || ''));
        const fail = (msg) => res.redirect('/#authError=' + encodeURIComponent(msg));
        if (!p || !p.enabled || !st || st.provider !== name) return fail('Connexion expirée, réessayez');
        if (!req.query.code) return fail('Connexion annulée');
        try {
            const prof = await p.profile(String(req.query.code), `${publicUrl(req)}/auth/${name}/callback`, st.verifier);
            if (!prof.id) throw new Error('profil introuvable');
            const avatar = await saveAvatar(`${name}:${prof.id}`, prof.picture);
            const out = accounts.socialLogin({ provider: name, id: String(prof.id), name: prof.name, avatar });
            res.redirect('/#auth=' + encodeURIComponent(out.token));
        } catch (e) {
            console.warn(`Connexion ${name} échouée :`, e.message);
            fail('Connexion ' + (name === 'x' ? 'X' : 'Facebook') + ' impossible');
        }
    });

    app.get('/avatar/:file', (req, res) => {
        const m = /^([a-f0-9]{16})\.jpg$/.exec(req.params.file);
        const file = m && path.join(AVATAR_DIR, m[1] + '.jpg');
        if (!file || !fs.existsSync(file)) return res.status(404).end();
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.sendFile(file);
    });

    return providers;
}

module.exports = { setupOAuth };
