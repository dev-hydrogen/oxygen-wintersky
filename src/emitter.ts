import { MolangAbort, compile, type CompiledExpression, type Env, type Value } from 'molangjs';
import { evaluateCurve } from './curves';
import type { EffectDefinition, EventNode, FacingMode, MolangField, ShapeDefinition, Vec3Field } from './definition';
import { facingBasis, type FacingBasis } from './facing';
import { ParticlePool } from './pool';
import { len3, quatConjugate, quatIdentity, rotateByQuat, type Quat, type Vec3 } from './vec';
import { HaltSignal, type CameraState, type EmitterSnapshot, type ParticleWorld, type Phase, type QueryContext, type SpawnContext } from './world';

/** How particle i is oriented when drawn: the renderer's facing math, explained */
export interface ParticleFacing extends FacingBasis {
	mode: FacingMode;
	/** world position of the quad center */
	position: Vec3;
	/** the direction as stored: a custom direction as evaluated, or the normalized velocity */
	input: Vec3;
	/** derive_from_velocity: current speed, threshold, and whether the facing kept its previous value */
	velocity: { speed: number; minSpeed: number; held: boolean } | null;
	/** quad axes after the particle's rotation */
	rotatedRight: Vec3;
	rotatedUp: Vec3;
}

const ORIGIN: Vec3 = [0, 0, 0];

/** Live transform source for emitters attached to an entity / locator / parent emitter */
export interface Attachment {
	getTransform(): { position: Vec3; rotation: Quat; velocity: Vec3 };
	/** Entity bounding box relative to the emitter origin (entity_aabb shape) */
	aabb?: { min: Vec3; max: Vec3 };
	/** false once the entity is gone (the emitter then expires) */
	alive?(): boolean;
	/**
	 * Scale of the attachment's frame (a scaled bone or entity, e05/e10): an emitter's spawn offsets are scaled by
	 * it, its directions and speeds aren't (e04).
	 */
	scale?: number;
	/**
	 * It's an entity (not a parent emitter). World-space parametric positions of its emitters are then taken from
	 * the world origin (e10), and its emitters' local-space particles go when it does (e12).
	 */
	entity?: boolean;
}

export interface SpawnOptions {
	position?: Vec3;
	rotation?: Quat;
	attachment?: Attachment | null;
	context?: SpawnContext;
	/**
	 * pre_effect_script (an entity animation) runs before creation_expression; an event's pre_effect_expression runs
	 * after the child's creation_expression (t77, t78)
	 */
	preEffect?: MolangField | string | null;
	/** Script API MolangVariableMap — set before creation_expression */
	variables?: Record<string, Value>;
	parent?: EmitterInstance | null;
	/** emitter_bound child: follows its parent, and keeps its own lifetime when the parent ends (t54) */
	bound?: boolean;
	inheritVelocity?: Vec3 | null;
	/** 'particle' / 'particle_with_velocity' event children emit exactly one particle */
	singleParticle?: boolean;
	/** Preview driver for manual-rate emitters (the game drives these from code) */
	manual?: { burst?: number; rate?: number } | null;
	/**
	 * Whether a looping lifetime restarts, overriding the spawn context's rule (/particle and Script API play
	 * one loop, entities loop). For previews that want to watch a loop repeat seamlessly.
	 */
	loop?: boolean;
}

const tmp: Vec3 = [0, 0, 0];
const tmp2: Vec3 = [0, 0, 0];
const DIRECTION_MODES = new Set(['lookat_direction', 'direction_x', 'direction_y', 'direction_z']);

/**
 * How far out a sphere or disc places a particle, as a fraction of the radius: the mean of two randoms, so the
 * distance has a triangular spread (peaks at half the radius) and the shape is dense toward its centre. Measured
 * in-game from about 900 spawn positions each (a disc and a sphere seen from below): this law fits both within
 * noise, where uniform-area/volume, a uniform distance and the others tried don't; boxes stay uniform per axis.
 */
const inner = (rnd: () => number) => (rnd() + rnd()) / 2;

/**
 * The game's weighted pick (t50, t51): the first option whose weight covers what's left of `r × total`.
 * An option weighing 0 is never picked over a positive one, and when every weight is 0 the first wins.
 * Options with negative weights were dropped when the effect loaded.
 */
export function pickRandom<T>(options: { weight: number; node: T }[], r: number): T | null {
	if (!options.length) return null;
	let total = 0;
	for (const o of options) total += o.weight;
	let pick = r * total;
	for (const o of options) {
		if (pick <= o.weight && (o.weight > 0 || total <= 0)) return o.node;
		pick -= o.weight;
	}
	return options[options.length - 1].node;
}

export class EmitterInstance {
	readonly pool = new ParticlePool();
	vars: Value[] = [];
	env: Env;
	parent: EmitterInstance | null = null;
	parentId: number | null = null;
	position: Vec3 = [0, 0, 0];
	rotation: Quat = quatIdentity();
	velocity: Vec3 = [0, 0, 0];
	/** seconds since the current loop began (variable.emitter_age) */
	age = 0;
	totalAge = 0;
	loopIndex = 0;
	randoms: [number, number, number, number] = [0, 0, 0, 0];
	activeTime = 0;
	sleepTime = 0;
	maxParticles = 0;
	active = false;
	expired = false;
	/** effect failed to load (as in-game): never spawns */
	failed = false;
	burstDone = false;
	spawnAccumulator = 0;
	travelled = 0;
	loopingTravel: number[] = [];
	travelFired = new Set<number>();
	culled = false;
	/**
	 * The largest particle size drawn so far, for culling: sizes are only computed when the emitter is drawn, so
	 * an emitter that has never been drawn can't be bounded (and isn't culled), and particles spawned while it's
	 * culled count with the size its particles had
	 */
	private drawnSize: number | null = null;
	capHitFrame = -1;
	readonly qctx: QueryContext;
	private manualAccumulator = 0;
	/** emitter_bound: where it spawned, relative to its parent (in the parent's frame) */
	private boundOffset: Vec3 | null = null;

	constructor(
		readonly world: ParticleWorld,
		/** what it runs; an editor can swap in an edited version while it plays (ParticleWorld.swapEffect) */
		public def: EffectDefinition,
		readonly id: number,
		readonly spawnOptions: SpawnOptions,
	) {
		this.env = world.createEnv(this.vars);
		this.qctx = { world, emitter: this, particle: -1, spawnContext: spawnOptions.context ?? 'command' };
		const symbols = world.symbols;
		// a query without a value is reported; it reads 0, or (for struct queries) leaves the struct unset
		this.env.qs = (qid, args, node) => {
			const name = symbols.queryNames[qid];
			const v = world.queries?.resolve(name, args, this.qctx);
			if (v === undefined) {
				// the detail is the query, then why it has no value when the provider knows: `query.x|reason`
				world.reportError('unknown-query', node, () => {
					const why = world.queries?.why?.(name, args, this.qctx);
					return why ? `${name}|${why}` : name;
				});
			}
			return v;
		};
		this.env.q = (qid, args, node) => this.env.qs!(qid, args, node) ?? 0;
		this.parent = spawnOptions.parent ?? null;
		this.parentId = this.parent?.id ?? null;
	}

	get attached(): boolean {
		return !!this.spawnOptions.attachment || (!!this.spawnOptions.bound && !!this.parent);
	}

	/** Particles live in emitter-local space (attached + local position) */
	get localSpace(): boolean {
		return this.attached && this.def.emitter.localSpace.position;
	}

	// ---------------------------------------------------------------- evaluation

	private enter(field: MolangField, phase: Phase, particle: number) {
		const c = this.world.current;
		c.path = field.path;
		c.emitter = this.id;
		c.particle = particle;
		c.phase = phase;
		this.qctx.particle = particle;
	}

