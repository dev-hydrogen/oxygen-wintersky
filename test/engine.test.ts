import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parse as parseJsonc } from 'jsonc-parser';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { facingBasis, ParticleWorld, pickRandom, type EffectDefinition, type SpawnOptions } from '../src/index';

type Components = Record<string, unknown>;

function effect(components: Components, extra: Record<string, unknown> = {}) {
	return {
		format_version: '1.10.0',
		particle_effect: {
			description: { identifier: 'test:fx', basic_render_parameters: { material: 'particles_alpha', texture: 'textures/particle/particles' } },
			components: {
				'minecraft:particle_appearance_billboard': { size: [0.1, 0.1], facing_camera_mode: 'rotate_xyz' },
				...components,
			},
			...extra,
		},
	};
}

function setup(json: unknown, opts: ConstructorParameters<typeof ParticleWorld>[0] = {}, spawn: SpawnOptions = {}) {
	const world = new ParticleWorld({ seed: 42, ...opts });
	const def = world.loadEffect(json);
	world.resolveEffect = (id) => (id === def.identifier ? def : null);
	const emitter = world.spawn(def, { position: [0, 0, 0], ...spawn });
	return { world, def, emitter };
}

const DT = 1 / 60;
const steps = (world: ParticleWorld, n: number, dt = DT) => {
	for (let i = 0; i < n; i++) world.step(dt);
};
const v = (world: ParticleWorld, emitterVars: unknown[], name: string) => emitterVars[world.symbols.variable(name)];

describe('definition', () => {
	it('reads Molang as string, number and {expression, version}', () => {
		const { def } = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: { expression: 'v.a ?? 3', version: 12 } },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: '2' },
			}),
		);
		expect(def.failed).toBeNull();
		expect(def.emitter.rate?.type).toBe('instant');
		expect(def.particle.maxLifetime?.constant).toBe(2);
	});
	it('a Molang error drops only that field, which takes its default (t03/t28)', () => {
		const { def, world, emitter } = setup(
			effect({
				'minecraft:emitter_initialization': { creation_expression: 'v.ran = 1; v.x = 1 +;' },
				'minecraft:emitter_rate_instant': { num_particles: 5 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 2 },
				'minecraft:particle_appearance_billboard': { size: ['0.2 +* 2', 0.3], facing_camera_mode: 'rotate_xyz' },
				'minecraft:particle_appearance_tinting': { color: ['q.not_a_query', 0, 0, 1] },
			}),
			{ queryExists: (n) => n !== 'query.not_a_query' },
		);
		expect(def.failed).toBeNull();
		expect(def.particle.billboard!.size[0].broken?.message).toBeTruthy();
		expect(def.diagnostics.some((d) => d.message.startsWith('Failed to resolve query query.not_a_query'))).toBe(true);
		world.step(DT);
		expect(world.particleCount).toBe(5);
		// statements in the broken expression never run, not even the valid ones before the error
		expect(emitter.vars[world.symbols.variable('variable.ran')]).toBeUndefined();
		expect(emitter.pool.size[0]).toBe(1); // broken width -> default 1
		expect(emitter.pool.size[1]).toBeCloseTo(0.3, 5);
		expect(emitter.pool.color[0]).toBe(255); // broken red -> default 1
	});
	it('an effect without an identifier cannot be registered', () => {
		const json = effect({ 'minecraft:emitter_rate_instant': { num_particles: 5 } });
		delete (json.particle_effect.description as { identifier?: string }).identifier;
		const world = new ParticleWorld();
		expect(world.loadEffect(json).failed).not.toBeNull();
	});
	it('parses Bedrock #AARRGGBB colors (alpha first)', () => {
		const { def } = setup(effect({ 'minecraft:particle_appearance_tinting': { color: '#80FF0000' } }));
		const t = def.particle.tint;
		expect(t?.type).toBe('color');
		if (t?.type === 'color') {
			expect(t.color[0].constant).toBe(1);
			expect(t.color[3].constant).toBeCloseTo(128 / 255, 5);
		}
	});
});

describe('evaluation order', () => {
	it('runs emitter update, then each particle fully, then render prep per particle', () => {
		const { world } = setup(
			effect({
				'minecraft:emitter_initialization': { per_update_expression: 'v.u = 1;' },
				'minecraft:emitter_rate_instant': { num_particles: 2 },
				'minecraft:emitter_lifetime_once': { active_time: 5 },
				'minecraft:particle_initialization': { per_update_expression: 'v.pu = 1;', per_render_expression: 'v.pr = 1;' },
				'minecraft:particle_motion_parametric': { relative_position: ['v.px = 1; return 0;', 0, 0] },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10, expiration_expression: 'v.x = 1; return 0;' },
			}),
		);
		world.debug.log = true;
		world.step(DT);
		const order = world.log.map((l) => `${l.phase}:${l.path.split('/').slice(-2).join('/')}:${l.particle}`);
		const idx = (needle: string) => order.findIndex((o) => o.includes(needle));
		const ids = [...new Set(world.log.filter((l) => l.particle > 0).map((l) => l.particle))];
		expect(ids.length).toBe(2);
		const [a, b] = ids;
		// emitter per_update before particles
		expect(idx('emitter-update:minecraft:emitter_initialization/per_update_expression')).toBeLessThan(idx(`particle-update:minecraft:particle_initialization/per_update_expression:${a}`));
		// particle A's whole update (per_update → motion → expiration) precedes particle B's
		const aExp = idx(`particle-update:minecraft:particle_lifetime_expression/expiration_expression:${a}`);
		const bPer = idx(`particle-update:minecraft:particle_initialization/per_update_expression:${b}`);
		expect(idx(`particle-update:relative_position/0:${a}`)).toBeLessThan(aExp);
		expect(aExp).toBeLessThan(bPer);
		// all updates before any render prep
		const lastUpdate = Math.max(...order.map((o, i) => (o.startsWith('particle-update') ? i : -1)));
		const firstRender = order.findIndex((o) => o.startsWith('render'));
		expect(lastUpdate).toBeLessThan(firstRender);
	});

	it('update→render variable carry is NOT per particle (shared emitter map)', () => {
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 3 },
				'minecraft:emitter_lifetime_once': { active_time: 5 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
				'minecraft:particle_motion_parametric': { relative_position: ['v.mine = v.particle_random_1; return 0;', 0, 0] },
				'minecraft:particle_appearance_billboard': { size: ['v.mine', 'v.particle_random_1'], facing_camera_mode: 'rotate_xyz' },
			}),
		);
		world.step(DT);
		const p = emitter.pool;
		const widths = [0, 1, 2].map((i) => p.size[i * 2]);
		const heights = [0, 1, 2].map((i) => p.size[i * 2 + 1]);
		// every particle sees the LAST particle's v.mine
		expect(new Set(widths).size).toBe(1);
		expect(widths[0]).toBeCloseTo(p.random[2 * 4], 5);
		// while built-ins are refreshed per particle at render time
		expect(new Set(heights).size).toBe(3);
	});

	it('a statement expression without return evaluates to 0.0 for value fields', () => {
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 1 },
				'minecraft:emitter_lifetime_once': { active_time: 5 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
				'minecraft:particle_appearance_billboard': { size: ['v.s = 0.5; v.s', 'v.s = 0.5; return v.s;'], facing_camera_mode: 'rotate_xyz' },
			}),
		);
		world.step(DT);
		expect(emitter.pool.size[0]).toBe(0);
		expect(emitter.pool.size[1]).toBe(0.5);
	});

	it('context.* reads what the host supplied, and is unset (0) without it', () => {
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 1 },
				'minecraft:emitter_lifetime_once': { active_time: 5 },
				'minecraft:emitter_initialization': { per_update_expression: 'v.a = c.size; v.b = context.missing + 1;' },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
			}),
		);
		world.contexts[world.symbols.context('context.size')] = 3;
		world.step(DT);
		expect(v(world, emitter.vars, 'variable.a')).toBe(3);
		// an unset read aborts the expression, as for variables (t01)
		expect(v(world, emitter.vars, 'variable.b')).toBeUndefined();
		const snap = world.snapshot();
		world.contexts.length = 0;
		world.restore(snap);
		expect(world.contexts[world.symbols.context('context.size')]).toBe(3);
	});

	it('expiration_expression is tested after motion and age advance', () => {
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 1 },
				'minecraft:emitter_lifetime_once': { active_time: 5 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10, expiration_expression: 'v.particle_age > 0' },
			}),
		);
		world.step(DT);
		expect(emitter.pool.count).toBe(0); // age already advanced past 0 when tested
	});

	it('setup-time fields read values from before creation_expression', () => {
		const { world } = setup(
			effect({
				'minecraft:emitter_initialization': { creation_expression: 'v.time = 2;' },
				'minecraft:emitter_rate_steady': { spawn_rate: 100, max_particles: 100 },
				'minecraft:emitter_lifetime_once': { active_time: 'v.time ?? 0' },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
			}),
		);
		steps(world, 30);
		// active_time evaluated before creation set v.time → 0 → never active → nothing spawns
		expect(world.particleCount).toBe(0);
	});
});

