// Test de fumée du moteur partagé : simule 2 minutes de jeu avec bots et un joueur.
const assert = require('assert');
const { World, CONFIG } = require('../public/js/core.js');

const world = new World({ botCount: 12 });
world.addSnake('p1', 'Testeur', 'michben', false);
let deaths = 0, kills = 0;
const t0 = Date.now();
const ticks = CONFIG.TICK_RATE * 120;
for (let i = 0; i < ticks; i++) {
    if (world.snakes.p1) world.setInput('p1', Math.sin(i / 40) * Math.PI, i % 90 < 10);
    world.step();
    for (const ev of world.drainEvents()) {
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

const avg = (ms / ticks).toFixed(3);
console.log(`OK — ${ticks} ticks en ${ms} ms (${avg} ms/tick), ${deaths} morts dont ${kills} kills`);
console.log(`Snapshot culled : ${JSON.stringify(snap).length} octets vs ${JSON.stringify(full).length} octets sans culling`);