	/**
	 * Evaluate a field. Temps are NOT reset: in-game `t.*` is one global store that persists across
	 * expressions, passes, emitters and frames (t05/t30).
	 */
	private evaluate(field: MolangField, phase: Phase, particle: number): Value {
		if (field.constant !== null) return field.constant;
		const w = this.world;
		this.enter(field, phase, particle);
		if (w.debug.select || w.debug.log || w.debug.haltAfter !== null) return this.evaluateDebug(field, phase, particle);
		try {
			return field.expr.run(this.env);
		} catch (e) {
			if (e instanceof MolangAbort) return 0;
			throw e;
		}
	}

	private evaluateDebug(field: MolangField, phase: Phase, particle: number): Value {
		const w = this.world;
		const d = w.debug;
		if (d.haltAfter !== null && w.evalCount >= d.haltAfter) {
			throw new HaltSignal({ phase, path: field.path, emitter: this.id, particle: particle >= 0 ? this.pool.id[particle] : -1 });
		}
		w.evalCount++;
		const sel = d.select;
		const selected = sel && sel.emitter === this.id && (sel.particle === null || particle < 0 || this.pool.id[particle] === sel.particle);
		let result: Value;
		if (selected) {
			const traced = w.traceVersion(field);
			const values = new Map<number, Value[]>();
			const before = w.snapshotVars(this.vars);
			this.env.trace = (node, value) => {
				const list = values.get(node);
				if (list) list.push(value);
				else values.set(node, [value]);
				return value;
			};
			try {
				result = traced.run(this.env);
			} catch (e) {
				if (e instanceof MolangAbort) result = 0;
				else throw e;
			} finally {
				this.env.trace = null;
			}
			w.traces.push({
				frame: w.frame,
				phase,
				path: field.path,
				emitter: this.id,
				particle: particle >= 0 ? this.pool.id[particle] : -1,
				values,
				result,
				varsBefore: before,
				varsAfter: w.snapshotVars(this.vars),
				temps: w.temps.entries(w.symbols.tempNames),
			});
		} else {
			try {
				result = field.expr.run(this.env);
			} catch (e) {
				if (e instanceof MolangAbort) result = 0;
				else throw e;
			}
		}
		if (d.log && w.log.length < d.logLimit) {
			w.log.push({ frame: w.frame, phase, emitter: this.id, particle: particle >= 0 ? this.pool.id[particle] : -1, path: field.path, result });
		}
		return result;
	}

	private num(field: MolangField | null, fallback: number, phase: Phase, particle: number): number {
		if (!field) return fallback;
		const v = this.evaluate(field, phase, particle);
		if (typeof v === 'number') return v;
		this.world.reportError('string-math', -1);
		return 0;
	}

	private vec(fields: Vec3Field | null, out: Vec3, fallback: number, phase: Phase, particle: number): Vec3 {
		if (!fields) {
			out[0] = out[1] = out[2] = fallback;
			return out;
		}
		// X → Y → Z (values assigned in X are visible to Y and Z)
		out[0] = this.num(fields[0], fallback, phase, particle);
		out[1] = this.num(fields[1], fallback, phase, particle);
		out[2] = this.num(fields[2], fallback, phase, particle);
		return out;
	}

	private exec(field: MolangField | null, phase: Phase, particle: number): void {
		if (field) this.evaluate(field, phase, particle);
	}

	// ---------------------------------------------------------------- built-ins & curves

	private writeEmitterBuiltins() {
		const s = this.world.slots;
		const v = this.vars;
		v[s.emitterAge] = this.age;
		v[s.emitterLifetime] = this.activeTime;
		v[s.emitterRandom[0]] = this.randoms[0];
		v[s.emitterRandom[1]] = this.randoms[1];
		v[s.emitterRandom[2]] = this.randoms[2];
		v[s.emitterRandom[3]] = this.randoms[3];
	}

	private writeParticleBuiltins(i: number) {
		const s = this.world.slots;
		const v = this.vars;
		const p = this.pool;
		v[s.particleAge] = p.age[i];
		v[s.particleLifetime] = p.lifetime[i];
		const r = i * 4;
		v[s.particleRandom[0]] = p.random[r];
		v[s.particleRandom[1]] = p.random[r + 1];
		v[s.particleRandom[2]] = p.random[r + 2];
		v[s.particleRandom[3]] = p.random[r + 3];
	}

	private refreshCurves(phase: Phase, particle: number) {
		const curves = this.def.curves;
		if (!curves.length) return;
		// one evaluator per emitter, pointed at the current phase and particle (no closure per particle)
		this.curvePhase = phase;
		this.curveParticle = particle;
		for (const c of curves) this.vars[c.slot] = evaluateCurve(c, this.curveEval);
	}
	private curvePhase: Phase = 'particle-update';
	private curveParticle = -1;
	private readonly curveEval = (f: MolangField) => this.num(f, 0, this.curvePhase, this.curveParticle);

	// ---------------------------------------------------------------- lifecycle

	/** The spawn context of the emitter tree's root (event children behave like their root) */
	get rootContext(): SpawnContext {
		let e: EmitterInstance = this;
		while (e.parent && (e.spawnOptions.context ?? 'command') === 'event') e = e.parent;
		const c = e.spawnOptions.context ?? 'command';
		return c === 'event' ? 'command' : c;
	}

	/**
	 * Whether the tree's root follows an entity (an effect on an entity, bound to it), as against effects started by
	 * /particle, a script, or on an entity with bind_to_actor: false, which stay where they started
	 */
	get rootOnActor(): boolean {
		let e: EmitterInstance = this;
		while (e.parent && (e.spawnOptions.context ?? 'command') === 'event') e = e.parent;
		return !!e.spawnOptions.attachment?.entity;
	}

	/** Live-particle cap for this emitter (per emitter, by spawn context) */
	get cap(): number {
		return this.world.options.particleCap[this.rootContext];
	}

	/** Whether looping lifetimes restart (only entity-driven emitters loop in-game, unless the root says otherwise) */
	get loops(): boolean {
		// the override is for the emitter it was given to; what its events spawn follows the context's rule
		if (this.spawnOptions.loop !== undefined) return this.spawnOptions.loop;
		return this.world.options.loopingContexts.has(this.rootContext);
	}

	create(options: SpawnOptions): void {
		const w = this.world;
		if (this.def.failed) {
			this.failed = true;
			this.expired = true;
			return;
		}
		this.refreshTransform(true);
		for (let k = 0; k < 4; k++) this.randoms[k] = w.rng.next();
		this.applySpawnInputs(options);
		// emitter lifetime & rate setup read pre-creation values: active_time is evaluated before
		// creation_expression (t02)
		this.startLoop();
		this.writeEmitterBuiltins();
		this.exec(this.def.emitter.creation, 'creation', -1);
		this.applyPreEffect(options, true);
		for (const e of this.def.emitter.events.creation) this.runEvent(e, -1);
		if (options.singleParticle) {
			this.spawnParticles(1);
			this.expire(false);
		}
		if (options.manual?.burst) this.manualSpawn(options.manual.burst);
		// a manual-rate emitter spawned by /particle (or a script) has nothing to drive it: it runs its creation, then
		// ends at once without its timeline or expiration events (measured with /particle; script spawns assumed alike)
		if (this.def.emitter.rate?.type === 'manual' && !options.manual && this.rootContext !== 'entity') {
			this.expired = true;
			this.active = false;
		}
	}

	/** What the spawner hands a new emitter before creation: Script API variables, then (not for event children) the pre-effect script */
	private applySpawnInputs(options: SpawnOptions): void {
		const w = this.world;
		// Script API variables are applied before creation_expression (t21). They're data handed to the
		// emitter on construction, so they're assumed visible to the lifetime/rate setup too (t45).
		if (options.variables) {
			for (const [k, val] of Object.entries(options.variables)) {
				const full = k.toLowerCase().replace(/^v\./, 'variable.');
				this.vars[w.symbols.variable(full)] = val;
			}
		}
		this.applyPreEffect(options, false);
	}