describe('emitter lifetime', () => {
	it('unset active_time: steady spawns nothing, an instant burst still fires once (t02)', () => {
		const steady = setup(
			effect({
				'minecraft:emitter_rate_steady': { spawn_rate: 100, max_particles: 100 },
				'minecraft:emitter_lifetime_looping': { active_time: 'v.unset_time' },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
			}),
			{},
			{ context: 'entity' },
		);
		steps(steady.world, 120);
		expect(steady.world.particleCount).toBe(0);
		const burst = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 10 },
				'minecraft:emitter_lifetime_looping': { active_time: 'v.unset_time' },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
			}),
			{},
			{ context: 'entity' },
		);
		steps(burst.world, 120);
		expect(burst.world.particleCount).toBe(10); // a zero-length loop never restarts
		expect(burst.emitter.loopIndex).toBe(0);
	});

	it('instant bursts fire even when active_time is 0 (t02)', () => {
		const { world } = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 3 },
				'minecraft:emitter_lifetime_once': { active_time: 0 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 1 },
			}),
		);
		world.step(DT);
		expect(world.particleCount).toBe(3);
	});

	it('/particle and Script API emitters play a single loop (t31/t38)', () => {
		for (const context of ['command', 'script'] as const) {
			const { world, emitter } = setup(
				effect({
					'minecraft:emitter_rate_instant': { num_particles: 1 },
					'minecraft:emitter_lifetime_looping': { active_time: 0.5, sleep_time: 0 },
					'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
				}),
				{},
				{ context },
			);
			steps(world, 300);
			expect(emitter.loopIndex).toBe(0);
			expect(emitter.expired).toBe(true);
			expect(world.particleCount).toBe(1);
		}
	});

	it('looping: each loop is a new emitter, and particles outlive the loop (#91)', () => {
		const world = new ParticleWorld({ seed: 42 });
		const def = world.loadEffect(
			effect(
				{
					'minecraft:emitter_initialization': { creation_expression: 'v.r = v.emitter_random_1;', per_update_expression: 'v.count = (v.count ?? 0) + 1;' },
					'minecraft:emitter_rate_instant': { num_particles: 1 },
					'minecraft:emitter_lifetime_looping': { active_time: 0.5, sleep_time: 0.5 },
					'minecraft:emitter_lifetime_events': { creation_event: 'born', timeline: { '0.95': 'late' } },
					'minecraft:particle_lifetime_expression': { max_lifetime: 3 },
				},
				{ events: { born: { expression: 't.born = (t.born ?? 0) + 1;' }, late: { expression: 't.late = (t.late ?? 0) + 1;' } } },
			),
		);
		world.resolveEffect = () => null;
		const emitter = world.spawn(def, { context: 'entity', variables: { 'v.given': 7 } });
		steps(world, 130); // ~2.17 s → 3 loops
		expect(emitter.loopIndex).toBe(2);
		// earlier loops' particles are still alive, each with the emitter of its loop (expired)
		expect(emitter.pool.count).toBe(1);
		expect(world.particleCount).toBe(3);
		const earlier = world.emitters.filter((e) => e !== emitter);
		expect(earlier.map((e) => [e.expired, e.pool.count, e.def])).toEqual([
			[true, 1, def],
			[true, 1, def],
		]);
		expect(emitter.age).toBeLessThan(1);
		// v.* started over this loop (about 10 updates in), and the spawner's variables came back
		expect(v(world, emitter.vars, 'variable.count')).toBeLessThan(15);
		expect(v(world, emitter.vars, 'variable.given')).toBe(7);
		// creation ran with this loop's randoms; the creation event fired every loop
		expect(v(world, emitter.vars, 'variable.r')).toBe(emitter.randoms[0]);
		expect(world.temps.entries(world.symbols.tempNames).find(([k]) => k === 'temp.born')?.[1]).toBe(3);
		// a timeline event late in the loop fires even when the loop wraps within the frame
		expect(world.temps.entries(world.symbols.tempNames).find(([k]) => k === 'temp.late')?.[1]).toBe(2);
		// coarse frames: 0.9 s → 1.0 s wraps the loop with 0.95 s still due
		const coarse = new ParticleWorld({ seed: 42 });
		const d2 = coarse.loadEffect(
			effect({ 'minecraft:emitter_rate_instant': { num_particles: 1 }, 'minecraft:emitter_lifetime_looping': { active_time: 1 }, 'minecraft:emitter_lifetime_events': { timeline: { '0.95': 'late' } } }, { events: { late: { expression: 't.coarse = (t.coarse ?? 0) + 1;' } } }),
		);
		coarse.spawn(d2, { context: 'entity' });
		steps(coarse, 25, 0.1);
		expect(coarse.temps.entries(coarse.symbols.tempNames).find(([k]) => k === 'temp.coarse')?.[1]).toBe(2);
	});

	it("a new loop counts and caps its own particles, and the last loop's keep their variables (index counters)", () => {
		// a burst laid out by an index counter the emitter resets every update (the aurora example's pattern)
		const json = effect({
			'minecraft:emitter_initialization': { per_update_expression: 'v.next = 0;' },
			'minecraft:emitter_rate_instant': { num_particles: 600 },
			'minecraft:emitter_lifetime_looping': { active_time: 1 },
			'minecraft:particle_lifetime_expression': { max_lifetime: 1.5 },
			'minecraft:particle_initialization': { per_update_expression: 'v.index = v.next; v.next = v.next + 1;' },
			'minecraft:particle_motion_parametric': { relative_position: ['v.index / 100', 0, 0] },
		});
		// /particle's cap of 1000, looping in place like the editor's Repeat
		const { world, emitter } = setup(json, {}, { loop: true });
		steps(world, 70); // into the second loop, with the first one's particles still out
		const old = world.emitters.find((e) => e !== emitter)!;
		expect(old.expired).toBe(true);
		expect(old.pool.count).toBe(600);
		// the new burst wasn't cut short by the old particles
		expect(emitter.pool.count).toBe(600);
		// each loop's particles are laid out by their own counter: 0 … 5.99 both times
		const xs = (e: typeof emitter) => [...e.pool.pos.filter((_, k) => k % 3 === 0).subarray(0, e.pool.count)].map((x) => Math.round(x * 100));
		expect(xs(emitter)).toEqual([...Array(600).keys()]);
		expect(xs(old)).toEqual([...Array(600).keys()]);
		steps(world, 40);
		expect(world.emitters).toEqual([emitter]);
	});

	it('expiration events fire and particles survive emitter expiry', () => {
		const { world, emitter } = setup(
			effect(
				{
					'minecraft:emitter_rate_instant': { num_particles: 4 },
					'minecraft:emitter_lifetime_once': { active_time: 0.1 },
					'minecraft:emitter_lifetime_events': { expiration_event: 'bye' },
					'minecraft:particle_lifetime_expression': { max_lifetime: 1 },
				},
				{ events: { bye: { expression: 'v.gone = 1;' } } },
			),
		);
		steps(world, 10);
		expect(emitter.expired).toBe(true);
		expect(v(world, emitter.vars, 'variable.gone')).toBe(1);
		expect(emitter.pool.count).toBe(4);
		steps(world, 60);
		expect(world.emitters.length).toBe(0);
	});
});

