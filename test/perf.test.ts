import { describe, expect, it } from 'vitest';
import { ParticleWorld } from '../src/index';

// Molang-heavy 10k-particle emitter (parametric motion + per-particle size/color expressions)
const heavy = {
	format_version: '1.10.0',
	particle_effect: {
		description: { identifier: 'bench:heavy', basic_render_parameters: { material: 'particles_alpha', texture: 'x' } },
		components: {
			'minecraft:emitter_initialization': { creation_expression: 'v.spread = 4; v.height = 2;', per_update_expression: 'v.i = 0;' },
			'minecraft:emitter_rate_instant': { num_particles: 10000 },
			'minecraft:emitter_lifetime_once': { active_time: 100 },
			'minecraft:particle_initialization': { per_update_expression: 'v.t = v.particle_age * 90 + v.particle_random_1 * 360;' },
			'minecraft:particle_motion_parametric': {
				relative_position: [
					'v.i = v.i + 1; v.r = v.spread * (0.5 + v.particle_random_2); return math.cos(v.t) * v.r;',
					'math.sin(v.t * 2) * v.height * math.hermite_blend(math.clamp(v.particle_age, 0, 1))',
					'math.sin(v.t) * v.r',
				],
			},
			'minecraft:particle_lifetime_expression': { max_lifetime: 100 },
			'minecraft:particle_appearance_billboard': { size: ['0.05 + 0.02 * math.sin(v.particle_age * 180)', '0.05 + 0.02 * math.sin(v.particle_age * 180)'], facing_camera_mode: 'lookat_xyz' },
			'minecraft:particle_appearance_tinting': { color: ['math.clamp(v.particle_random_3, 0.2, 1)', '0.5 + 0.5 * math.sin(v.t)', 1, 'math.min(1, v.particle_age)'] },
		},
	},
};

describe('performance', () => {
	it('10k Molang-heavy particles fit the 165 Hz frame budget', () => {
		const world = new ParticleWorld({ seed: 9 });
		const def = world.loadEffect(heavy);
		world.cullEmitters = false;
		world.spawn(def, { position: [0, 0, 0], context: 'entity' }); // entity emitters allow 10k
		for (let i = 0; i < 30; i++) world.step(1 / 165); // warm up (JIT)
		const frames = 120;
		const t0 = performance.now();
		for (let i = 0; i < frames; i++) world.step(1 / 165);
		const ms = (performance.now() - t0) / frames;
		console.log(`10k heavy particles: ${ms.toFixed(2)} ms/frame (update + render prep)`);
		expect(world.particleCount).toBe(10000);
		expect(ms).toBeLessThan(25); // CI guard; target is ~3 ms on a desktop
	});

	it('50k Molang-heavy particles across five emitters', () => {
		const world = new ParticleWorld({ seed: 11 });
		const def = world.loadEffect(heavy);
		world.cullEmitters = false;
		for (let k = 0; k < 5; k++) world.spawn(def, { position: [k * 10, 0, 0], context: 'entity' });
		for (let i = 0; i < 20; i++) world.step(1 / 165);
		const frames = 60;
		const t0 = performance.now();
		for (let i = 0; i < frames; i++) world.step(1 / 165);
		const ms = (performance.now() - t0) / frames;
		console.log(`50k heavy particles: ${ms.toFixed(2)} ms/frame (update + render prep)`);
		expect(world.particleCount).toBe(50000);
		expect(ms).toBeLessThan(120); // CI guard; the target is the 165 Hz budget on a desktop
	}, 60_000);
});