	/**
	 * The pre-effect script. An entity's pre_effect_script is taken to run before creation_expression (not measured;
	 * Script API variables do, t21); an event child's
	 * pre_effect_expression runs after it: creation doesn't see what it sets, and it can overwrite what creation set
	 * (t77 k2, t78 p1–p5).
	 */
	private applyPreEffect(options: SpawnOptions, afterCreation: boolean): void {
		const w = this.world;
		if (afterCreation !== ((options.context ?? 'command') === 'event')) return;
		if (options.preEffect) {
			const field: MolangField | null =
				typeof options.preEffect === 'string'
					? (() => {
							const expr = compile(options.preEffect, {
								symbols: w.symbols,
								f32: w.options.f32,
								engine: w.options.engine,
								queryExists: w.options.queryExists ?? undefined,
								context: 'particle',
							});
							// a broken pre-effect script is dropped like any other field
							return expr.ok ? { expr, path: 'pre_effect', raw: options.preEffect, constant: null, version: null } : null;
						})()
					: options.preEffect;
			this.writeEmitterBuiltins();
			// Temps written by an event's earlier sequence steps are visible here (they're global anyway).
			this.exec(field, 'creation', -1);
		}
	}

	/**
	 * Begin an emitter loop: evaluate lifetime/rate setup fields (pre-creation values on the first loop). The steady
	 * spawn accumulator carries over from the previous loop, so a loop boundary neither drops nor adds a particle.
	 */
	private startLoop(first = true) {
		const life = this.def.emitter.lifetime;
		this.writeEmitterBuiltins();
		if (life?.type === 'once') this.activeTime = this.num(life.activeTime, 10, 'creation', -1);
		else if (life?.type === 'looping') {
			this.activeTime = this.num(life.activeTime, 10, 'creation', -1);
			this.sleepTime = this.num(life.sleepTime, 0, 'creation', -1);
		} else this.activeTime = 0;
		const rate = this.def.emitter.rate;
		if (rate?.type === 'steady' || rate?.type === 'manual') this.maxParticles = this.num(rate.maxParticles, 50, 'creation', -1);
		this.burstDone = false;
		if (first) this.spawnAccumulator = 0;
	}

	private refreshTransform(initial = false) {
		const o = this.spawnOptions;
		let t: { position: Vec3; rotation: Quat; velocity: Vec3 } | null = null;
		if (o.attachment) t = o.attachment.getTransform();
		else if (o.bound && this.parent) {
			// it spawns where it was fired (a particle's position) and keeps that offset as its parent moves and turns
			const par = this.parent;
			if (!this.boundOffset) {
				const at = o.position ?? par.position;
				this.boundOffset = rotateByQuat([0, 0, 0], at[0] - par.position[0], at[1] - par.position[1], at[2] - par.position[2], quatConjugate(par.rotation));
			}
			const off = rotateByQuat([0, 0, 0], this.boundOffset[0], this.boundOffset[1], this.boundOffset[2], par.rotation);
			t = { position: [par.position[0] + off[0], par.position[1] + off[1], par.position[2] + off[2]], rotation: par.rotation, velocity: par.velocity };
		}
		if (t) {
			if (!initial) this.travelled += len3(t.position[0] - this.position[0], t.position[1] - this.position[1], t.position[2] - this.position[2]);
			this.position[0] = t.position[0];
			this.position[1] = t.position[1];
			this.position[2] = t.position[2];
			this.rotation = [...t.rotation] as Quat;
			this.velocity = [...t.velocity] as Vec3;
		} else if (initial) {
			if (o.position) this.position = [...o.position] as Vec3;
			if (o.rotation) this.rotation = [...o.rotation] as Quat;
		}
	}

	/** Remove the particles that live in the emitter's space, without their expiration events */
	private dropLocalParticles(): void {
		const p = this.pool;
		let any = false;
		for (let i = 0; i < p.count; i++)
			if (p.local[i]) {
				p.dead[i] = 1;
				any = true;
			}
		if (any) p.compact();
	}

	expire(fireEvents = true): void {
		if (this.expired) return;
		this.expired = true;
		this.active = false;
		if (fireEvents) for (const e of this.def.emitter.events.expiration) this.runEvent(e, -1);
	}

	/** Remove once expired with no live particles (particles outlive their emitter) */
	removable(): boolean {
		return this.expired && this.pool.count === 0;
	}

	manualSpawn(n: number): void {
		if (!this.failed) this.spawnParticles(n);
	}

	// ---------------------------------------------------------------- update pass

	update(dt: number): void {
		if (this.failed) return;
		const def = this.def;
		const life = def.emitter.lifetime;
		const att = this.spawnOptions.attachment;
		if (att?.alive && !att.alive() && !this.expired) {
			this.expire();
			// the entity is gone: particles that lived in its space go with it, world-space ones stay (e12)
			if (att.entity) this.dropLocalParticles();
		}
		this.refreshTransform();

		const prevAge = this.age;
		this.age += dt;
		this.totalAge += dt;
		let loopStarted = false;

		if (!this.expired) {
			// 1. lifetime activation
			if (life?.type === 'looping') {
				const period = this.activeTime + this.sleepTime;
				// A zero-length loop never restarts (t02). Standalone (/particle, Script API) emitters play a
				// single loop (t31/t38); entity-driven emitters restart.
				if (period > 0 && this.age >= period && this.loops) {
					// new loop: the game makes a new emitter for each loop, as creators report (looping was never
					// observable here: /particle and Script API play one loop, t31/t38). So everything starts over:
					// v.* is cleared, the spawner's variables and pre-effect apply again, new randoms, the lifetime
					// and rate setup, creation_expression and the creation events. Particles already out live on
					// with the old emitter (its variables, its cap), not in this loop's pool.
					// Timeline events the old loop reached this frame fire first.
					for (const t of this.def.emitter.events.timeline) {
						if (t.at >= prevAge && t.at < period) for (const e of t.events) this.runEvent(e, -1);
					}
					this.world.retireLoop(this);
					this.age -= period;
					this.loopIndex++;
					this.vars.length = 0;
					for (let k = 0; k < 4; k++) this.randoms[k] = this.world.rng.next();
					this.travelled = 0;
					this.travelFired.clear();
					this.loopingTravel = [];
					this.applySpawnInputs(this.spawnOptions);
					this.startLoop(false);
					this.writeEmitterBuiltins();
					this.exec(this.def.emitter.creation, 'creation', -1);
					this.applyPreEffect(this.spawnOptions, true);
					for (const e of this.def.emitter.events.creation) this.runEvent(e, -1);
					loopStarted = true;
				}
				this.active = this.age < this.activeTime;
			} else if (life?.type === 'once') {
				this.active = this.age < this.activeTime;
			} else if (life?.type === 'expression') {
				this.writeEmitterBuiltins();
				const act = this.num(life.activation, 1, 'emitter-update', -1) !== 0;
				if (act && !this.active) {
					this.burstDone = false;
					this.spawnAccumulator = 0;
				}
				this.active = act;
			} else {
				this.active = true;
			}
		}

		// 2. per_update_expression (runs every update while the emitter exists)
		this.writeEmitterBuiltins();
		if (!this.expired || this.pool.count > 0) this.exec(def.emitter.perUpdate, 'emitter-update', -1);

		// 3. instant burst: fires on the loop's first update even when active_time is 0 (t02)
		const rate = def.emitter.rate;
		if (!this.expired && rate?.type === 'instant' && !this.burstDone && (life?.type !== 'expression' || this.active)) {
			this.burstDone = true;
			this.writeEmitterBuiltins();
			const n = Math.floor(this.num(rate.numParticles, 10, 'emitter-update', -1));
			if (n > 0) this.spawnParticles(n);
		}

		// 4. expiration
		if (!this.expired) {
			if (life?.type === 'once' && this.age >= this.activeTime) this.expire();
			else if (life?.type === 'looping' && !this.loops && this.age >= this.activeTime + this.sleepTime) this.expire();
			else if (life?.type === 'expression' && this.num(life.expiration, 0, 'emitter-update', -1) !== 0) this.expire();
		}

		// 5. steady rate → spawn
		if (!this.expired && this.active) this.runRate(dt);
		if (!this.expired && def.emitter.rate?.type === 'manual' && this.spawnOptions.manual?.rate) {
			this.manualAccumulator += this.spawnOptions.manual.rate * dt;
			const n = Math.floor(this.manualAccumulator);
			this.manualAccumulator -= n;
			if (n > 0) this.spawnParticles(n);
		}

		// 5. timeline + travel distance events
		if (!this.expired) {
			const from = loopStarted ? 0 : prevAge;
			for (const t of def.emitter.events.timeline) {
				if (t.at >= from && t.at < this.age) for (const e of t.events) this.runEvent(e, -1);
			}
			this.travelEvents();
		}

		// 6. particles: per particle, interleaved (per_update → motion → age → events → expiry)
		this.updateParticles(dt);
	}