describe('particles', () => {
	it('lifetime 0 dies on the first update', () => {
		const { world } = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 5 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 0 },
			}),
		);
		world.step(DT);
		expect(world.particleCount).toBe(0);
	});

	it('caps live particles at 1000 per emitter, on an entity too (t42/t43, e09)', () => {
		const json = effect({
			'minecraft:emitter_rate_instant': { num_particles: 25000 },
			'minecraft:emitter_lifetime_once': { active_time: 1 },
			'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
		});
		const { world, emitter } = setup(json);
		const second = world.spawn(emitter.def, { position: [0, 0, 0] });
		world.step(DT);
		expect(emitter.pool.count).toBe(1000);
		expect(second.pool.count).toBe(1000); // per emitter, not global
		expect([...world.errors.values()].some((e) => e.code === 'cap')).toBe(true);
		const entity = setup(json, {}, { context: 'entity' });
		entity.world.step(DT);
		expect(entity.emitter.pool.count).toBe(1000);
		const raised = setup(json, { particleCap: { entity: 5000 } }, { context: 'entity' });
		raised.world.step(DT);
		expect(raised.emitter.pool.count).toBe(5000);
	});

	it('spheres and discs spawn denser toward the centre: the distance is the mean of two randoms', () => {
		for (const shape of [{ 'minecraft:emitter_shape_sphere': { radius: 2 } }, { 'minecraft:emitter_shape_disc': { radius: 2 } }]) {
			const { world, emitter } = setup(
				effect({
					'minecraft:emitter_rate_instant': { num_particles: 1000 },
					'minecraft:emitter_lifetime_once': { active_time: 1 },
					'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
					...shape,
				}),
			);
			world.step(DT);
			const p = emitter.pool;
			const d = Array.from({ length: p.count }, (_, i) => Math.hypot(p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]) / 2);
			const mean = d.reduce((a, b) => a + b, 0) / d.length;
			const inside = (lo: number, hi: number) => d.filter((x) => x >= lo && x < hi).length / d.length;
			expect(Math.max(...d)).toBeLessThanOrEqual(1);
			expect(mean).toBeCloseTo(0.5, 1); // uniform volume would average 0.75, uniform area 0.67
			// triangular: 12.5% within a quarter of the radius, 50% within half
			expect(inside(0, 0.25)).toBeGreaterThan(0.09);
			expect(inside(0, 0.25)).toBeLessThan(0.16);
			expect(inside(0, 0.5)).toBeGreaterThan(0.45);
			expect(inside(0, 0.5)).toBeLessThan(0.55);
		}
	});

	it('no lifetime component: dies immediately; component without max_lifetime: lives (t07)', () => {
		const none = setup(effect({ 'minecraft:emitter_rate_instant': { num_particles: 2 }, 'minecraft:emitter_lifetime_once': { active_time: 1 } }));
		none.world.step(DT);
		expect(none.world.particleCount).toBe(0);
		const open = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 2 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': {},
			}),
		);
		steps(open.world, 600);
		expect(open.world.particleCount).toBe(2);
	});

	it('collides with real block boxes: rests on a slab top (t17)', () => {
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 1 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
				'minecraft:particle_motion_dynamic': { linear_acceleration: [0, -10, 0] },
				'minecraft:particle_motion_collision': { collision_radius: 0.1 },
			}),
		);
		world.blocks = {
			getBlock: (x, y, z) => (x === 0 && y === -2 && z === 0 ? 'minecraft:stone_slab' : 'minecraft:air'),
			isSolid: (id) => id !== 'minecraft:air',
			getCollisionBoxes: (id) => (id === 'minecraft:stone_slab' ? [[0, 0, 0, 1, 0.5, 1]] : undefined),
		};
		emitter.position = [0.5, 0, 0.5];
		emitter.pool.pos[0] = 0.5;
		emitter.pool.pos[2] = 0.5;
		steps(world, 240);
		expect(emitter.pool.pos[1]).toBeCloseTo(-1.5 + 0.1, 3);
	});

	it('kill plane is a crossing test, not a half-space test', () => {
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 1 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
				'minecraft:particle_initial_speed': 6,
				'minecraft:emitter_shape_point': { direction: [0, 1, 0], offset: [0, 2, 0] },
				'minecraft:particle_motion_dynamic': {},
				// plane y = 1 (above the emitter); the particle starts ABOVE it and rises → never crosses
				'minecraft:particle_kill_plane': [0, 1, 0, -1],
			}),
		);
		steps(world, 30);
		expect(emitter.pool.count).toBe(1);
	});

	it('kill plane kills a particle that moves through it', () => {
		const { world } = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 1 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
				'minecraft:particle_initial_speed': 6,
				'minecraft:emitter_shape_point': { direction: [0, 1, 0] },
				'minecraft:particle_motion_dynamic': {},
				'minecraft:particle_kill_plane': [0, 1, 0, -1],
			}),
		);
		steps(world, 30);
		expect(world.particleCount).toBe(0);
	});

	it('collides with a ground plane and bounces', () => {
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 1 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
				'minecraft:emitter_shape_point': { offset: [0, 2, 0] },
				'minecraft:particle_motion_dynamic': { linear_acceleration: [0, -20, 0] },
				'minecraft:particle_motion_collision': { collision_radius: 0.1, coefficient_of_restitution: 0.5 },
			}),
		);
		world.planes.push({ normal: [0, 1, 0], d: 0, block: 'minecraft:stone' });
		let minY = Infinity;
		for (let i = 0; i < 120; i++) {
			world.step(DT);
			minY = Math.min(minY, emitter.pool.pos[1]);
		}
		expect(minY).toBeGreaterThan(0.05);
		expect(minY).toBeLessThan(0.2);
	});

	it('expire_if_in_blocks / not_in_blocks use the block at the particle position', () => {
		const blocks = { getBlock: (_x: number, y: number) => (y < 1 ? 'minecraft:water' : 'minecraft:air'), isSolid: () => false };
		const make = (comp: Components) => {
			const s = setup(effect({ 'minecraft:emitter_rate_instant': { num_particles: 1 }, 'minecraft:emitter_lifetime_once': { active_time: 1 }, 'minecraft:particle_lifetime_expression': { max_lifetime: 10 }, ...comp }));
			s.world.blocks = blocks;
			s.world.step(DT);
			return s.world.particleCount;
		};
		expect(make({ 'minecraft:particle_expire_if_in_blocks': ['minecraft:water'] })).toBe(0);
		expect(make({ 'minecraft:particle_expire_if_not_in_blocks': ['minecraft:water'] })).toBe(1);
		expect(make({ 'minecraft:particle_expire_if_not_in_blocks': ['minecraft:air'] })).toBe(0);
	});

	it('negative size is hidden (#119), zero UV size is a sliver (#118)', () => {
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 1 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
				'minecraft:particle_appearance_billboard': {
					size: [-0.2, 0.2],
					facing_camera_mode: 'rotate_xyz',
					uv: { texture_width: 16, texture_height: 16, uv: [4, 4], uv_size: [0, 8] },
				},
			}),
		);
		world.step(DT);
		expect(emitter.pool.visible[0]).toBe(0);
		expect(emitter.pool.uv[0]).toBe(emitter.pool.uv[2]);
		expect(emitter.pool.uv[3] - emitter.pool.uv[1]).toBe(0.5);
	});

	it('packs tint like the game: trunc(c*255) clamped', () => {
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 1 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
				'minecraft:particle_appearance_tinting': { color: [2, -1, 0.5, 0.999] },
			}),
		);
		world.step(DT);
		expect([...emitter.pool.color.subarray(0, 4)]).toEqual([255, 0, 127, 254]);
	});

	it('gradient tint interpolates between stops', () => {
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 1 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
				'minecraft:particle_appearance_tinting': { color: { interpolant: 0.5, gradient: { '0.0': '#FF000000', '1.0': '#FFFFFFFF' } } },
			}),
		);
		world.step(DT);
		expect([...emitter.pool.color.subarray(0, 4)]).toEqual([127, 127, 127, 255]);
	});

	it('gradient stop channels may be Molang (t69 g1)', () => {
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_initialization': { creation_expression: 'v.red1 = 1; v.green1 = 0; v.blue1 = 0; v.alpha1 = 1;' },
				'minecraft:emitter_rate_instant': { num_particles: 1 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
				'minecraft:particle_appearance_tinting': {
					color: { interpolant: 0.38, gradient: { '0.24': [1, 1, 1, '38 / 255'], '0.52': ['variable.red1', 'variable.green1', 'variable.blue1', 'variable.alpha1'], '1.0': [1, 1, 1, 1] } },
				},
			}),
		);
		world.step(DT);
		// halfway between the first two stops
		expect([...emitter.pool.color.subarray(0, 4)]).toEqual([255, 127, 127, 146]);
	});

	it('flipbook max_frame counts from 1', () => {
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 1 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
				'minecraft:particle_appearance_billboard': {
					size: [0.1, 0.1],
					facing_camera_mode: 'rotate_xyz',
					uv: { texture_width: 8, texture_height: 32, flipbook: { base_UV: [0, 0], size_UV: [8, 8], step_UV: [0, 8], frames_per_second: 10, max_frame: 4 } },
				},
			}),
		);
		steps(world, 120); // 2 s → frame 20, clamped to frame index 3 (the 4th frame)
		expect(emitter.pool.uv[1]).toBe(24 / 32);
	});
});

