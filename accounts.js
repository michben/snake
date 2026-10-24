/*
 * Mich Snake — comptes joueurs (inscription / connexion) et droits admin.
 *
 * Les comptes sont gardés dans DATA_DIR/users.json, mots de passe hachés en scrypt.
 * Les sessions sont des jetons signés (HMAC) : rien à stocker côté serveur.
 * Seul le compte ADMIN_EMAIL (sospchs@gmail.com par défaut) a les droits admin ;
 * son mot de passe est ADMIN_PASSWORD et l'adresse ne peut pas être prise à l'inscription.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN_DAYS = 30;

function createAccounts({ dataDir, adminEmail, adminPassword }) {
    fs.mkdirSync(dataDir, { recursive: true });
    const USERS = path.join(dataDir, 'users.json');
    const SECRET_FILE = path.join(dataDir, 'session-secret');
    const ADMIN_EMAIL = String(adminEmail).trim().toLowerCase();

    let secret;
    try { secret = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) { /* premier démarrage */ }
    if (!secret) {
        secret = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    }

    let users = {};
    try { users = JSON.parse(fs.readFileSync(USERS, 'utf8')); } catch (e) { users = {}; }
    const save = () => fs.writeFileSync(USERS, JSON.stringify(users, null, 2));

    function hash(password, salt) {
        return crypto.scryptSync(String(password), salt, 64).toString('hex');
    }
    function checkPassword(u, password) {
        const a = Buffer.from(hash(password, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    function setPassword(u, password) {
        u.salt = crypto.randomBytes(16).toString('hex');
        u.hash = hash(password, u.salt);
    }

    // Le compte admin existe toujours ; ADMIN_PASSWORD (s'il est fourni) fait foi à chaque démarrage
    if (!users[ADMIN_EMAIL] || process.env.ADMIN_PASSWORD) {
        const u = users[ADMIN_EMAIL] || { email: ADMIN_EMAIL, pseudo: 'michben', created: Date.now(), best: 0, kills: 0, games: 0 };
        setPassword(u, adminPassword);
        users[ADMIN_EMAIL] = u;
        save();
    }

    // Les comptes X / Facebook (clé "x:123", "facebook:456") ne sont jamais admin, même avec la même adresse
    const isAdmin = (u) => !!u && u.email === ADMIN_EMAIL && !u.provider;
    const publicUser = (u) => ({
        email: u.provider ? null : u.email, pseudo: u.pseudo, admin: isAdmin(u), provider: u.provider || null,
        avatar: u.avatar || null, best: u.best || 0, kills: u.kills || 0, games: u.games || 0
    });
    const pseudoTaken = (pseudo, except) => Object.values(users).some(u => u !== except && u.pseudo.toLowerCase() === pseudo.toLowerCase());

    function sign(email) {
        const body = Buffer.from(JSON.stringify({ e: email, x: Date.now() + TOKEN_DAYS * 864e5 })).toString('base64url');
        const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
        return body + '.' + mac;
    }

    function verify(token) {
        if (typeof token !== 'string' || !token.includes('.')) return null;
        const [body, mac] = token.split('.');
        const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
        if (!mac || mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
        try {
            const { e, x } = JSON.parse(Buffer.from(body, 'base64url').toString());
            return x > Date.now() && users[e] ? users[e] : null;
        } catch (err) { return null; }
    }

    const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

    function register({ email, password, pseudo }) {
        email = String(email || '').trim().toLowerCase();
        pseudo = String(pseudo || '').trim().substring(0, 14);
        if (!EMAIL_RE.test(email)) throw new Error('Adresse e-mail invalide');
        if (email === ADMIN_EMAIL) throw new Error('Cette adresse est réservée : connectez-vous avec le mot de passe admin');
        if (String(password || '').length < 6) throw new Error('Mot de passe trop court (6 caractères minimum)');
        if (pseudo.length < 2) throw new Error('Pseudo trop court (2 caractères minimum)');
        if (users[email]) throw new Error('Un compte existe déjà avec cette adresse');
        if (pseudoTaken(pseudo)) throw new Error('Ce pseudo est déjà pris');
        const u = { email, pseudo, created: Date.now(), best: 0, kills: 0, games: 0 };
        setPassword(u, password);
        users[email] = u;
        save();
        return { token: sign(email), user: publicUser(u) };
    }

    function login({ email, password }) {
        email = String(email || '').trim().toLowerCase();
        const u = users[email];
        if (!u || u.provider || !checkPassword(u, password)) throw new Error('E-mail ou mot de passe incorrect');
        return { token: sign(email), user: publicUser(u) };
    }

    // Connexion via X ou Facebook : le compte est créé au premier passage, la photo mise à jour ensuite
    function socialLogin({ provider, id, name, avatar }) {
        const key = `${provider}:${id}`;
        let u = users[key];
        if (!u) {
            let base = String(name || provider).replace(/\s+/g, ' ').trim().substring(0, 12) || 'Serpent';
            if (base.length < 2) base += '_' + provider;
            let pseudo = base, n = 2;
            while (pseudoTaken(pseudo)) pseudo = base.substring(0, 11) + (n++);
            u = users[key] = { email: key, provider, pseudo, created: Date.now(), best: 0, kills: 0, games: 0 };
        }
        if (avatar) u.avatar = avatar;
        save();
        return { token: sign(key), user: publicUser(u) };
    }

    // Fin de partie d'un joueur connecté : met à jour ses records
    function recordGame(email, { score, kills }) {
        const u = users[email];
        if (!u) return null;
        u.games = (u.games || 0) + 1;
        u.kills = (u.kills || 0) + (kills || 0);
        const isBest = score > (u.best || 0);
        if (isBest) { u.best = score; u.bestAt = Date.now(); }
        save();
        return { isBest, user: publicUser(u) };
    }

    // Tableau des records : meilleurs scores de tous les comptes
    function hallOfFame(limit = 20) {
        return Object.values(users)
            .filter(u => (u.best || 0) > 0)
            .sort((a, b) => b.best - a.best)
            .slice(0, limit)
            .map(u => ({ pseudo: u.pseudo, best: u.best, kills: u.kills || 0, games: u.games || 0, avatar: u.avatar || null, provider: u.provider || null }));
    }

    return { register, login, socialLogin, verify, isAdmin, publicUser, recordGame, hallOfFame, ADMIN_EMAIL };
}

module.exports = { createAccounts };