	private runRate(dt: number) {
		const rate = this.def.emitter.rate;
		if (!rate) return;
		this.writeEmitterBuiltins();
		if (rate.type === 'steady') {
			const r = this.num(rate.spawnRate, 1, 'emitter-update', -1);
			if (r > 0) this.spawnAccumulator += r * dt;
			let n = Math.floor(this.spawnAccumulator);
			this.spawnAccumulator -= n;
			const room = Math.floor(this.maxParticles) - this.pool.count;
			if (n > room) {
				n = Math.max(0, room);
				this.spawnAccumulator = 0;
			}
			if (n > 0) this.spawnParticles(n);
		}
	}

	private travelEvents() {
		const ev = this.def.emitter.events;
		if (!ev.travelDistance.length && !ev.loopingTravelDistance.length) return;
		// travel distance: fire once when crossing each threshold
		ev.travelDistance.forEach((t, idx) => {
			if (!this.travelFired.has(idx) && this.travelled >= t.at) {
				this.travelFired.add(idx);
				for (const e of t.events) this.runEvent(e, -1);
			}
		});
		ev.loopingTravelDistance.forEach((t, idx) => {
			if (t.at <= 0) return;
			const done = this.loopingTravel[idx] ?? 0;
			const due = Math.floor(this.travelled / t.at);
			for (let k = done; k < due; k++) for (const e of t.events) this.runEvent(e, -1);
			this.loopingTravel[idx] = due;
		});
	}

	// ---------------------------------------------------------------- spawning

	spawnParticles(count: number): void {
		const w = this.world;
		const rate = this.def.emitter.rate;
		const cap = this.cap;
		const limit = Math.min(cap, rate && (rate.type === 'steady' || rate.type === 'manual') ? Math.max(0, Math.floor(this.maxParticles)) : Infinity);
		for (let k = 0; k < count; k++) {
			if (this.pool.count >= cap) {
				// the game blocks new spawns at the per-emitter cap (bursts are truncated)
				if (this.capHitFrame !== w.frame) {
					this.capHitFrame = w.frame;
					const c = w.current;
					c.path = 'particle_effect/components';
					c.emitter = this.id;
					w.reportError('cap', -1, `${cap} live particles per emitter (${this.rootContext} spawn)`);
				}
				return;
			}
			if (this.pool.count >= limit) return;
			this.spawnOne();
		}
	}

	private spawnOne(): number {
		const w = this.world;
		const def = this.def;
		const p = this.pool;
		const i = p.add(w.nextParticleId++);
		const r = i * 4;
		p.random[r] = w.rng.next();
		p.random[r + 1] = w.rng.next();
		p.random[r + 2] = w.rng.next();
		p.random[r + 3] = w.rng.next();
		p.age[i] = 0;
		this.writeEmitterBuiltins();
		this.writeParticleBuiltins(i);

		// shape → position & direction in the emitter frame
		const pos: Vec3 = [0, 0, 0];
		const dir: Vec3 = [0, 0, 0];
		this.sampleShape(def.emitter.shape, pos, dir, i);

		// initial speed / velocity
		const speedDef = def.particle.initialSpeed;
		const vel: Vec3 = [0, 0, 0];
		if (Array.isArray(speedDef)) this.vec(speedDef, vel, 0, 'spawn', i);
		else {
			const s = this.num(speedDef, 0, 'spawn', i);
			vel[0] = dir[0] * s;
			vel[1] = dir[1] * s;
			vel[2] = dir[2] * s;
		}

		// attachment transform: a scaled frame scales where particles spawn, not how fast they go (e04, e05)
		const scale = this.spawnOptions.attachment?.scale;
		if (scale !== undefined && scale !== 1) {
			pos[0] *= scale;
			pos[1] *= scale;
			pos[2] *= scale;
		}
		const local = this.localSpace;
		const rotateIntoSpace = !(local && def.emitter.localSpace.rotation);
		p.local[i] = local ? 1 : 0;
		if (rotateIntoSpace) {
			rotateByQuat(pos, pos[0], pos[1], pos[2], this.rotation);
			rotateByQuat(vel, vel[0], vel[1], vel[2], this.rotation);
		}
		if (!local) {
			pos[0] += this.position[0];
			pos[1] += this.position[1];
			pos[2] += this.position[2];
		}
		if (def.emitter.localSpace.velocity) {
			vel[0] += this.velocity[0];
			vel[1] += this.velocity[1];
			vel[2] += this.velocity[2];
		}
		const inherit = this.spawnOptions.inheritVelocity;
		if (inherit) {
			vel[0] += inherit[0];
			vel[1] += inherit[1];
			vel[2] += inherit[2];
		}
		p.pos.set(pos, i * 3);
		p.prevPos.set(pos, i * 3);
		p.vel.set(vel, i * 3);

		// spin
		p.rot[i] = this.num(def.particle.initialRotation, 0, 'spawn', i);
		p.rotRate[i] = this.num(def.particle.initialRotationRate, 0, 'spawn', i);

		// lifetime
		if (def.particle.maxLifetime) {
			p.lifetime[i] = this.num(def.particle.maxLifetime, 0, 'spawn', i);
			p.hasLifetime[i] = 1;
		}
		this.writeParticleBuiltins(i);
		// in-game what these events spawn lands at the particle's offset from its emitter, taken as a world
		// position (near the world origin): t52, t53, t58
		for (const e of def.particle.events.creation) this.runEvent(e, i, true);
		return i;
	}

