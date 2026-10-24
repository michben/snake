// Connexion X / Facebook : parcours complet avec les API des fournisseurs simulées.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { createAccounts } = require('../accounts');
const { setupOAuth } = require('../oauth');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snake-oauth-'));
Object.assign(process.env, { X_CLIENT_ID: 'id', X_CLIENT_SECRET: 'secret', FACEBOOK_APP_ID: 'fb', FACEBOOK_APP_SECRET: 'fbs', PUBLIC_URL: 'http://jeu.test' });
const accounts = createAccounts({ dataDir: dir, adminEmail: 'sospchs@gmail.com', adminPassword: 'x' });
const app = express();
setupOAuth(app, { accounts, dataDir: dir });

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const ok = (body, type = 'application/json') => new Response(type === 'application/json' ? JSON.stringify(body) : body, { status: 200, headers: { 'content-type': type } });
    if (u.startsWith('https://api.x.com/2/oauth2/token')) {
        assert(String(opts.headers.Authorization).startsWith('Basic '), 'X : authentification client');
        assert(String(opts.body).includes('code_verifier='), 'X : PKCE');
        return ok({ access_token: 'tok' });
    }
    if (u.startsWith('https://api.x.com/2/users/me')) return ok({ data: { id: '42', name: 'Mich Ben', username: 'michben', profile_image_url: 'https://pbs.twimg.com/a_normal.png' } });
    if (u === 'https://pbs.twimg.com/a_400x400.png') return ok(PNG, 'image/png');
    if (u.startsWith('https://graph.facebook.com/v19.0/oauth/access_token')) return ok({ access_token: 'fbt' });
    if (u.startsWith('https://graph.facebook.com/me')) return ok({ id: '7', name: 'Mich Ben', picture: { data: { url: 'https://fb.test/p.jpg', is_silhouette: false } } });
    if (u === 'https://fb.test/p.jpg') return ok(PNG, 'image/jpeg');
    return realFetch(url, opts);
};

const server = http.createServer(app).listen(0, async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const go = (p) => realFetch(base + p, { redirect: 'manual' });
    try {
        for (const provider of ['x', 'facebook']) {
            const start = await go('/auth/' + provider);
            assert.strictEqual(start.status, 302);
            const state = new URL(start.headers.get('location')).searchParams.get('state');
            const back = await go(`/auth/${provider}/callback?code=abc&state=${state}`);
            const loc = back.headers.get('location');
            assert(loc.startsWith('/#auth='), `${provider} : jeton renvoyé (${loc})`);
            const user = accounts.verify(decodeURIComponent(loc.slice(7)));
            assert(user && user.provider === provider && user.avatar, `${provider} : compte avec photo`);
            assert(!accounts.isAdmin(user), `${provider} : jamais admin`);
            const img = await go(`/avatar/${user.avatar}.jpg`);
            assert.strictEqual(img.status, 200, `${provider} : photo servie`);
            const replay = await go(`/auth/${provider}/callback?code=abc&state=${state}`);
            assert(replay.headers.get('location').startsWith('/#authError='), `${provider} : state à usage unique`);
        }
        const pseudos = Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8'))).map(u => u.pseudo);
        assert.strictEqual(new Set(pseudos).size, pseudos.length, 'pseudos uniques');
        console.log('OK — connexion X et Facebook, photos de profil :', pseudos.join(', '));
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
