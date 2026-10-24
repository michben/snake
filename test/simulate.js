// Test de fumée du moteur partagé : simule 2 minutes de jeu avec bots et un joueur.
const assert = require('assert');
const { World, CONFIG, CHESTS, LEVELS, WORLD_EVENTS } = require('../public/js/core.js');

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
assert(world.foods.length >= LEVELS.neon.maxFood && world.foods.length <= CONFIG.FOOD_HARD_CAP, 'nourriture bornée');
assert(snap.me && snap.s.some(s => s.id === 'p1'), 'le joueur est dans son snapshot');
assert(snap.f.length < full.f.length, 'le viewport culling réduit la nourriture envoyée');
assert.strictEqual(snap.d.length, CONFIG.DENSITY_GRID ** 2, 'grille de densité');
assert(Array.isArray(snap.it) && Array.isArray(snap.ch), 'bonus et coffres dans le snapshot');
assert(fx.chest > 0 && fx.power > 0, 'des coffres et des bonus ont été ramassés');
assert(world.items.length <= LEVELS.neon.chests + LEVELS.neon.powerups, 'bonus bornés');

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
w2.openChest(w2.snakes.a, { x: 2000, y: 2000, kind: 'normal' });
assert(w2.snakes.a.score >= before + CHESTS.normal.gold[0], 'le coffre donne des points');

// Crocs : le serpent touché meurt à la place de celui qui a les crocs
const w3 = new World({ botCount: 0 });
const c = w3.addSnake('c', 'C', 'neon', false), d = w3.addSnake('d', 'D', 'neon', false);
w3.grantPower(c, 'blade');
c.x = d.segments[8].x; c.y = d.segments[8].y; c.segments[0] = { x: c.x, y: c.y };
w3.step();
assert(w3.snakes.c && !w3.snakes.d, 'les crocs tuent le serpent touché');
assert(w3.drainEvents().some(e => e.type === 'death' && e.id === 'd' && e.killerId === 'c'), 'kill crédité');

// Niveau Volcan : éruptions, coffres légendaires
const v = new World({ level: 'volcan' });
v.addSnake('p', 'P', 'neon', false);
let booms = 0;
for (let i = 0; i < CONFIG.TICK_RATE * 90; i++) { v.step(); booms += v.booms.length; v.drainEvents(); if (!v.snakes.p) v.addSnake('p', 'P', 'neon', false); }
assert.strictEqual(v.size, LEVELS.volcan.size, 'taille du volcan');
assert(booms > 0, 'des éruptions ont eu lieu');
assert(v.countItems('chest', 'legend') <= LEVELS.volcan.legendary + booms, 'légendaires bornés');
console.log(`Volcan : ${booms} éruptions en 90 s`);

// Nouveaux pouvoirs : géant, fantôme, blizzard, onde de choc, portail
const w4 = new World({ botCount: 0, eventEvery: [1e6, 1e6] });
const e = w4.addSnake('e', 'E', 'neon', false), f = w4.addSnake('f', 'F', 'neon', false);
w4.moveSnake(e, 1000 - e.x, 2000 - e.y); w4.moveSnake(f, 1000 - f.x, 1700 - f.y); f.score = 2000;
w4.grantPower(e, 'freeze');
assert(f.frozenUntil > w4.tick, 'le blizzard gèle les voisins');
const fScore = f.score;
w4.grantPower(e, 'shock');
assert(f.score < fScore && w4.foods.length > LEVELS.neon.maxFood, "l'onde de choc fait lâcher des orbes");
w4.grantPower(e, 'giant'); w4.step();
assert(w4.snakes.e.radius > 20, 'le géant grossit');
w4.grantPower(e, 'ghost');
w4.removeSnake('f'); w4.moveSnake(e, 3 - e.x, 0); e.angle = e.targetAngle = Math.PI;
for (let i = 0; i < 3; i++) w4.step();
assert(w4.snakes.e && w4.snakes.e.x > w4.size / 2, 'le fantôme traverse le mur');
w4.grantPower(w4.snakes.e, 'portal');
const nearest = Math.min(...w4.items.filter(it => it.type === 'chest').map(it => Math.hypot(w4.snakes.e.x - it.x, w4.snakes.e.y - it.y)));
assert(nearest < 400, 'le portail mène près d\'un coffre');

// Événements fous : chacun démarre, se termine, et l'Hydre lâche ses trésors
const w5 = new World({ botCount: 2, eventEvery: [1, 2] });
w5.addSnake('h', 'H', 'neon', false);
const seen = new Set();
for (let i = 0; i < CONFIG.TICK_RATE * 400 && seen.size < Object.keys(WORLD_EVENTS).length; i++) {
    w5.step();
    for (const ev of w5.drainEvents()) if (ev.type === 'world') seen.add(ev.kind);
    if (!w5.snakes.h) w5.addSnake('h', 'H', 'neon', false);
}
assert.strictEqual(seen.size, Object.keys(WORLD_EVENTS).length, 'tous les événements fous se déclenchent');
w5.endWorldEvent();
w5.startWorldEvent('boss');
assert(w5.snakes.boss && w5.snakes.boss.radius > 30, "l'Hydre apparaît");
assert.deepStrictEqual(w5.snapshotFor('h', { x: 0, y: 0, w: 1e5, h: 1e5 }).we[0], 'boss', 'événement dans le snapshot');
const legends = w5.countItems('chest', 'legend');
w5.killSnake('boss', 'h');
assert(w5.countItems('chest', 'legend') === legends + 2, "l'Hydre lâche deux coffres légendaires");
assert(w5.drainEvents().some(ev => ev.type === 'bossDown' && ev.killerId === 'h'), 'chute de l\'Hydre annoncée');
w5.step();
assert(!w5.worldEvent, "l'événement s'arrête quand l'Hydre tombe");
console.log(`Événements fous : ${[...seen].join(', ')}`);

const avg = (ms / ticks).toFixed(3);
console.log(`OK — ${ticks} ticks en ${ms} ms (${avg} ms/tick), ${deaths} morts dont ${kills} kills`);
console.log(`Bonus : ${fx.chest} coffres ouverts, ${fx.power} améliorations ramassées, ${fx.powerEnd} expirées`);
console.log(`Snapshot culled : ${JSON.stringify(snap).length} octets vs ${JSON.stringify(full).length} octets sans culling`);