	private sampleShape(shape: ShapeDefinition | null, pos: Vec3, dir: Vec3, i: number) {
		const rnd = this.world.rng.next;
		if (!shape) return;
		const offset = this.vec(shape.offset, [0, 0, 0], 0, 'spawn', i);
		switch (shape.type) {
			case 'point':
			case 'custom':
				break;
			case 'sphere': {
				const radius = this.num(shape.radius, 1, 'spawn', i);
				// uniform direction
				const z = rnd() * 2 - 1;
				const a = rnd() * Math.PI * 2;
				const rr = Math.sqrt(1 - z * z);
				const d = shape.surfaceOnly ? radius : radius * inner(rnd);
				pos[0] = rr * Math.cos(a) * d;
				pos[1] = z * d;
				pos[2] = rr * Math.sin(a) * d;
				break;
			}
			case 'box': {
				const h = this.vec(shape.halfDimensions, [0, 0, 0], 0, 'spawn', i);
				pos[0] = (rnd() * 2 - 1) * h[0];
				pos[1] = (rnd() * 2 - 1) * h[1];
				pos[2] = (rnd() * 2 - 1) * h[2];
				if (shape.surfaceOnly) {
					const axis = Math.floor(rnd() * 3);
					pos[axis] = (rnd() < 0.5 ? -1 : 1) * h[axis];
				}
				break;
			}
			case 'disc': {
				const radius = this.num(shape.radius, 1, 'spawn', i);
				const n = this.vec(shape.planeNormal, [0, 1, 0], 0, 'spawn', i);
				const a = rnd() * Math.PI * 2;
				const d = shape.surfaceOnly ? radius : radius * inner(rnd);
				// basis perpendicular to n
				const nl = len3(n[0], n[1], n[2]) || 1;
				const nx = n[0] / nl, ny = n[1] / nl, nz = n[2] / nl;
				let ux: number, uy: number, uz: number;
				if (Math.abs(ny) < 0.999) {
					// u = normalize(cross(n, up))
					ux = -nz; uy = 0; uz = nx;
				} else {
					ux = 1; uy = 0; uz = 0;
				}
				const ul = len3(ux, uy, uz) || 1;
				ux /= ul; uy /= ul; uz /= ul;
				const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
				const c = Math.cos(a) * d, s = Math.sin(a) * d;
				pos[0] = ux * c + vx * s;
				pos[1] = uy * c + vy * s;
				pos[2] = uz * c + vz * s;
				break;
			}
			case 'entity_aabb': {
				const box = this.spawnOptions.attachment?.aabb ?? { min: [-0.3, 0, -0.3] as Vec3, max: [0.3, 1.8, 0.3] as Vec3 };
				for (let k = 0; k < 3; k++) pos[k] = box.min[k] + rnd() * (box.max[k] - box.min[k]);
				if (shape.surfaceOnly) {
					const axis = Math.floor(rnd() * 3);
					pos[axis] = rnd() < 0.5 ? box.min[axis] : box.max[axis];
				}
				break;
			}
		}
		// direction
		if (shape.direction === 'outwards' || shape.direction === 'inwards') {
			let l = len3(pos[0], pos[1], pos[2]);
			if (l < 1e-7) {
				// point-like: random direction
				const z = rnd() * 2 - 1;
				const a = rnd() * Math.PI * 2;
				const rr = Math.sqrt(1 - z * z);
				dir[0] = rr * Math.cos(a);
				dir[1] = z;
				dir[2] = rr * Math.sin(a);
			} else {
				dir[0] = pos[0] / l;
				dir[1] = pos[1] / l;
				dir[2] = pos[2] / l;
			}
			if (shape.direction === 'inwards') {
				dir[0] = -dir[0];
				dir[1] = -dir[1];
				dir[2] = -dir[2];
			}
			void l;
		} else {
			this.vec(shape.direction, dir, 0, 'spawn', i);
			const l = len3(dir[0], dir[1], dir[2]);
			if (l > 0) {
				dir[0] /= l;
				dir[1] /= l;
				dir[2] /= l;
			}
		}
		pos[0] += offset[0];
		pos[1] += offset[1];
		pos[2] += offset[2];
	}

	// ---------------------------------------------------------------- particle update

	private updateParticles(dt: number) {
		const def = this.def;
		const p = this.pool;
		const part = def.particle;
		const acc: Vec3 = [0, 0, 0];
		const rel: Vec3 = [0, 0, 0];
		const pdir: Vec3 = [0, 0, 0];
		let anyDead = false;
		for (let i = 0; i < p.count; i++) {
			if (p.dead[i]) continue;
			const i3 = i * 3;
			this.writeParticleBuiltins(i);
			this.refreshCurves('particle-update', i);
			this.exec(part.perUpdate, 'particle-update', i);

			p.prevPos[i3] = p.pos[i3];
			p.prevPos[i3 + 1] = p.pos[i3 + 1];
			p.prevPos[i3 + 2] = p.pos[i3 + 2];

			// motion: dynamic (integrate) …
			if (part.dynamic) {
				this.vec(part.dynamic.linearAcceleration, acc, 0, 'particle-update', i);
				const drag = this.num(part.dynamic.linearDrag, 0, 'particle-update', i);
				const vx = p.vel[i3], vy = p.vel[i3 + 1], vz = p.vel[i3 + 2];
				p.vel[i3] = vx + (acc[0] - drag * vx) * dt;
				p.vel[i3 + 1] = vy + (acc[1] - drag * vy) * dt;
				p.vel[i3 + 2] = vz + (acc[2] - drag * vz) * dt;
				p.pos[i3] += p.vel[i3] * dt;
				p.pos[i3 + 1] += p.vel[i3 + 1] * dt;
				p.pos[i3 + 2] += p.vel[i3 + 2] * dt;
				const rotAcc = this.num(part.dynamic.rotationAcceleration, 0, 'particle-update', i);
				const rotDrag = this.num(part.dynamic.rotationDrag, 0, 'particle-update', i);
				p.rotRate[i] += (rotAcc - rotDrag * p.rotRate[i]) * dt;
				p.rot[i] += p.rotRate[i] * dt;
				if (part.collision) this.collide(i, dt);
			}
			// … then parametric (relative_position X→Y→Z, direction X→Y→Z, rotation)
			if (part.parametric) {
				const par = part.parametric;
				if (par.relativePosition) {
					this.vec(par.relativePosition, rel, 0, 'particle-update', i);
					if (p.local[i]) {
						p.pos[i3] = rel[0];
						p.pos[i3 + 1] = rel[1];
						p.pos[i3 + 2] = rel[2];
					} else {
						// world-space emitters on an entity measure it from the world origin (e10)
						const o = this.spawnOptions.attachment?.entity ? ORIGIN : this.position;
						p.pos[i3] = o[0] + rel[0];
						p.pos[i3 + 1] = o[1] + rel[1];
						p.pos[i3 + 2] = o[2] + rel[2];
					}
				}
				if (par.direction) {
					this.vec(par.direction, pdir, 0, 'particle-update', i);
					const speed = len3(p.vel[i3], p.vel[i3 + 1], p.vel[i3 + 2]);
					const dl = len3(pdir[0], pdir[1], pdir[2]);
					if (speed > 1e-6) {
						// steer: keep speed, change direction (a ~zero direction zeroes the velocity)
						const f = dl > 1e-7 ? speed / dl : 0;
						p.vel[i3] = pdir[0] * f;
						p.vel[i3 + 1] = pdir[1] * f;
						p.vel[i3 + 2] = pdir[2] * f;
					} else {
						p.vel[i3] = pdir[0];
						p.vel[i3 + 1] = pdir[1];
						p.vel[i3 + 2] = pdir[2];
					}
				}
				if (par.rotation) p.rot[i] = this.num(par.rotation, 0, 'particle-update', i);
			}

			// age advance
			const prevAge = p.age[i];
			p.age[i] = prevAge + dt;
			const age = p.age[i];

			// lifetime timeline events
			for (const t of part.events.timeline) {
				if (t.at >= prevAge && t.at < age) {
					this.writeParticleBuiltins(i);
					for (const e of t.events) this.runEvent(e, i);
				}
			}

			// expiry (after motion and age advance). Without a lifetime component a particle dies on its first
			// update; with one but no max_lifetime it lives until expired otherwise (t07).
			let die = !!p.dead[i] || !part.hasLifetimeComponent;
			if (!die && p.hasLifetime[i] && age >= p.lifetime[i]) die = true;
			if (!die && part.expiration) {
				this.writeParticleBuiltins(i);
				if (this.num(part.expiration, 0, 'particle-update', i) !== 0) die = true;
			}
			// the first update has no previous position, so the spawn → first position jump never counts (t16)
			if (!die && part.killPlane && prevAge !== 0) die = this.crossesKillPlane(i, part.killPlane);
			if (!die && (part.expireInBlocks || part.expireNotInBlocks) && (this.world.blocks || this.world.planes.length)) die = this.blockExpire(i);
			if (die) {
				p.dead[i] = 1;
				anyDead = true;
				this.writeParticleBuiltins(i);
				for (const e of part.events.expiration) this.runEvent(e, i);
			}
		}
		if (anyDead) p.compact();
	}