describe('curves', () => {
	it('linear curve nodes may be Molang (#110)', () => {
		const { world, emitter } = setup(
			effect(
				{
					'minecraft:emitter_initialization': { creation_expression: 'v.peak = 8;' },
					'minecraft:emitter_rate_instant': { num_particles: 1 },
					'minecraft:emitter_lifetime_once': { active_time: 1 },
					'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
					'minecraft:particle_appearance_billboard': { size: ['v.c', 'v.c'], facing_camera_mode: 'rotate_xyz' },
				},
				{ curves: { 'variable.c': { type: 'linear', input: 0.5, horizontal_range: 1, nodes: [0, 'v.peak', 0] } } },
			),
		);
		world.step(DT);
		expect(emitter.pool.size[0]).toBe(8);
	});

	it('bezier_chain holds the first/last value and ignores horizontal_range (#123)', () => {
		const make = (input: number) => {
			const { world, emitter } = setup(
				effect(
					{
						'minecraft:emitter_rate_instant': { num_particles: 1 },
						'minecraft:emitter_lifetime_once': { active_time: 1 },
						'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
						'minecraft:particle_appearance_billboard': { size: ['v.c', 'v.c'], facing_camera_mode: 'rotate_xyz' },
					},
					{
						curves: {
							'variable.c': {
								type: 'bezier_chain',
								input,
								horizontal_range: 100,
								nodes: { '0.5': { value: 1, slope: 0 }, '0.25': { value: 3, slope: 0 }, '1.0': { value: '2 + 2', slope: 0 } },
							},
						},
					},
				),
			);
			world.step(DT);
			return emitter.pool.size[0];
		};
		expect(make(0)).toBe(3); // before first key (keys sorted: 0.25, 0.5, 1.0)
		expect(make(5)).toBe(4); // after last key
		expect(make(0.75)).toBeCloseTo(2.5, 5); // smooth midpoint (not a step)
	});
});

describe('events & temp leaking', () => {
	it('t.* set in an event sequence reaches the child pre_effect_expression', () => {
		const world = new ParticleWorld({ seed: 1 });
		const parent = world.loadEffect(
			effect(
				{
					'minecraft:emitter_initialization': { creation_expression: 'v.secret = 7;' },
					'minecraft:emitter_rate_instant': { num_particles: 0 },
					'minecraft:emitter_lifetime_once': { active_time: 1 },
					'minecraft:emitter_lifetime_events': { creation_event: 'spawn_child' },
				},
				{
					events: {
						spawn_child: {
							sequence: [{ expression: 't.xyz = v.secret;' }, { particle_effect: { effect: 'test:child', type: 'emitter', pre_effect_expression: 'v.got = t.xyz;' } }],
						},
					},
				},
			),
		);
		const childJson = effect({ 'minecraft:emitter_rate_instant': { num_particles: 0 }, 'minecraft:emitter_lifetime_once': { active_time: 1 } });
		childJson.particle_effect.description.identifier = 'test:child';
		const child = world.loadEffect(childJson);
		world.resolveEffect = (id) => (id === 'test:child' ? child : id === 'test:fx' ? parent : null);
		world.spawn(parent, {});
		const c = world.emitters.find((e) => e.def.identifier === 'test:child')!;
		expect(c).toBeTruthy();
		expect(c.vars[world.symbols.variable('variable.got')]).toBe(7);
	});

	it('t.* is global: it persists across expressions, frames and emitters (t05/t30)', () => {
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_initialization': { creation_expression: 't.x = 5;', per_update_expression: 'v.seen = t.x ?? -1;' },
				'minecraft:emitter_rate_instant': { num_particles: 0 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
			}),
		);
		world.step(DT);
		expect(v(world, emitter.vars, 'variable.seen')).toBe(5);
		const reader = world.loadEffect(
			effect({
				'minecraft:emitter_initialization': { creation_expression: 'v.other = t.x ?? -1;' },
				'minecraft:emitter_rate_instant': { num_particles: 0 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
			}),
		);
		const e2 = world.spawn(reader, {});
		expect(v(world, e2.vars, 'variable.other')).toBe(5);
	});
});

describe('determinism & snapshots', () => {
	const json = effect({
		'minecraft:emitter_rate_steady': { spawn_rate: 200, max_particles: 1000 },
		'minecraft:emitter_lifetime_looping': { active_time: 1 },
		'minecraft:emitter_shape_sphere': { radius: 1 },
		'minecraft:particle_initial_speed': 'math.random(1, 3)',
		'minecraft:particle_motion_dynamic': { linear_acceleration: [0, -2, 0] },
		'minecraft:particle_lifetime_expression': { max_lifetime: 'math.random(0.5, 1.5)' },
	});
	it('same seed → identical simulation', () => {
		const a = setup(json);
		const b = setup(json);
		steps(a.world, 90);
		steps(b.world, 90);
		expect(a.emitter.pool.count).toBe(b.emitter.pool.count);
		expect([...a.emitter.pool.pos.subarray(0, 30)]).toEqual([...b.emitter.pool.pos.subarray(0, 30)]);
	});
	it('restore(snapshot) replays exactly', () => {
		const a = setup(json);
		steps(a.world, 30);
		const snap = a.world.snapshot();
		steps(a.world, 30);
		const expected = [...a.emitter.pool.pos.subarray(0, a.emitter.pool.count * 3)];
		a.world.restore(snap);
		steps(a.world, 30);
		const e = a.world.emitters[0];
		expect([...e.pool.pos.subarray(0, e.pool.count * 3)]).toEqual(expected);
	});
});

describe('debugger hooks', () => {
	it('traces intermediate values for the selected particle', () => {
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 2 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
				'minecraft:particle_appearance_billboard': { size: ['v.particle_random_1 * 2', 0.1], facing_camera_mode: 'rotate_xyz' },
			}),
		);
		world.step(DT);
		const target = emitter.pool.id[1];
		world.debug.select = { emitter: emitter.id, particle: target };
		world.step(DT);
		const sizeTrace = world.traces.find((t) => t.path.endsWith('size/0') && t.particle === target)!;
		expect(sizeTrace).toBeTruthy();
		expect(sizeTrace.result).toBeCloseTo(emitter.pool.size[2], 5);
	});
	it('haltAfter stops mid-frame deterministically', () => {
		const { world } = setup(
			effect({
				'minecraft:emitter_initialization': { per_update_expression: 'v.a = 1;' },
				'minecraft:emitter_rate_instant': { num_particles: 3 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10, expiration_expression: 'v.e = 1; return 0;' },
			}),
		);
		world.debug.haltAfter = 2;
		const halt = world.step(DT);
		expect(halt).not.toBeNull();
		expect(halt!.at.phase).toBe('particle-update');
	});
	it('a value changed from outside sticks when a paused frame is drawn again, and the next frame starts from it', () => {
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_initialization': { creation_expression: 'v.size = 1;' },
				'minecraft:emitter_rate_instant': { num_particles: 1 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
				'minecraft:particle_initialization': { per_render_expression: 't.drawn = (t.drawn ?? 0) + 1;' },
				'minecraft:particle_appearance_billboard': { size: ['v.size', 0.1], facing_camera_mode: 'rotate_xyz' },
			}),
		);
		world.step(DT);
		expect(emitter.pool.size[0]).toBeCloseTo(1);
		world.setValue(emitter, 'v.size', 3);
		world.setValue(null, 't.drawn', 10);
		// a paused preview prepares the same frame again: from the changed values, not from what the update left
		world.prepareRender();
		world.prepareRender();
		expect(emitter.pool.size[0]).toBeCloseTo(3);
		expect(world.temps.get(world.symbols.temp('temp.drawn'))).toBe(11);
		world.step(DT);
		expect(emitter.pool.size[0]).toBeCloseTo(3);
		expect(world.temps.get(world.symbols.temp('temp.drawn'))).toBe(12);
	});
});

