// Test de fumée du moteur partagé : simule 2 minutes de jeu avec bots et un joueur.
const assert = require('assert');
const { World, CONFIG } = require('../public/js/core.js');

const world = new World({ botCount: 12 });
world.addSnake('p1', 'Testeur', 'michben', false);
let deaths = 0, kills = 0;
const fx = { chest: 0, power: 0, powerEnd: 0 };
const t0 = Date.now();
const ticks = CONFIG.TICK_RATE * 120;
for (let i = 0; i < ticks; i++) {
    if (world.snakes.p1) world.setInput('p1', Math.sin(i / 40) * Math.PI, i % 90 < 10);
    world.step();
    for (const ev of world.drainEvents()) {
        if (ev.type !== 'death') { fx[ev.type]++; continue; }
        deaths++;
        if (ev.killerId) kills++;
        if (ev.id === 'p1') world.addSnake('p1', 'Testeur', 'michben', false);
    }
}
const ms = Date.now() - t0;
const snap = world.snapshotFor('p1', { x: world.snakes.p1.x, y: world.snakes.p1.y, w: 1600, h: 1000 }, true);
const full = world.snapshotFor('p1', { x: world.size / 2, y: world.size / 2, w: 1e5, h: 1e5 }, true);

for (const s of Object.values(world.snakes)) {
    assert(isFinite(s.x) && isFinite(s.y), 'position finie');
    assert(s.segments.length >= CONFIG.INITIAL_LENGTH, 'longueur minimale');
}
assert(world.foods.length >= CONFIG.MAX_FOOD && world.foods.length <= CONFIG.FOOD_HARD_CAP, 'nourriture bornée');
assert(snap.me && snap.s.some(s => s.id === 'p1'), 'le joueur est dans son snapshot');
assert(snap.f.length < full.f.length, 'le viewport culling réduit la nourriture envoyée');
assert.strictEqual(snap.d.length, CONFIG.DENSITY_GRID ** 2, 'grille de densité');
assert(Array.isArray(snap.it) && Array.isArray(snap.ch), 'bonus et coffres dans le snapshot');
assert(fx.chest > 0 && fx.power > 0, 'des coffres et des bonus ont été ramassés');
assert(world.items.length <= CONFIG.MAX_CHESTS + CONFIG.MAX_POWERUPS, 'bonus bornés');

// Bouclier : le joueur traverse un corps sans mourir et rebondit sur la bordure
const w2 = new World({ botCount: 0 });
const a = w2.addSnake('a', 'A', 'neon', false), b = w2.addSnake('b', 'B', 'neon', false);
w2.grantPower(a, 'shield');
a.x = b.segments[5].x; a.y = b.segments[5].y; a.segments[0] = { x: a.x, y: a.y };
w2.step();
assert(w2.snakes.a, 'le bouclier protège des corps');
a.x = 2; a.y = 2000; a.angle = a.targetAngle = Math.PI;
for (let i = 0; i < 3; i++) w2.step();
assert(w2.snakes.a && w2.snakes.a.x >= 0, 'le bouclier fait rebondir sur la bordure');
const before = w2.snakes.a.score;
w2.openChest(w2.snakes.a, { x: 2000, y: 2000 });
assert(w2.snakes.a.score >= before + CONFIG.CHEST_GOLD_MIN, 'le coffre donne des points');

const avg = (ms / ticks).toFixed(3);
console.log(`OK — ${ticks} ticks en ${ms} ms (${avg} ms/tick), ${deaths} morts dont ${kills} kills`);
console.log(`Bonus : ${fx.chest} coffres ouverts, ${fx.power} améliorations ramassées, ${fx.powerEnd} expirées`);
console.log(`Snapshot culled : ${JSON.stringify(snap).length} octets vs ${JSON.stringify(full).length} octets sans culling`);
