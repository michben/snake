/*
 * Mich Snake — effets visuels : décors des niveaux (parallaxe, lave),
 * particules, textes flottants, secousses d'écran et vignette.
 * Tout est dessiné sur le canvas du jeu, sans image externe.
 */
(function (root) {
    'use strict';

    // Générateur pseudo-aléatoire déterministe : le décor est identique à chaque chargement
    function rng(seed) {
        let s = seed >>> 0;
        return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    }

    function makeCanvas(w, h) {
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        return c;
    }

    // ---------- Tuiles de décor pré-rendues ----------
    function starTile(seed, count, maxR, alpha) {
        const c = makeCanvas(1024, 1024), g = c.getContext('2d'), r = rng(seed);
        for (let i = 0; i < count; i++) {
            const x = r() * 1024, y = r() * 1024, rad = 0.4 + r() * maxR;
            const hue = [200, 280, 180, 50][Math.floor(r() * 4)];
            g.fillStyle = `hsla(${hue}, 80%, ${80 + r() * 20}%, ${alpha * (0.4 + r() * 0.6)})`;
            g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
            if (rad > maxR * 0.8) {                     // quelques étoiles scintillantes en croix
                g.fillRect(x - rad * 3, y - 0.5, rad * 6, 1);
                g.fillRect(x - 0.5, y - rad * 3, 1, rad * 6);
            }
        }
        return c;
    }

    function rockTile() {
        const c = makeCanvas(512, 512), g = c.getContext('2d'), r = rng(7);
        g.fillStyle = '#1c0d09';
        g.fillRect(0, 0, 512, 512);
        for (let i = 0; i < 260; i++) {                 // taches de basalte
            const x = r() * 512, y = r() * 512, rad = 6 + r() * 40;
            g.fillStyle = `rgba(${40 + r() * 30}, ${16 + r() * 12}, ${10 + r() * 8}, ${0.25 + r() * 0.35})`;
            g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
            // répété sur les bords pour que la tuile se raccorde
            for (const [dx, dy] of [[512, 0], [-512, 0], [0, 512], [0, -512]]) {
                g.beginPath(); g.arc(x + dx, y + dy, rad, 0, Math.PI * 2); g.fill();
            }
        }
        return c;
    }

    function crackTile() {
        const c = makeCanvas(512, 512), g = c.getContext('2d'), r = rng(42);
        g.lineCap = 'round'; g.lineJoin = 'round';
        const paths = [];
        for (let i = 0; i < 16; i++) {                  // fissures : marches aléatoires
            let x = r() * 512, y = r() * 512, a = r() * Math.PI * 2;
            const pts = [[x, y]];
            const len = 6 + Math.floor(r() * 14);
            for (let k = 0; k < len; k++) {
                a += (r() - 0.5) * 1.1;
                x += Math.cos(a) * (10 + r() * 18); y += Math.sin(a) * (10 + r() * 18);
                pts.push([x, y]);
            }
            paths.push({ pts, w: 1.5 + r() * 3 });
        }
        for (const [color, extra, blur] of [['rgba(255,80,0,0.35)', 8, 18], ['#ff6a00', 2, 8], ['#ffd27a', 0, 0]]) {
            g.strokeStyle = color; g.shadowColor = '#ff4500'; g.shadowBlur = blur;
            for (const p of paths) {
                g.lineWidth = p.w + extra;
                for (const [ox, oy] of [[0, 0], [512, 0], [-512, 0], [0, 512], [0, -512]]) {
                    g.beginPath();
                    p.pts.forEach(([x, y], i) => i ? g.lineTo(x + ox, y + oy) : g.moveTo(x + ox, y + oy));
                    g.stroke();
                }
            }
        }
        return c;
    }

    // Grandes nébuleuses du niveau Néon (positions fixes dans le monde)
    const NEBULAE = (() => {
        const r = rng(99), out = [];
        for (let i = 0; i < 9; i++) {
            out.push({ x: r() * 4000, y: r() * 4000, rad: 500 + r() * 700, color: ['120,60,255', '0,200,255', '255,0,170'][i % 3] });
        }
        return out;
    })();

    const tiles = {};
    function tile(name) {
        if (!tiles[name]) {
            tiles[name] = name === 'stars' ? starTile(1, 340, 2.2, 0.85)
                : name === 'rock' ? rockTile() : crackTile();
        }
        return tiles[name];
    }

    // Motifs mis en cache par image (un seul canvas de jeu)
    const patterns = new Map();
    function fillPattern(ctx, img, x0, y0, w, h, ox, oy) {
        let pat = patterns.get(img);
        if (!pat) { pat = ctx.createPattern(img, 'repeat'); patterns.set(img, pat); }
        if (pat.setTransform) pat.setTransform(new DOMMatrix([1, 0, 0, 1, ox, oy]));
        ctx.fillStyle = pat;
        ctx.fillRect(x0, y0, w, h);
    }

    // ---------- Thèmes ----------
    const THEMES = {
        neon: {
            outside: '#03050a',
            minimap: 'rgba(0, 255, 204, ',
            border: (ctx, size, now) => {
                const g = ctx.createLinearGradient(0, 0, size, size);
                const t = (now * 0.0001) % 1;
                g.addColorStop(0, '#00ffcc'); g.addColorStop((0.5 + t) % 1, '#ff00aa'); g.addColorStop(1, '#00aaff');
                ctx.save();
                ctx.strokeStyle = 'rgba(255, 0, 170, 0.18)'; ctx.lineWidth = 34;   // halo (sans shadowBlur, trop coûteux)
                ctx.strokeRect(0, 0, size, size);
                ctx.strokeStyle = g; ctx.lineWidth = 10;
                ctx.setLineDash([60, 24]); ctx.lineDashOffset = -now * 0.05;
                ctx.strokeRect(0, 0, size, size);
                ctx.restore();
            },
            lines(ctx, x0, y0, x1, y1, size) {
                const ax0 = Math.max(0, x0), ay0 = Math.max(0, y0), ax1 = Math.min(size, x1), ay1 = Math.min(size, y1);
                if (ax1 <= ax0 || ay1 <= ay0) return;
                // Grille holographique : fine tous les 80, plus marquée tous les 400
                ctx.lineWidth = 1.5;
                for (const [step, color] of [[80, 'rgba(60, 120, 255, 0.07)'], [400, 'rgba(0, 255, 204, 0.12)']]) {
                    ctx.strokeStyle = color;
                    ctx.beginPath();
                    for (let x = Math.floor(ax0 / step) * step; x <= ax1; x += step) { ctx.moveTo(x, ay0); ctx.lineTo(x, ay1); }
                    for (let y = Math.floor(ay0 / step) * step; y <= ay1; y += step) { ctx.moveTo(ax0, y); ctx.lineTo(ax1, y); }
                    ctx.stroke();
                }
            },
            draw(ctx, x0, y0, x1, y1, size, now, cam) {
                ctx.fillStyle = '#070b18';
                ctx.fillRect(0, 0, size, size);
                const ax0 = Math.max(0, x0), ay0 = Math.max(0, y0), ax1 = Math.min(size, x1), ay1 = Math.min(size, y1);
                if (ax1 <= ax0 || ay1 <= ay0) return;
                ctx.save();
                ctx.beginPath(); ctx.rect(ax0, ay0, ax1 - ax0, ay1 - ay0); ctx.clip();
                // Nébuleuses
                for (const n of NEBULAE) {
                    if (n.x + n.rad < x0 || n.x - n.rad > x1 || n.y + n.rad < y0 || n.y - n.rad > y1) continue;
                    const gr = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.rad);
                    gr.addColorStop(0, `rgba(${n.color}, 0.16)`);
                    gr.addColorStop(1, `rgba(${n.color}, 0)`);
                    ctx.fillStyle = gr;
                    ctx.fillRect(n.x - n.rad, n.y - n.rad, n.rad * 2, n.rad * 2);
                }
                // Champ d'étoiles en parallaxe (il défile moins vite que l'arène)
                fillPattern(ctx, tile('stars'), ax0, ay0, ax1 - ax0, ay1 - ay0, cam.x * 0.4, cam.y * 0.4);
                ctx.restore();
            }
        },
        volcan: {
            outside: '#080201',
            minimap: 'rgba(255, 120, 30, ',
            border: (ctx, size, now) => {
                ctx.save();
                const flick = 0.75 + Math.sin(now * 0.013) * 0.15 + Math.sin(now * 0.031) * 0.1;
                ctx.strokeStyle = `rgba(255, 60, 0, ${0.15 + flick * 0.15})`;
                ctx.lineWidth = 70;
                ctx.strokeRect(0, 0, size, size);
                ctx.strokeStyle = `rgba(255, ${90 + flick * 60}, 0, 1)`;
                ctx.lineWidth = 18;
                ctx.strokeRect(0, 0, size, size);
                ctx.strokeStyle = '#ffe08a'; ctx.lineWidth = 3;
                ctx.strokeRect(0, 0, size, size);
                ctx.restore();
            },
            draw(ctx, x0, y0, x1, y1, size, now) {
                const ax0 = Math.max(0, x0), ay0 = Math.max(0, y0), ax1 = Math.min(size, x1), ay1 = Math.min(size, y1);
                if (ax1 <= ax0 || ay1 <= ay0) return;
                fillPattern(ctx, tile('rock'), ax0, ay0, ax1 - ax0, ay1 - ay0, 0, 0);
                // Fissures de lave qui « respirent »
                ctx.save();
                ctx.globalAlpha = 0.55 + Math.sin(now * 0.0025) * 0.3;
                fillPattern(ctx, tile('cracks'), ax0, ay0, ax1 - ax0, ay1 - ay0, 0, 0);
                ctx.restore();
            }
        }
    };

    // ---------- Particules ----------
    const parts = [];
    const texts = [];
    const embers = [];
    const MAX_PARTS = 700;

    const dotCache = new Map();
    function dot(color) {
        let c = dotCache.get(color);
        if (c) return c;
        c = makeCanvas(32, 32);
        const g = c.getContext('2d');
        const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
        gr.addColorStop(0, '#ffffff');
        gr.addColorStop(0.25, color);
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
        dotCache.set(color, c);
        return c;
    }

    function emit(x, y, n, o = {}) {
        for (let i = 0; i < n && parts.length < MAX_PARTS; i++) {
            const a = o.angle !== undefined ? o.angle + (Math.random() - 0.5) * (o.spread || 0.6) : Math.random() * Math.PI * 2;
            const sp = (o.speed || 4) * (0.3 + Math.random() * 0.9);
            const colors = o.colors || [o.color || '#ffffff'];
            parts.push({
                x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                life: 0, max: (o.life || 600) * (0.6 + Math.random() * 0.6),
                size: (o.size || 6) * (0.6 + Math.random() * 0.8),
                color: colors[Math.floor(Math.random() * colors.length)],
                drag: o.drag !== undefined ? o.drag : 0.94, g: o.gravity || 0
            });
        }
    }

    const FX = {
        THEMES,
        theme(key) { return THEMES[key] || THEMES.neon; },

        // Le décor (aplats, motifs, dégradés) est rendu à mi-résolution puis agrandi :
        // c'est la partie la plus coûteuse et elle n'a pas besoin de netteté.
        // Grille et bordure restent nettes, dessinées en pleine résolution.
        bg: null,
        drawBackground(ctx, key, x0, y0, x1, y1, size, now, cam) {
            const th = this.theme(key);
            const W = ctx.canvas.width, H = ctx.canvas.height;
            if (!this.bg) this.bg = makeCanvas(1, 1);
            const bw = Math.ceil(W / 2), bh = Math.ceil(H / 2);
            if (this.bg.width !== bw || this.bg.height !== bh) { this.bg.width = bw; this.bg.height = bh; }
            const b = this.bg.getContext('2d');
            const m = ctx.getTransform();
            b.setTransform(m.a / 2, 0, 0, m.d / 2, m.e / 2, m.f / 2);
            b.fillStyle = th.outside;
            b.fillRect(x0, y0, x1 - x0, y1 - y0);
            th.draw(b, x0, y0, x1, y1, size, now, cam);
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.drawImage(this.bg, 0, 0, W, H);
            ctx.restore();
            if (th.lines) th.lines(ctx, x0, y0, x1, y1, size);
            th.border(ctx, size, now);
        },

        emit,
        sparkle(x, y, color) { emit(x, y, 4, { color, speed: 2.5, life: 350, size: 5 }); },
        burst(x, y, colors, n = 40, speed = 7) { emit(x, y, n, { colors, speed, life: 900, size: 9 }); },
        ring(x, y, color) {
            for (let i = 0; i < 28; i++) emit(x, y, 1, { angle: (i / 28) * Math.PI * 2, spread: 0.05, color, speed: 9, life: 500, size: 7, drag: 0.9 });
        },
        explosion(x, y, color) {
            emit(x, y, 50, { colors: [color, '#ffffff', '#ffcc00'], speed: 10, life: 800, size: 10 });
            this.shake(10);
        },
        eruption(x, y) {
            emit(x, y, 90, { colors: ['#ff3c00', '#ff9900', '#ffd27a', '#5a1a00'], speed: 14, life: 1300, size: 13, drag: 0.95, gravity: 0.12 });
        },
        trail(x, y, color) { emit(x, y, 1, { color, speed: 0.8, life: 420, size: 7, drag: 0.9 }); },

        floatText(x, y, text, color = '#ffd700', size = 26) {
            texts.push({ x, y, text, color, size, life: 0, max: 1400 });
            if (texts.length > 20) texts.shift();
        },

        // Secousse d'écran (décroît toute seule)
        shakeAmt: 0,
        shake(n) { this.shakeAmt = Math.min(24, this.shakeAmt + n); },
        shakeOffset(dt) {
            if (this.shakeAmt < 0.2) { this.shakeAmt = 0; return { x: 0, y: 0 }; }
            const a = this.shakeAmt;
            this.shakeAmt *= Math.pow(0.88, dt / 16.7);
            return { x: (Math.random() - 0.5) * a, y: (Math.random() - 0.5) * a };
        },

        // Particules et textes, en coordonnées monde
        drawWorld(ctx, dt) {
            const k = dt / 16.7;
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            for (let i = parts.length - 1; i >= 0; i--) {
                const p = parts[i];
                p.life += dt;
                if (p.life >= p.max) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
                p.x += p.vx * k; p.y += p.vy * k;
                p.vx *= Math.pow(p.drag, k); p.vy = p.vy * Math.pow(p.drag, k) + p.g * k;
                const t = 1 - p.life / p.max;
                const s = p.size * (0.4 + t * 0.9);
                ctx.globalAlpha = Math.min(1, t * 1.4);
                ctx.drawImage(dot(p.color), p.x - s, p.y - s, s * 2, s * 2);
            }
            ctx.restore();

            ctx.save();
            ctx.textAlign = 'center';
            ctx.lineJoin = 'round';
            for (let i = texts.length - 1; i >= 0; i--) {
                const t = texts[i];
                t.life += dt;
                if (t.life >= t.max) { texts.splice(i, 1); continue; }
                const p = t.life / t.max;
                const scale = p < 0.15 ? 0.6 + p / 0.15 * 0.6 : 1.2 - Math.min(0.2, (p - 0.15));
                ctx.globalAlpha = p > 0.7 ? 1 - (p - 0.7) / 0.3 : 1;
                ctx.font = `900 ${t.size * scale}px 'Segoe UI', sans-serif`;
                ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                ctx.strokeText(t.text, t.x, t.y - p * 70);
                ctx.fillStyle = t.color;
                ctx.fillText(t.text, t.x, t.y - p * 70);
            }
            ctx.restore();
        },

        // Calques écran : braises (Volcan) et vignette
        vignette: null,
        resize(w, h) {
            const c = makeCanvas(Math.max(1, w >> 2), Math.max(1, h >> 2));
            const g = c.getContext('2d');
            const gr = g.createRadialGradient(c.width / 2, c.height / 2, Math.min(c.width, c.height) * 0.35, c.width / 2, c.height / 2, Math.max(c.width, c.height) * 0.75);
            gr.addColorStop(0, 'rgba(0,0,0,0)');
            gr.addColorStop(1, 'rgba(0,0,0,0.6)');
            g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height);
            this.vignette = c;
        },
        drawScreen(ctx, key, W, H, dt, scale) {
            if (key === 'volcan') {
                const k = dt / 16.7;
                while (embers.length < 50) {
                    embers.push({ x: Math.random() * W, y: H + Math.random() * H * 0.5, vx: (Math.random() - 0.5) * 0.6, vy: -(0.6 + Math.random() * 1.6), s: 1 + Math.random() * 2.5, ph: Math.random() * 6 });
                }
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                for (const e of embers) {
                    e.x += (e.vx + Math.sin(e.ph += 0.03 * k) * 0.4) * k * scale; e.y += e.vy * k * scale;
                    if (e.y < -20) { e.y = H + 10; e.x = Math.random() * W; }
                    const s = e.s * scale * 3;
                    ctx.globalAlpha = 0.5 + Math.sin(e.ph * 3) * 0.3;
                    ctx.drawImage(dot('#ff7a1a'), e.x - s, e.y - s, s * 2, s * 2);
                }
                ctx.restore();
                // Lueur de chaleur en bas de l'écran
                const gr = ctx.createLinearGradient(0, H * 0.6, 0, H);
                gr.addColorStop(0, 'rgba(255,60,0,0)');
                gr.addColorStop(1, 'rgba(255,60,0,0.12)');
                ctx.fillStyle = gr; ctx.fillRect(0, H * 0.6, W, H * 0.4);
            }
            if (this.vignette) ctx.drawImage(this.vignette, 0, 0, W, H);
        },

        clear() { parts.length = 0; texts.length = 0; this.shakeAmt = 0; }
    };

    root.SnakeFX = FX;
})(window);