describe('facing', () => {
	const cam = { position: [0, 0, 5] as [number, number, number], right: [1, 0, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number] };
	const r = (v: number[]) => v.map((x) => Math.round(x * 1e6) / 1e6 + 0);
	const basis = (mode: Parameters<typeof facingBasis>[0], d: [number, number, number]) => facingBasis(mode, [0, 0, 0], d, cam, [0, 0, 0, 1]);
	it('direction_x: X = d, Y up; vertical d faces -Z (t34)', () => {
		const h = basis('direction_x', [0, 0, 1]);
		expect(r(h.right)).toEqual([0, 0, 1]);
		expect(r(h.up)).toEqual([0, 1, 0]);
		const v = basis('direction_x', [0, -1, 0]);
		expect(r(v.right)).toEqual([0, -1, 0]);
		expect(r(v.normal)).toEqual([0, 0, -1]);
	});
	it('direction_y: a horizontal direction lies flat facing +Y; vertical faces +Z (t35)', () => {
		const h = basis('direction_y', [1, 0, 0]);
		expect(r(h.up)).toEqual([1, 0, 0]);
		expect(r(h.normal)).toEqual([0, 1, 0]);
		const down = basis('direction_y', [0, -1, 0]);
		expect(r(down.normal)).toEqual([0, 0, 1]);
		expect(r(down.up)).toEqual([0, -1, 0]); // upside down
	});
	it('direction_z: normal = d with Y up; vertical normal = -d with Y = +Z (t36)', () => {
		const h = basis('direction_z', [0, 0, 2]);
		expect(r(h.normal)).toEqual([0, 0, 1]);
		expect(r(h.up)).toEqual([0, 1, 0]);
		const down = basis('direction_z', [0, -1, 0]);
		expect(r(down.normal)).toEqual([0, 1, 0]);
		expect(r(down.up)).toEqual([0, 0, 1]);
		expect(r(down.right)).toEqual([-1, 0, 0]);
		expect(down.usedFallback).toBe(true);
	});
	it('a zero direction is degenerate (nothing drawn)', () => {
		for (const m of ['direction_x', 'direction_y', 'direction_z', 'lookat_direction'] as const) {
			const b = basis(m, [0, 0, 0]);
			expect(b.degenerate).toBe(true);
			expect(r(b.right)).toEqual([0, 0, 0]);
		}
	});
	it('moves emitters to another world (another thread) and they carry on exactly', () => {
		const json = effect(
			{
				'minecraft:emitter_initialization': { creation_expression: 'v.k = 0;', per_update_expression: 'v.k = v.k + 1;' },
				'minecraft:emitter_rate_steady': { spawn_rate: 30, max_particles: 200 },
				'minecraft:emitter_lifetime_looping': { active_time: 5 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 'math.random(0.3, 0.6)' },
				'minecraft:particle_initial_speed': 2,
				'minecraft:emitter_shape_sphere': { radius: 0.5, direction: 'outwards' },
				'minecraft:particle_motion_dynamic': { linear_acceleration: [0, '-v.k * 0.01', 0] },
				'minecraft:particle_lifetime_events': { expiration_event: 'pop' },
			},
			{ events: { pop: { particle_effect: { effect: 'test:child', type: 'emitter' } } } },
		);
		const child = effect({ 'minecraft:emitter_rate_instant': { num_particles: 2 }, 'minecraft:emitter_lifetime_once': { active_time: 0.2 }, 'minecraft:particle_lifetime_expression': { max_lifetime: 0.3 } });
		(child.particle_effect.description as { identifier: string }).identifier = 'test:child';
		const make = () => {
			const w = new ParticleWorld({ seed: 5 });
			const defs = new Map([json, child].map((j) => {
				const d = w.loadEffect(j);
				return [d.identifier, d] as const;
			}));
			w.resolveEffect = (id) => defs.get(id) ?? null;
			return { w, defs };
		};
		const a = make();
		a.w.spawn(a.defs.get('test:fx')!, { position: [0, 0, 0], context: 'entity' });
		steps(a.w, 40);
		// the reference keeps going in its own world
		const ref = make();
		ref.w.restore(a.w.snapshot());
		// the rest moves to a fresh world (with the random stream it would have used)
		const b = make();
		b.w.rng.state = a.w.rng.state;
		const moved = a.w.export(new Set(a.w.emitters.map((e) => e.id)));
		expect(a.w.emitters).toHaveLength(0);
		const adopted = b.w.adopt(structuredClone(moved), (id) => b.defs.get(id) ?? null);
		expect(adopted.length).toBe(moved.length);
		b.w.reserveIds(1000, 1_000_000);
		ref.w.reserveIds(1000, 1_000_000);
		steps(ref.w, 40);
		steps(b.w, 40);
		const flat = (w: ParticleWorld) => w.emitters.flatMap((e) => [e.def.identifier, ...Array.from(e.pool.pos.subarray(0, e.pool.count * 3))]);
		expect(b.w.emitters.length).toBe(ref.w.emitters.length);
		expect(b.w.emitters.length).toBeGreaterThan(1);
		expect(flat(b.w)).toEqual(flat(ref.w));
		expect(b.w.snapshotVars(b.w.emitters[0].vars)).toEqual(ref.w.snapshotVars(ref.w.emitters[0].vars));
	});
	it('runs beforeUpdate inside every step, so replays from a snapshot see the same inputs', () => {
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_rate_steady': { spawn_rate: 'v.rate', max_particles: 100 },
				'minecraft:emitter_lifetime_looping': { active_time: 10 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
			}),
		);
		const slot = world.symbols.variable('variable.rate');
		let calls = 0;
		world.beforeUpdate = (w) => {
			calls++;
			emitter.vars[slot] = w.time < 0.5 ? 20 : 60;
		};
		steps(world, 30);
		const snap = world.snapshot();
		steps(world, 30);
		const live = world.particleCount;
		world.restore(snap);
		steps(world, 30);
		expect(calls).toBe(90);
		expect(world.particleCount).toBe(live);
		expect(live).toBeGreaterThan(30);
	});
	it('reports every event fired, by emitter and particle, including names the effect lacks', () => {
		const { world, def } = setup(
			effect(
				{
					'minecraft:emitter_rate_instant': { num_particles: 2 },
					'minecraft:emitter_lifetime_once': { active_time: 1 },
					'minecraft:emitter_lifetime_events': { creation_event: ['hello', 'nobody'] },
					'minecraft:particle_lifetime_expression': { max_lifetime: 0.25 },
					'minecraft:particle_lifetime_events': { expiration_event: 'bye' },
				},
				{ events: { hello: { expression: 'v.x = 1;' }, bye: { expression: 'v.y = 1;' } } },
			),
		);
		world.clear();
		const raw: [number, string, number][] = [];
		world.onEvent = (e, name, particle) => raw.push([e.id, name, particle]);
		const emitter = world.spawn(def, { position: [0, 0, 0] });
		steps(world, 30);
		const fired = raw.map(([id, name, particle]) => `${id === emitter.id ? 'root' : id}:${name}:${particle >= 0 ? 'p' : 'e'}`);
		expect(fired.filter((f) => f.endsWith(':e'))).toEqual(['root:hello:e', 'root:nobody:e']);
		expect(fired.filter((f) => f === 'root:bye:p')).toHaveLength(2);
	});
	it('loops seamlessly when a spawn asks to loop: no gap and no lost particle at the boundary', () => {
		const json = effect({
			'minecraft:emitter_rate_steady': { spawn_rate: 31, max_particles: 100 },
			'minecraft:emitter_lifetime_looping': { active_time: 1 },
			'minecraft:particle_lifetime_expression': { max_lifetime: 1 },
		});
		const once = setup(json);
		steps(once.world, 300);
		// /particle plays one loop
		expect(once.world.nextParticleId - 1).toBeLessThanOrEqual(32);
		const { world } = setup(json, {}, { loop: true });
		const perSecond: number[] = [];
		let last = 0;
		for (let s = 0; s < 6; s++) {
			steps(world, 60);
			perSecond.push(world.nextParticleId - 1 - last);
			last = world.nextParticleId - 1;
		}
		// 31 a second, every second, across five loop boundaries (the fraction carries over)
		for (const n of perSecond) expect(Math.abs(n - 31)).toBeLessThanOrEqual(1);
		expect(last).toBeGreaterThanOrEqual(185);
	});
	it('places an emitter_bound child where the particle that fired it was, and keeps that offset', () => {
		const world = new ParticleWorld({ seed: 7 });
		const child = world.loadEffect({
			format_version: '1.10.0',
			particle_effect: {
				description: { identifier: 'test:child', basic_render_parameters: { material: 'particles_alpha', texture: 'x' } },
				components: { 'minecraft:emitter_rate_instant': { num_particles: 1 }, 'minecraft:emitter_lifetime_once': { active_time: 1 }, 'minecraft:particle_lifetime_expression': { max_lifetime: 1 } },
			},
		});
		const parent = world.loadEffect(
			effect(
				{
					'minecraft:emitter_rate_instant': { num_particles: 1 },
					'minecraft:emitter_lifetime_once': { active_time: 10 },
					'minecraft:particle_initial_speed': 2,
					'minecraft:particle_motion_dynamic': {},
					'minecraft:emitter_shape_point': { direction: [1, 0, 0] },
					'minecraft:particle_lifetime_expression': { max_lifetime: 0.5 },
					'minecraft:particle_lifetime_events': { expiration_event: 'hit' },
				},
				{ events: { hit: { particle_effect: { effect: 'test:child', type: 'emitter_bound' } } } },
			),
		);
		world.resolveEffect = (id) => (id === 'test:child' ? child : id === parent.identifier ? parent : null);
		const root = world.spawn(parent, { position: [5, 0, 0], context: 'entity' });
		steps(world, 40);
		const kid = world.emitters.find((e) => e.def === child)!;
		// about a block along +X from the emitter, not at the emitter
		expect(kid.position[0] - root.position[0]).toBeGreaterThan(0.6);
		root.position = [6, 0, 0];
		steps(world, 1);
		expect(kid.position[0] - root.position[0]).toBeGreaterThan(0.6);
	});
	it("doesn't cull an emitter before its particles' sizes are known", () => {
		// a big particle whose centre sits just outside the view: only its size reaches into it
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 1 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 5 },
				'minecraft:particle_appearance_billboard': { size: [6, 6], facing_camera_mode: 'rotate_xyz' },
			}),
			{},
			{ position: [8, 0, -10] },
		);
		world.camera = { position: [0, 0, 0], forward: [0, 0, -1], up: [0, 1, 0], right: [1, 0, 0], fovY: 60, aspect: 1, near: 0.1, far: 100 };
		steps(world, 3);
		expect(emitter.culled).toBe(false);
		expect(emitter.pool.size[0]).toBe(6);
		// far out of view, it's culled once its size is known
		world.camera = { ...world.camera, forward: [0, 0, 1] };
		steps(world, 1);
		expect(emitter.culled).toBe(true);
	});
	it('ends a manual-rate emitter spawned by /particle right after its creation', () => {
		const world = new ParticleWorld({ seed: 1 });
		const child = world.loadEffect(effect({ 'minecraft:emitter_rate_instant': { num_particles: 1 }, 'minecraft:emitter_lifetime_once': { active_time: 1 }, 'minecraft:particle_lifetime_expression': { max_lifetime: 5 } }));
		const json = (events: Record<string, unknown>) =>
			effect(
				{ 'minecraft:emitter_rate_manual': { max_particles: 1 }, 'minecraft:emitter_lifetime_once': { active_time: 3 }, 'minecraft:emitter_lifetime_events': events },
				{ events: { go: { particle_effect: { effect: 'test:child', type: 'emitter' } } } },
			);
		world.resolveEffect = (id) => (id === 'test:child' ? child : null);
		const count = (events: Record<string, unknown>, context: 'command' | 'entity') => {
			world.clear();
			world.spawn(world.loadEffect(json(events)), { context });
			steps(world, 240);
			return world.emitters.length + world.particleCount;
		};
		// in-game: the creation event runs; the timeline and expiration events don't
		expect(count({ creation_event: 'go' }, 'command')).toBeGreaterThan(0);
		expect(count({ timeline: { '0.4': 'go' } }, 'command')).toBe(0);
		expect(count({ expiration_event: 'go' }, 'command')).toBe(0);
	});
	it('scales spawn offsets, not speeds, by the attachment frame (e04, e05)', () => {
		const json = effect({
			'minecraft:emitter_rate_instant': { num_particles: 1 },
			'minecraft:emitter_lifetime_once': { active_time: 1 },
			'minecraft:emitter_shape_point': { offset: [0, 0.5, 0], direction: [0, 1, 0] },
			'minecraft:particle_initial_speed': 2,
			'minecraft:particle_lifetime_expression': { max_lifetime: 5 },
		});
		const at = (scale: number) => {
			const { world, emitter } = setup(json, {}, { context: 'entity', attachment: { getTransform: () => ({ position: [0, 2, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0] }), scale, entity: true } });
			emitter.update(0);
			return { y: emitter.pool.pos[1], vy: emitter.pool.vel[1] };
		};
		expect(at(1).y).toBeCloseTo(2.5);
		expect(at(2).y).toBeCloseTo(3);
		expect(at(2).vy).toBeCloseTo(2);
	});
	it('takes world-space parametric positions on an entity from the world origin (e10)', () => {
		const json = effect({
			'minecraft:emitter_rate_instant': { num_particles: 1 },
			'minecraft:emitter_lifetime_once': { active_time: 1 },
			'minecraft:particle_motion_parametric': { relative_position: [1, 0, 2] },
			'minecraft:particle_lifetime_expression': { max_lifetime: 5 },
		});
		const transform = () => ({ position: [10, 5, 10] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], velocity: [0, 0, 0] as [number, number, number] });
		const onEntity = setup(json, {}, { context: 'entity', attachment: { getTransform: transform, entity: true } });
		steps(onEntity.world, 2);
		expect([...onEntity.emitter.pool.pos.slice(0, 3)]).toEqual([1, 0, 2]);
		// /particle: from the emitter
		const standalone = setup(json, {}, { position: [10, 5, 10] });
		steps(standalone.world, 2);
		expect([...standalone.emitter.pool.pos.slice(0, 3)]).toEqual([11, 5, 12]);
	});
	it('drops local-space particles when the entity goes; world-space ones stay (e12)', () => {
		const make = (local: boolean) =>
			effect({
				...(local ? { 'minecraft:emitter_local_space': { position: true, rotation: true } } : {}),
				'minecraft:emitter_rate_instant': { num_particles: 3 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 5 },
			});
		const run = (local: boolean) => {
			let alive = true;
			const { world, emitter } = setup(make(local), {}, { context: 'entity', attachment: { getTransform: () => ({ position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0] }), alive: () => alive, entity: true } });
			steps(world, 2);
			alive = false;
			steps(world, 2);
			return { expired: emitter.expired, count: emitter.pool.count };
		};
		expect(run(true)).toEqual({ expired: true, count: 0 });
		expect(run(false)).toEqual({ expired: true, count: 3 });
	});
	it('counts below a ground plane as inside its block for the in-blocks components', () => {
		const json = effect({
			'minecraft:emitter_rate_instant': { num_particles: 2 },
			'minecraft:emitter_lifetime_once': { active_time: 1 },
			'minecraft:particle_lifetime_expression': { max_lifetime: 5 },
			'minecraft:particle_expire_if_not_in_blocks': ['minecraft:air'],
		});
		const above = setup(json, {}, { position: [0, 2, 0] });
		above.world.planes = [{ normal: [0, 1, 0], d: 0, block: 'minecraft:grass_block' }];
		steps(above.world, 5);
		expect(above.world.particleCount).toBe(2);
		const below = setup(json, {}, { position: [0, -2, 0] });
		below.world.planes = [{ normal: [0, 1, 0], d: 0, block: 'minecraft:grass_block' }];
		steps(below.world, 5);
		expect(below.world.particleCount).toBe(0);
	});
	it("doesn't hand a spawn's loop override to what its events spawn", () => {
		const world = new ParticleWorld({ seed: 7 });
		const child = world.loadEffect({
			format_version: '1.10.0',
			particle_effect: {
				description: { identifier: 'test:child', basic_render_parameters: { material: 'particles_alpha', texture: 'x' } },
				components: { 'minecraft:emitter_rate_instant': { num_particles: 1 }, 'minecraft:emitter_lifetime_looping': { active_time: 0.2 }, 'minecraft:particle_lifetime_expression': { max_lifetime: 0.1 } },
			},
		});
		const parent = world.loadEffect(
			effect(
				{
					'minecraft:emitter_rate_steady': { spawn_rate: 10, max_particles: 100 },
					'minecraft:emitter_lifetime_looping': { active_time: 1 },
					'minecraft:particle_lifetime_expression': { max_lifetime: 0.1 },
					'minecraft:particle_lifetime_events': { expiration_event: 'hit' },
				},
				{ events: { hit: { particle_effect: { effect: 'test:child', type: 'emitter_bound' } } } },
			),
		);
		world.resolveEffect = (id) => (id === 'test:child' ? child : null);
		world.spawn(parent, { loop: true });
		steps(world, 600);
		// /particle children play one loop and go; only the parent repeats
		expect(world.emitters.filter((e) => e.def === child).length).toBeLessThanOrEqual(3);
	});
	it('swaps an edited definition into running emitters, keeping their particles', () => {
		const json = (u: number) =>
			effect({
				'minecraft:emitter_rate_steady': { spawn_rate: 20, max_particles: 100 },
				'minecraft:emitter_lifetime_looping': { active_time: 10 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 5 },
				'minecraft:particle_appearance_billboard': { size: [0.1, 0.1], facing_camera_mode: 'rotate_xyz', uv: { texture_width: 16, texture_height: 16, uv: [u, 0], uv_size: [4, 4] } },
			});
		const { world, def, emitter } = setup(json(0));
		steps(world, 60);
		const ids = [...emitter.pool.id.subarray(0, emitter.pool.count)];
		expect(emitter.pool.uv[0]).toBeCloseTo(0, 5);
		const edited = world.loadEffect(json(8));
		expect(world.swapEffect(def, edited)).toBe(1);
		world.prepareRender();
		// the same particles, now drawn from the new UV
		expect([...emitter.pool.id.subarray(0, ids.length)]).toEqual(ids);
		expect(emitter.pool.uv[0]).toBeCloseTo(0.5, 5);
		steps(world, 10);
		expect(emitter.def).toBe(edited);
	});
	it('prepares a paused frame the same way however often it is drawn, also after a restore', () => {
		// a render-pass counter (the examples' layout pattern) and a render variable that carries over frames
		const { world, emitter } = setup(
			effect({
				'minecraft:emitter_initialization': { per_update_expression: 'v.n = 0;' },
				'minecraft:emitter_rate_instant': { num_particles: 5 },
				'minecraft:emitter_lifetime_once': { active_time: 10 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
				'minecraft:particle_initialization': { per_render_expression: 'v.r = v.n; v.n = v.n + 1; v.frames = (v.frames ?? 0) + 1;' },
				'minecraft:particle_appearance_billboard': { size: ['0.01 + v.r * 0.01', 'v.frames'], facing_camera_mode: 'rotate_xyz' },
			}),
		);
		const sizes = () => [...emitter.pool.size.subarray(0, emitter.pool.count * 2)];
		steps(world, 3);
		const drawn = sizes();
		expect(drawn.filter((_, k) => k % 2 === 0).map((w) => +w.toFixed(3))).toEqual([0.01, 0.02, 0.03, 0.04, 0.05]);
		for (let i = 0; i < 4; i++) world.prepareRender();
		expect(sizes()).toEqual(drawn);

		// scrubbing back and drawing shows that frame as it was; stepping on from it replays exactly
		const snap = world.snapshot();
		steps(world, 2);
		const later = sizes();
		world.restore(snap);
		world.prepareRender();
		expect(sizes()).toEqual(drawn);
		steps(world, 2);
		expect(sizes()).toEqual(later);
	});
	describe('a frame prepared again', () => {
		// a render-pass counter, a render-side random, a temp, and a variable carried from one frame's render to the next
		const counted = effect({
			'minecraft:emitter_initialization': { per_update_expression: 'v.n = 0;' },
			'minecraft:emitter_rate_instant': { num_particles: 4 },
			'minecraft:emitter_lifetime_once': { active_time: 10 },
			'minecraft:particle_lifetime_expression': { max_lifetime: 10 },
			'minecraft:particle_initialization': { per_render_expression: 'v.r = v.n; v.n = v.n + 1; t.drawn = (t.drawn ?? 0) + 1; v.frames = (v.frames ?? 0) + 1;' },
			'minecraft:particle_appearance_billboard': { size: ['0.1 + v.r * 0.1', 'math.random(0.1, 0.2)'], facing_camera_mode: 'rotate_xyz' },
			'minecraft:particle_appearance_tinting': { color: [1, 1, 1, 'v.frames / 100'] },
		});
		const drawn = (world: ParticleWorld) => {
			const p = world.emitters[0].pool;
			return { size: [...p.size.subarray(0, p.count * 2)], color: [...p.color.subarray(0, p.count * 4)], temps: world.temps.entries(world.symbols.tempNames) };
		};

		it('steps on exactly as if it had been prepared once (temps, randoms and carried variables included)', () => {
			const once = setup(counted).world;
			const many = setup(counted).world;
			for (let f = 0; f < 6; f++) {
				once.step(DT);
				many.step(DT);
				for (let i = 0; i < 3; i++) many.prepareRender();
			}
			expect(drawn(many)).toEqual(drawn(once));
		});

		it('keeps its base when an emitter moves to another world (worker threads), prepared there or not', () => {
			for (const preparedFirst of [false, true]) {
				const a = setup(counted);
				steps(a.world, 3);
				const shown = drawn(a.world);
				const b = new ParticleWorld({ seed: 42 });
				const def = b.loadEffect(counted);
				b.frame = a.world.frame;
				// the receiving world may have drawn its own emitters this frame already
				if (preparedFirst) b.prepareRender();
				b.adopt(a.world.export(new Set([a.emitter.id])), () => def);
				b.prepareRender();
				b.prepareRender();
				// widths come from the render counter (heights draw from the receiving world's own random sequence)
				const widths = (size: number[]) => size.filter((_, k) => k % 2 === 0);
				expect(widths(drawn(b).size)).toEqual(widths(shown.size));
			}
		});
	});
	it('runs event nodes the way the game does (t49–t53)', () => {
		const world = new ParticleWorld({ seed: 3 });
		const child = world.loadEffect(
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 1 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 5 },
			}),
		);
		const parent = world.loadEffect(
			effect(
				{
					'minecraft:emitter_initialization': { creation_expression: 't.k = 0;' },
					'minecraft:emitter_rate_instant': { num_particles: 1 },
					'minecraft:emitter_lifetime_once': { active_time: 1 },
					'minecraft:emitter_lifetime_events': { creation_event: ['leaf', 'grouped'] },
					'minecraft:particle_lifetime_expression': { max_lifetime: 5 },
					'minecraft:particle_lifetime_events': { creation_event: 'born' },
					'minecraft:emitter_shape_point': { offset: [5, 0, 0] },
				},
				{
					events: {
						// a plain node spawns first, then runs its expression
						leaf: { expression: 't.k = 1;', particle_effect: { effect: 'test:fx', pre_effect_expression: 'v.got = t.k;' } },
						// a node with a sequence ignores its own expression and spawn
						grouped: { sequence: [{ expression: 'v.seq = 1;' }], expression: 'v.own = 1;', particle_effect: { effect: 'test:fx' } },
						// spawned from a particle creation event: at the world origin
						born: { particle_effect: { effect: 'test:fx', type: 'emitter' } },
					},
				},
			),
		);
		world.resolveEffect = () => child;
		const e = world.spawn(parent, { position: [10, 0, 10] });
		world.step(1 / 60);
		const kids = world.emitters.filter((x) => x !== e);
		expect(kids).toHaveLength(2);
		const leafKid = kids.find((k) => world.snapshotVars(k.vars)['variable.got'] !== undefined)!;
		expect(world.snapshotVars(leafKid.vars)['variable.got']).toBe(0);
		expect(leafKid.position).toEqual([10, 0, 10]);
		const vars = world.snapshotVars(e.vars);
		expect(vars['variable.seq']).toBe(1);
		expect(vars['variable.own']).toBeUndefined();
		// the parent's particles sit 5 blocks along +x from it: the creation event's child lands at (5, 0, 0)
		const origin = kids.find((k) => k !== leafKid)!;
		expect(origin.position).toEqual([5, 0, 0]);
		// a single-particle spawn lands at the world origin even from an emitter event (t57)
		const single = world.loadEffect(effect({ 'minecraft:emitter_lifetime_events': { creation_event: 'one' } }, { events: { one: { particle_effect: { effect: 'test:fx', type: 'particle' } } } }));
		world.clear();
		world.resolveEffect = () => child;
		world.spawn(single, { position: [7, 0, 7] });
		expect(world.emitters.find((x) => x.def === child)!.position).toEqual([0, 0, 0]);
		// on an entity too: they exist there (e17) but appear nowhere near it (e18)
		world.clear();
		world.spawn(single, { position: [7, 0, 7], context: 'entity', attachment: { getTransform: () => ({ position: [7, 0, 7], rotation: [0, 0, 0, 1], velocity: [0, 0, 0] }), entity: true } });
		expect(world.emitters.find((x) => x.def === child)!.position).toEqual([0, 0, 0]);
	});
	it('places event children of an effect on an entity as measured (e13, e14, e17, e18)', () => {
		const at: [number, number, number] = [10, 0, 10];
		const onEntity = { getTransform: () => ({ position: [...at] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], velocity: [0, 0, 0] as [number, number, number] }), entity: true };
		/** where each kind of child lands: the parent's one particle sits 1 block along x from its emitter */
		const kids = (phase: 'creation' | 'timeline', local: boolean, bound = true) => {
			const world = new ParticleWorld({ seed: 1 });
			const kid = world.loadEffect(effect({ 'minecraft:emitter_rate_instant': { num_particles: 1 }, 'minecraft:emitter_lifetime_once': { active_time: 1 }, 'minecraft:particle_lifetime_expression': { max_lifetime: 5 } }));
			const parent = world.loadEffect(
				effect(
					{
						...(local ? { 'minecraft:emitter_local_space': { position: true, rotation: true } } : {}),
						'minecraft:emitter_rate_instant': { num_particles: 1 },
						'minecraft:emitter_lifetime_once': { active_time: 3 },
						'minecraft:emitter_shape_point': { offset: [1, 0, 0] },
						'minecraft:particle_lifetime_expression': { max_lifetime: 2 },
						'minecraft:particle_lifetime_events': phase === 'creation' ? { creation_event: 'kids' } : { timeline: { '0.5': 'kids' } },
					},
					{ events: { kids: { sequence: ['emitter', 'emitter_bound', 'particle'].map((type) => ({ particle_effect: { effect: 'test:fx', type } })) } } },
				),
			);
			world.resolveEffect = () => kid;
			world.spawn(parent, { position: [...at], context: 'entity', attachment: bound ? onEntity : null });
			steps(world, phase === 'creation' ? 1 : 35);
			const of = (o: (k: (typeof world.emitters)[number]) => boolean) => [...world.emitters.find((k) => k.def === kid && o(k))!.position];
			return { emitter: of((k) => !k.spawnOptions.bound && !k.spawnOptions.singleParticle), bound: of((k) => !!k.spawnOptions.bound), particle: of((k) => !!k.spawnOptions.singleParticle) };
		};
		// world space: at the particle; emitter_bound at the emitter; single particles away from the entity
		expect(kids('timeline', false)).toEqual({ emitter: [11, 0, 10], bound: [10, 0, 10], particle: [0, 0, 0] });
		expect(kids('creation', false).emitter).toEqual([11, 0, 10]);
		// local space: at the emitter; a creation event's child away from the entity (where /particle puts it)
		expect(kids('timeline', true)).toEqual({ emitter: [10, 0, 10], bound: [10, 0, 10], particle: [0, 0, 0] });
		expect(kids('creation', true).emitter).toEqual([1, 0, 0]);
		// bind_to_actor: false behaves like /particle: emitter_bound at the particle, creation children at the offset
		expect(kids('timeline', false, false)).toEqual({ emitter: [11, 0, 10], bound: [11, 0, 10], particle: [0, 0, 0] });
		expect(kids('creation', false, false).emitter).toEqual([1, 0, 0]);
	});
	it('ignores emitter_local_space with rotation but no position, as the game does (e13)', () => {
		const def = new ParticleWorld().loadEffect(effect({ 'minecraft:emitter_local_space': { position: false, rotation: true } }));
		expect(def.emitter.localSpace).toEqual({ position: false, rotation: false, velocity: false });
		expect(def.diagnostics.some((d) => d.code === 'local-space' && d.message.startsWith('We do not support rotation being true and position being false'))).toBe(true);
	});
	it("picks random options like the game: 0 loses to anything positive, all-zero takes the first", () => {
		const opts = (...w: number[]) => w.map((weight, i) => ({ weight, node: i }));
		for (const r of [0, 0.3, 0.999]) expect(pickRandom(opts(0, 1), r)).toBe(1);
		for (const r of [0, 0.5, 0.999]) expect(pickRandom(opts(0, 0), r)).toBe(0);
		expect(pickRandom(opts(1, 3), 0.2)).toBe(0);
		expect(pickRandom(opts(1, 3), 0.3)).toBe(1);
		expect(pickRandom([], 0.5)).toBeNull();
		const def = new ParticleWorld().loadEffect(effect({}, { events: { e: { randomize: [{ weight: -1, expression: 'v.a = 1;' }, { weight: 1 }] } } }));
		expect(def.events.get('e')!.randomize).toHaveLength(1);
		expect(def.diagnostics.some((d) => d.code === 'negative-weight')).toBe(true);
	});
	it('explains a live particle: stored direction, pole fallback, rotation and the speed threshold', () => {
		const billboard = (direction: unknown, rotation = 0) =>
			effect({
				'minecraft:emitter_rate_instant': { num_particles: 1 },
				'minecraft:emitter_lifetime_once': { active_time: 1 },
				'minecraft:particle_lifetime_expression': { max_lifetime: 5 },
				'minecraft:particle_initial_spin': { rotation },
				'minecraft:particle_initial_speed': 0.5,
				'minecraft:emitter_shape_point': { direction: [0, 1, 0] },
				'minecraft:particle_appearance_billboard': { size: [0.1, 0.1], facing_camera_mode: 'direction_x', direction },
			});
		// a custom direction close to vertical, but not past the 0.9999 pole threshold
		let { world, emitter } = setup(billboard({ mode: 'custom', custom_direction: [0, 2, 0.1] }));
		steps(world, 1);
		let f = emitter.particleFacing(0, cam)!;
		expect(r(f.input)).toEqual([0, 2, 0.1]);
		expect(f.usedFallback).toBe(false);
		expect(f.velocity).toBeNull();
		// exactly vertical: fixed axes
		({ world, emitter } = setup(billboard({ mode: 'custom', custom_direction: [0, 3, 0] }, 90)));
		steps(world, 1);
		f = emitter.particleFacing(0, cam)!;
		expect(f.usedFallback).toBe(true);
		expect(r(f.right)).toEqual([0, 1, 0]);
		// 90° of rotation turns X into Y
		expect(r(f.rotatedRight)).toEqual(r(f.up));
		// from velocity: 0.5 b/s is under a 1 b/s threshold, so the facing is held (here: never set)
		({ world, emitter } = setup(billboard({ mode: 'derive_from_velocity', min_speed_threshold: 1 })));
		steps(world, 1);
		f = emitter.particleFacing(0, cam)!;
		expect(f.velocity).toEqual({ speed: expect.closeTo(0.5, 5), minSpeed: 1, held: true });
		expect(f.degenerate).toBe(true);
	});
});

describe('vanilla corpus', () => {
	const dir = join(__dirname, '../../../packages/metadata/cache/resource_pack/particles');
	const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
	it.skipIf(files.length === 0)(`loads and simulates all vanilla particles (${files.length})`, () => {
		const world = new ParticleWorld({ seed: 3 });
		const defs = new Map<string, EffectDefinition>();
		for (const f of files) {
			const json = parseJsonc(readFileSync(join(dir, f), 'utf8'), [], { allowTrailingComma: true });
			const def = world.loadEffect(json);
			defs.set(def.identifier, def);
		}
		world.resolveEffect = (id) => defs.get(id) ?? null;
		const failed = [...defs.values()].filter((d) => d.failed);
		expect(failed.map((d) => `${d.identifier}: ${d.failed!.reason} @ ${d.failed!.path}`)).toEqual([]);
		for (const def of defs.values()) world.spawn(def, { position: [0, 0, 0], manual: { burst: 3 } });
		for (let i = 0; i < 60; i++) world.step(DT);
		expect(world.particleCount).toBeGreaterThan(0);
		// every vanilla effect at once takes a few seconds on a busy machine
	}, 30_000);
});