	/**
	 * Orientation of particle i exactly as the renderer builds it (same rules as the vertex shader),
	 * for gizmos and the debugger. Null without a billboard.
	 */
	particleFacing(i: number, camera: { position: Vec3; right: Vec3; up: Vec3 }, fallbackUp: Vec3 = [0, 0, -1]): ParticleFacing | null {
		const bb = this.def.particle.billboard;
		if (!bb) return null;
		const p = this.pool;
		const position = this.particleWorldPos(i, [0, 0, 0]);
		const input: Vec3 = [p.facing[i * 3], p.facing[i * 3 + 1], p.facing[i * 3 + 2]];
		const basis = facingBasis(bb.facing, position, input, camera, this.rotation, fallbackUp);
		const a = (p.rot[i] * Math.PI) / 180;
		const c = Math.cos(a);
		const sn = Math.sin(a);
		const R = basis.right;
		const U = basis.up;
		let velocity: ParticleFacing['velocity'] = null;
		if (bb.direction.mode === 'derive_from_velocity') {
			const speed = len3(p.vel[i * 3], p.vel[i * 3 + 1], p.vel[i * 3 + 2]);
			velocity = { speed, minSpeed: bb.direction.minSpeed, held: !(speed > bb.direction.minSpeed) };
		}
		return {
			...basis,
			mode: bb.facing,
			position,
			input,
			velocity,
			rotatedRight: [R[0] * c + U[0] * sn, R[1] * c + U[1] * sn, R[2] * c + U[2] * sn],
			rotatedUp: [U[0] * c - R[0] * sn, U[1] * c - R[1] * sn, U[2] * c - R[2] * sn],
		};
	}

	/** world position of particle i */
	particleWorldPos(i: number, out: Vec3): Vec3 {
		const p = this.pool;
		const x = p.pos[i * 3], y = p.pos[i * 3 + 1], z = p.pos[i * 3 + 2];
		if (!p.local[i]) {
			out[0] = x;
			out[1] = y;
			out[2] = z;
			return out;
		}
		if (this.def.emitter.localSpace.rotation) rotateByQuat(out, x, y, z, this.rotation);
		else {
			out[0] = x;
			out[1] = y;
			out[2] = z;
		}
		out[0] += this.position[0];
		out[1] += this.position[1];
		out[2] += this.position[2];
		return out;
	}

	private crossesKillPlane(i: number, [a, b, c, d]: [number, number, number, number]): boolean {
		const p = this.pool;
		const i3 = i * 3;
		// emitter-relative position, world-oriented axes
		const ex = p.local[i] ? 0 : this.position[0];
		const ey = p.local[i] ? 0 : this.position[1];
		const ez = p.local[i] ? 0 : this.position[2];
		const prev = a * (p.prevPos[i3] - ex) + b * (p.prevPos[i3 + 1] - ey) + c * (p.prevPos[i3 + 2] - ez) + d;
		const cur = a * (p.pos[i3] - ex) + b * (p.pos[i3 + 1] - ey) + c * (p.pos[i3 + 2] - ez) + d;
		return (prev <= 0 && cur > 0) || (prev > 0 && cur <= 0);
	}

	private blockExpire(i: number): boolean {
		const wp = this.particleWorldPos(i, tmp);
		const x = Math.floor(wp[0]), y = Math.floor(wp[1]), z = Math.floor(wp[2]);
		let id = this.world.blocks?.getBlock(x, y, z) ?? 'minecraft:air';
		// below a ground plane is its block (a flat world's ground is solid all the way down), judged at the
		// block's centre like a placed block
		if (id === 'minecraft:air') {
			for (const pl of this.world.planes) {
				if (pl.normal[0] * (x + 0.5) + pl.normal[1] * (y + 0.5) + pl.normal[2] * (z + 0.5) < pl.d) {
					id = pl.block;
					break;
				}
			}
		}
		const part = this.def.particle;
		if (part.expireInBlocks && part.expireInBlocks.includes(id)) return true;
		if (part.expireNotInBlocks && !part.expireNotInBlocks.includes(id)) return true;
		return false;
	}

	/**
	 * Box-vs-blocks collision against each block's real collision boxes (t17), resolved axis by axis
	 * (Y, X, Z) by clipping the movement like entity movement does.
	 */
	private collide(i: number, dt: number) {
		const col = this.def.particle.collision!;
		const w = this.world;
		if (!w.blocks && !w.planes.length) return;
		if (col.enabled && this.num(col.enabled, 1, 'particle-update', i) === 0) return;
		const p = this.pool;
		const i3 = i * 3;
		const r = Math.max(col.radius, 0.0001);
		const local = p.local[i] === 1;
		const ox = local ? this.position[0] : 0, oy = local ? this.position[1] : 0, oz = local ? this.position[2] : 0;
		const prev: Vec3 = [p.prevPos[i3] + ox, p.prevPos[i3 + 1] + oy, p.prevPos[i3 + 2] + oz];
		const target: Vec3 = [p.pos[i3] + ox, p.pos[i3 + 1] + oy, p.pos[i3 + 2] + oz];
		const boxes = this.collisionBoxes(prev, target, r);
		const cur: Vec3 = [prev[0], prev[1], prev[2]];
		let hit = false;
		let impactSpeed = 0;
		const EPS = 1e-7;
		for (const axis of [1, 0, 2]) {
			const want = target[axis] - cur[axis];
			let move = want;
			if (move !== 0) {
				const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
				for (const b of boxes) {
					// only boxes overlapping the particle on the other two axes can block this axis
					if (cur[a1] + r <= b[a1] + EPS || cur[a1] - r >= b[a1 + 3] - EPS) continue;
					if (cur[a2] + r <= b[a2] + EPS || cur[a2] - r >= b[a2 + 3] - EPS) continue;
					if (move > 0 && cur[axis] + r <= b[axis] + EPS) move = Math.min(move, b[axis] - (cur[axis] + r));
					else if (move < 0 && cur[axis] - r >= b[axis + 3] - EPS) move = Math.max(move, b[axis + 3] - (cur[axis] - r));
				}
			}
			cur[axis] += move;
			if (move !== want) {
				const v = p.vel[i3 + axis];
				impactSpeed = Math.max(impactSpeed, Math.abs(v));
				p.vel[i3 + axis] = -v * col.restitution;
				hit = true;
			}
		}
		if (hit) {
			const speed = len3(p.vel[i3], p.vel[i3 + 1], p.vel[i3 + 2]);
			// collision_drag: slows the particle by this many blocks/sec while in contact
			if (col.drag > 0 && speed > 0) {
				const f = Math.max(0, speed - col.drag * dt) / speed;
				p.vel[i3] *= f;
				p.vel[i3 + 1] *= f;
				p.vel[i3 + 2] *= f;
			}
			const total = Math.max(impactSpeed, speed);
			for (const ev of col.events) if (total >= ev.minSpeed) this.runEvent(ev.event, i);
			if (col.expireOnContact) p.dead[i] = 1;
		}
		p.contact[i] = hit ? 1 : 0;
		p.pos[i3] = cur[0] - ox;
		p.pos[i3 + 1] = cur[1] - oy;
		p.pos[i3 + 2] = cur[2] - oz;
	}

	/** World-space collision boxes ([minX, minY, minZ, maxX, maxY, maxZ]) around a movement */
	private collisionBoxes(from: Vec3, to: Vec3, r: number): number[][] {
		const w = this.world;
		const out: number[][] = [];
		const BIG = 1e7;
		for (const pl of w.planes) {
			// axis-aligned half-spaces (solid where dot(n, p) < d)
			const [nx, ny, nz] = pl.normal;
			const axis = Math.abs(nx) === 1 ? 0 : Math.abs(ny) === 1 ? 1 : Math.abs(nz) === 1 ? 2 : -1;
			if (axis < 0) continue;
			const sgn = axis === 0 ? nx : axis === 1 ? ny : nz;
			const box = [-BIG, -BIG, -BIG, BIG, BIG, BIG];
			if (sgn > 0) box[axis + 3] = pl.d;
			else box[axis] = -pl.d;
			out.push(box);
		}
		const b = w.blocks;
		if (!b) return out;
		// fences reach 1.5 blocks up, so look one block further below the swept region
		const x0 = Math.floor(Math.min(from[0], to[0]) - r), x1 = Math.floor(Math.max(from[0], to[0]) + r);
		const y0 = Math.floor(Math.min(from[1], to[1]) - r) - 1, y1 = Math.floor(Math.max(from[1], to[1]) + r);
		const z0 = Math.floor(Math.min(from[2], to[2]) - r), z1 = Math.floor(Math.max(from[2], to[2]) + r);
		if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4096) return out; // runaway velocity: skip blocks
		for (let x = x0; x <= x1; x++)
			for (let y = y0; y <= y1; y++)
				for (let z = z0; z <= z1; z++) {
					const id = b.getBlock(x, y, z);
					const shapes = b.getCollisionBoxes?.(id, x, y, z);
					if (shapes) {
						for (const s of shapes) out.push([x + s[0], y + s[1], z + s[2], x + s[3], y + s[4], z + s[5]]);
					} else if (b.isSolid(id)) out.push([x, y, z, x + 1, y + 1, z + 1]);
				}
		return out;
	}

	// ---------------------------------------------------------------- events

	runEvent(name: string, particle: number, atOrigin = false): void {
		const node = this.def.events.get(name);
		const w = this.world;
		w.onEvent?.(this, name, particle);
		if (!node) {
			const c = w.current;
			c.path = 'particle_effect/events';
			c.emitter = this.id;
			w.reportError('missing-event', -1, name);
			return;
		}
		if (particle >= 0) this.writeParticleBuiltins(particle);
		this.execEvent(node, particle, atOrigin);
	}

	/**
	 * One event node, as measured in-game (t49–t52): a node with a sequence or a randomize runs the sequence,
	 * then one random option, and ignores its own expression, sound and particle_effect; a plain node spawns
	 * its particle_effect before running its expression.
	 */
	private execEvent(node: EventNode, particle: number, atOrigin: boolean) {
		if (node.sequence || node.randomize) {
			if (node.sequence) for (const s of node.sequence) this.execEvent(s, particle, atOrigin);
			const pick = node.randomize ? pickRandom(node.randomize, this.world.rng.next()) : null;
			if (pick) this.execEvent(pick, particle, atOrigin);
			return;
		}
		if (node.particleEffect) this.spawnChild(node.particleEffect, particle, atOrigin);
		if (node.expression) this.exec(node.expression, 'event', particle);
		if (node.sound && this.world.onSound) {
			const pos: Vec3 = particle >= 0 ? this.particleWorldPos(particle, [0, 0, 0]) : [...this.position];
			this.world.onSound(node.sound.event, pos, this);
		}
	}

	private spawnChild(pe: NonNullable<EventNode['particleEffect']>, particle: number, atOrigin = false) {
		const w = this.world;
		const def = w.resolveEffect(pe.effect);
		if (!def) {
			const c = w.current;
			c.path = 'particle_effect/events';
			c.emitter = this.id;
			w.reportError('missing-effect', -1, pe.effect);
			return;
		}
		// Where the child appears, as measured in-game. Effects spawned by /particle or scripts, and effects started on
		// an entity that don't follow it (bind_to_actor: false, e13): single-particle spawns appear at the world origin
		// whatever fired them (t55-t58), and what a particle creation event spawns lands at the particle's offset from
		// its emitter, taken as a world position (t58). The game's own effects (lava smoke) place these normally.
		// Effects that follow an entity (e13, e14, e17, e18): emitter_bound children appear at the emitter; emitter
		// children at the particle, but at the emitter when the parent's particles are in its local space, and away
		// from the entity for a local-space creation event; single-particle children exist but appear away from the
		// entity. Where those two go isn't measured: Oxygen puts them where /particle effects put them.
		const single = pe.type === 'particle' || pe.type === 'particle_with_velocity';
		const actor = this.rootOnActor;
		const local = this.def.emitter.localSpace.position;
		let position: Vec3;
		if (single) position = [0, 0, 0];
		else if (actor && pe.type === 'emitter_bound') position = [...this.position];
		else if (atOrigin && particle >= 0 && (!actor || local)) {
			const w = this.particleWorldPos(particle, [0, 0, 0]);
			position = [w[0] - this.position[0], w[1] - this.position[1], w[2] - this.position[2]];
		} else if (actor && local) position = [...this.position];
		else position = particle >= 0 ? this.particleWorldPos(particle, [0, 0, 0]) : [...this.position];
		const withVel = pe.type === 'particle_with_velocity' && particle >= 0;
		const p = this.pool;
		w.spawn(def, {
			position,
			rotation: [...this.rotation] as Quat,
			context: 'event',
			parent: this,
			bound: pe.type === 'emitter_bound',
			preEffect: pe.preEffect ?? null,
			singleParticle: pe.type === 'particle' || pe.type === 'particle_with_velocity',
			inheritVelocity: withVel ? [p.vel[particle * 3], p.vel[particle * 3 + 1], p.vel[particle * 3 + 2]] : null,
		});
	}

	// ---------------------------------------------------------------- render preparation

	prepareRender(): void {
		this.prepareParticles();
		let size = 0;
		const p = this.pool;
		for (let i = 0; i < p.count; i++) size = Math.max(size, Math.abs(p.size[i * 2]), Math.abs(p.size[i * 2 + 1]));
		if (p.count) this.drawnSize = Math.max(this.drawnSize ?? 0, size);
	}

	private prepareParticles(): void {
		const def = this.def;
		const bb = def.particle.billboard;
		const p = this.pool;
		const part = def.particle;
		const color = [1, 1, 1, 1];
		const fdir: Vec3 = [0, 0, 0];
		const directional = !!bb && DIRECTION_MODES.has(bb.facing);
		for (let i = 0; i < p.count; i++) {
			this.writeParticleBuiltins(i);
			this.refreshCurves('render', i);
			this.exec(part.perRender, 'render', i);
			if (!bb) {
				p.visible[i] = 0;
				continue;
			}
			// size W → H, then UV
			const w = this.num(bb.size[0], 0, 'render', i);
			const h = this.num(bb.size[1], 0, 'render', i);
			p.size[i * 2] = w;
			p.size[i * 2 + 1] = h;
			p.visible[i] = w >= 0 && h >= 0 ? 1 : 0; // negative sizes don't render in-game (#119)
			this.computeUV(i);

			// facing direction (direction_* / lookat_direction)
			if (bb.direction.mode === 'custom') {
				this.vec(bb.direction.custom, fdir, 0, 'render', i);
				p.facing[i * 3] = fdir[0];
				p.facing[i * 3 + 1] = fdir[1];
				p.facing[i * 3 + 2] = fdir[2];
			} else {
				const i3 = i * 3;
				const speed = len3(p.vel[i3], p.vel[i3 + 1], p.vel[i3 + 2]);
				// only when speed EXCEEDS the threshold; otherwise keep the previous facing
				if (speed > bb.direction.minSpeed) {
					p.facing[i3] = p.vel[i3] / speed;
					p.facing[i3 + 1] = p.vel[i3 + 1] / speed;
					p.facing[i3 + 2] = p.vel[i3 + 2] / speed;
				}
			}
			// direction modes without a direction (never moved fast enough, or a zero custom direction)
			// collapse and draw nothing (t14 p7, t34–t36)
			if (directional) {
				const i3 = i * 3;
				if (p.facing[i3] * p.facing[i3] + p.facing[i3 + 1] * p.facing[i3 + 1] + p.facing[i3 + 2] * p.facing[i3 + 2] <= 1e-12) p.visible[i] = 0;
			}

			// tint: reset to white, multiply
			color[0] = color[1] = color[2] = color[3] = 1;
			const tint = part.tint;
			if (tint?.type === 'color') {
				color[0] *= this.num(tint.color[0], 1, 'render', i);
				color[1] *= this.num(tint.color[1], 1, 'render', i);
				color[2] *= this.num(tint.color[2], 1, 'render', i);
				color[3] *= this.num(tint.color[3], 1, 'render', i);
			} else if (tint?.type === 'gradient' && tint.stops.length) {
				const t = this.num(tint.interpolant, 0, 'render', i);
				const stops = tint.stops;
				let a = 0;
				while (a < stops.length - 1 && stops[a + 1].key <= t) a++;
				const sa = stops[a];
				if (t <= stops[0].key || a === stops.length - 1) {
					const s = t <= stops[0].key ? stops[0] : sa;
					for (let k = 0; k < 4; k++) color[k] *= this.num(s.color[k], 1, 'render', i);
				} else {
					const sb = stops[a + 1];
					const f = (t - sa.key) / (sb.key - sa.key);
					for (let k = 0; k < 4; k++) {
						const ca = this.num(sa.color[k], 1, 'render', i);
						const cb = this.num(sb.color[k], 1, 'render', i);
						color[k] *= ca + (cb - ca) * f;
					}
				}
			}
			// pack like the game: trunc(c * 255), clamped to 0–255
			for (let k = 0; k < 4; k++) {
				let b = Math.trunc(color[k] * 255);
				if (!(b > 0)) b = 0;
				else if (b > 255) b = 255;
				p.color[i * 4 + k] = b;
			}
		}
	}

	private computeUV(i: number) {
		const uv = this.def.particle.billboard!.uv;
		const p = this.pool;
		const o = i * 4;
		if (!uv) {
			p.uv[o] = 0;
			p.uv[o + 1] = 0;
			p.uv[o + 2] = 1;
			p.uv[o + 3] = 1;
			return;
		}
		const tw = uv.textureWidth || 1;
		const th = uv.textureHeight || 1;
		let u = 0, v = 0, su = tw, sv = th;
		if (uv.flipbook) {
			const fb = uv.flipbook;
			u = this.num(fb.base[0], 0, 'render', i);
			v = this.num(fb.base[1], 0, 'render', i);
			su = fb.size[0];
			sv = fb.size[1];
			const maxFrame = this.num(fb.maxFrame, 1, 'render', i);
			const fps = fb.stretchToLifetime && p.hasLifetime[i] && p.lifetime[i] > 0 ? maxFrame / p.lifetime[i] : fb.fps;
			let frame = Math.floor(p.age[i] * fps);
			if (maxFrame >= 1) {
				// max_frame counts from 1
				if (fb.loop) frame = frame % Math.floor(maxFrame);
				else frame = Math.min(frame, Math.floor(maxFrame) - 1);
			}
			if (frame < 0) frame = 0;
			u += fb.step[0] * frame;
			v += fb.step[1] * frame;
		} else {
			if (uv.uv) {
				u = this.num(uv.uv[0], 0, 'render', i);
				v = this.num(uv.uv[1], 0, 'render', i);
			}
			if (uv.uvSize) {
				su = this.num(uv.uvSize[0], tw, 'render', i);
				sv = this.num(uv.uvSize[1], th, 'render', i);
			}
		}
		// a zero UV size samples a sliver of the texture, exactly like the game (#118)
		p.uv[o] = u / tw;
		p.uv[o + 1] = v / th;
		p.uv[o + 2] = (u + su) / tw;
		p.uv[o + 3] = (v + sv) / th;
	}

	// ---------------------------------------------------------------- culling

	/** Whole-emitter frustum test over its particles' bounds */
	isCulled(cam: CameraState): boolean {
		const p = this.pool;
		if (p.count === 0 || this.drawnSize === null) return false;
		let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
		let maxSize = this.drawnSize;
		for (let i = 0; i < p.count; i++) {
			this.particleWorldPos(i, tmp2);
			if (tmp2[0] < minX) minX = tmp2[0];
			if (tmp2[1] < minY) minY = tmp2[1];
			if (tmp2[2] < minZ) minZ = tmp2[2];
			if (tmp2[0] > maxX) maxX = tmp2[0];
			if (tmp2[1] > maxY) maxY = tmp2[1];
			if (tmp2[2] > maxZ) maxZ = tmp2[2];
			const s = Math.max(Math.abs(p.size[i * 2]), Math.abs(p.size[i * 2 + 1]));
			if (s > maxSize) maxSize = s;
		}
		const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
		const radius = len3(maxX - cx, maxY - cy, maxZ - cz) + maxSize * 1.5 + 0.5;
		const dx = cx - cam.position[0], dy = cy - cam.position[1], dz = cz - cam.position[2];
		// view-space coordinates of the bounding sphere centre
		const z = dx * cam.forward[0] + dy * cam.forward[1] + dz * cam.forward[2];
		const x = dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2];
		const y = dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2];
		if (z < -radius) return true; // behind the camera
		const halfV = (cam.fovY * Math.PI) / 360;
		const halfH = Math.atan(Math.tan(halfV) * cam.aspect);
		const ch = Math.cos(halfH), sh = Math.sin(halfH), cv = Math.cos(halfV), sv = Math.sin(halfV);
		if (x * ch - z * sh > radius || -x * ch - z * sh > radius) return true;
		if (y * cv - z * sv > radius || -y * cv - z * sv > radius) return true;
		return false;
	}

	// ---------------------------------------------------------------- snapshots

	snapshot(): EmitterSnapshot {
		return {
			id: this.id,
			def: this.def,
			spawnOptions: this.spawnOptions,
			parentId: this.parentId,
			vars: this.vars.slice(),
			pool: this.pool.clone(),
			position: [...this.position] as Vec3,
			rotation: [...this.rotation] as Quat,
			scalars: {
				age: this.age,
				totalAge: this.totalAge,
				loopIndex: this.loopIndex,
				randoms: [...this.randoms],
				activeTime: this.activeTime,
				sleepTime: this.sleepTime,
				maxParticles: this.maxParticles,
				active: this.active,
				expired: this.expired,
				failed: this.failed,
				burstDone: this.burstDone,
				spawnAccumulator: this.spawnAccumulator,
				travelled: this.travelled,
				loopingTravel: [...this.loopingTravel],
				manualAccumulator: this.manualAccumulator,
				velocity: [...this.velocity],
				boundOffset: this.boundOffset ? [...this.boundOffset] : null,
			},
		};
	}

	restore(s: EmitterSnapshot): void {
		this.vars.length = 0;
		for (let k = 0; k < s.vars.length; k++) this.vars[k] = s.vars[k];
		const src = s.pool.clone();
		Object.assign(this.pool, src);
		this.position = [...s.position] as Vec3;
		this.rotation = [...s.rotation] as Quat;
		const sc = s.scalars as any;
		this.age = sc.age;
		this.totalAge = sc.totalAge;
		this.loopIndex = sc.loopIndex;
		this.randoms = [...sc.randoms] as any;
		this.activeTime = sc.activeTime;
		this.sleepTime = sc.sleepTime;
		this.maxParticles = sc.maxParticles;
		this.active = sc.active;
		this.expired = sc.expired;
		this.failed = sc.failed;
		this.burstDone = sc.burstDone;
		this.spawnAccumulator = sc.spawnAccumulator;
		this.travelled = sc.travelled;
		this.loopingTravel = [...sc.loopingTravel];
		this.manualAccumulator = sc.manualAccumulator;
		this.velocity = [...sc.velocity] as Vec3;
		this.boundOffset = sc.boundOffset ? ([...sc.boundOffset] as Vec3) : null;
		this.parentId = s.parentId;
	}
}

export type { CompiledExpression };
