import { compile, createEnv, SymbolTable, TempScope, type CompiledExpression, type MolangErrorCode, type Value } from 'molangjs';
import { BUILTIN_VARIABLES, readEffect, type EffectDefinition, type MolangField } from './definition';
import { EmitterInstance, type Attachment, type SpawnOptions } from './emitter';
import { ParticlePool } from './pool';
import { Rng, type Quat, type Vec3 } from './vec';

/** Supplies block ids for collision and Kill/Only-in-blocks tests. */
export interface BlockProvider {
	/** Block identifier at integer coordinates; 'minecraft:air' when empty. */
	getBlock(x: number, y: number, z: number): string;
	/** Whether particles collide with this block (full cube unless `getCollisionBoxes` says otherwise) */
	isSolid(id: string): boolean;
	/**
	 * The block's real collision boxes in block-local units ([minX, minY, minZ, maxX, maxY, maxZ], 0–1, may exceed
	 * 1 like fences). Particles collide with these in-game (t17: slabs, fences; water and grass have none).
	 * Return undefined to fall back to `isSolid` → full cube.
	 */
	getCollisionBoxes?(id: string, x: number, y: number, z: number): readonly (readonly number[])[] | undefined;
}

/** Infinite half-space collider (ground plane): solid where dot(n, p) < d */
export interface PlaneCollider {
	normal: Vec3;
	d: number;
	block: string;
}

export interface CameraState {
	position: Vec3;
	/** unit forward / up / right vectors */
	forward: Vec3;
	up: Vec3;
	right: Vec3;
	fovY: number;
	aspect: number;
	near: number;
	far: number;
}

export type SpawnContext = 'command' | 'entity' | 'script' | 'event';

export interface QueryContext {
	world: ParticleWorld;
	emitter: EmitterInstance;
	/** index into emitter.pool, or -1 outside particle expressions */
	particle: number;
	spawnContext: SpawnContext;
}

export interface QueryProvider {
	/** Return undefined for unknown queries (they evaluate to 0.0 and are reported) */
	resolve(name: string, args: Value[], ctx: QueryContext): Value | undefined;
	/** Why a query `resolve` had no value for has none (no entity, no such bone…), for the report */
	why?(name: string, args: Value[], ctx: QueryContext): string | undefined;
}

/** Resolves child effects referenced by events */
export type EffectResolver = (identifier: string) => EffectDefinition | null;

export interface WorldOptions {
	/** Emulate 32-bit floats in Molang (default true) */
	f32?: boolean;
	/**
	 * Bedrock's undocumented live-particle cap per emitter, by spawn context. Measured in 1.26.52:
	 * 1000 for /particle and Script API emitters (t42/t43), and for emitters on an entity too, bursts and
	 * steady rates alike (e09/e12; creators had reported 10,000). Event children use their root emitter's context.
	 */
	particleCap?: number | Partial<Record<SpawnContext, number>>;
	/** Spawn contexts whose looping emitters restart. /particle and Script API emitters play one loop (t31/t38). */
	loopingContexts?: SpawnContext[];
	/** Unset reads: 'abort' stops the expression like the game (t01); 'zero' reads 0.0 and continues */
	unsetMode?: 'zero' | 'abort';
	seed?: number;
	/** The pack's min_engine_version (Molang rules for plain-string expressions) */
	engine?: string | readonly number[] | null;
	/** Query registry: unknown queries become load errors (see DefinitionOptions.queryExists) */
	queryExists?: ((name: string) => boolean) | null;
}

export const DEFAULT_PARTICLE_CAPS: Record<SpawnContext, number> = { command: 1000, script: 1000, entity: 1000, event: 1000 };

export interface ContentError {
	code: MolangErrorCode | 'cap' | 'missing-effect' | 'missing-event';
	path: string;
	node: number;
	emitter: number;
	count: number;
	firstFrame: number;
	lastFrame: number;
	detail?: string;
}

export interface TraceRecord {
	frame: number;
	phase: Phase;
	path: string;
	emitter: number;
	particle: number;
	/** node id → values seen (loops can produce several) */
	values: Map<number, Value[]>;
	result: Value;
	varsBefore: Record<string, Value>;
	varsAfter: Record<string, Value>;
	temps: [string, Value][];
}

export type Phase = 'creation' | 'emitter-update' | 'spawn' | 'particle-update' | 'render' | 'event';

export interface LogEntry {
	frame: number;
	phase: Phase;
	emitter: number;
	particle: number;
	path: string;
	result: Value;
}

export interface DebugSettings {
	/** Trace every evaluation for this emitter (and particle, if set) */
	select: { emitter: number; particle: number | null } | null;
	/** Record a chronological execution log (limited) */
	log: boolean;
	logLimit: number;
	/** Halt the current update after this many evaluations (deterministic replay stepping) */
	haltAfter: number | null;
}

export class HaltSignal {
	constructor(readonly at: { phase: Phase; path: string; emitter: number; particle: number }) {}
}

interface Slots {
	emitterAge: number;
	emitterLifetime: number;
	emitterRandom: number[];
	particleAge: number;
	particleLifetime: number;
	particleRandom: number[];
}

/**
 * The particle simulation. Call `step(dt)` once per rendered frame: it runs the emitter/particle
 * update pass for every emitter, then the render-preparation pass (Bedrock does both per frame).
 */
export class ParticleWorld {
	readonly symbols = new SymbolTable();
	readonly temps = new TempScope();
	/** context.* values by symbol slot. Molang can't write them: the host supplies them (a scenario's c.x) */
	readonly contexts: Value[] = [];
	readonly options: {
		f32: boolean;
		particleCap: Record<SpawnContext, number>;
		loopingContexts: Set<SpawnContext>;
		unsetMode: 'zero' | 'abort';
		seed: number;
		engine: string | readonly number[] | null;
		queryExists: ((name: string) => boolean) | null;
	};
	readonly slots: Slots;
	emitters: EmitterInstance[] = [];
	time = 0;
	frame = 0;
	rng: Rng;
	blocks: BlockProvider | null = null;
	planes: PlaneCollider[] = [];
	queries: QueryProvider | null = null;
	resolveEffect: EffectResolver = () => null;
	camera: CameraState = {
		position: [0, 1.62, 5],
		forward: [0, 0, -1],
		up: [0, 1, 0],
		right: [1, 0, 0],
		fovY: 70,
		aspect: 16 / 9,
		near: 0.05,
		far: 4096,
	};
	/** Emitter culling (whole emitter only — particles never cull individually) */
	cullEmitters = true;
	onSound: ((event: string, position: Vec3, emitter: EmitterInstance) => void) | null = null;
	/** Called whenever an emitter fires an event by name (including names it doesn't define); `particle` is -1 for emitter events */
	onEvent: ((emitter: EmitterInstance, name: string, particle: number) => void) | null = null;
	/** Called at the start of every update, after the clock advances (host-side inputs, e.g. editor overrides) */
	beforeUpdate: ((world: ParticleWorld) => void) | null = null;

	errors = new Map<string, ContentError>();
	debug: DebugSettings = { select: null, log: false, logLimit: 5000, haltAfter: null };
	traces: TraceRecord[] = [];
	log: LogEntry[] = [];
	/** evaluation counter (for haltAfter stepping) */
	evalCount = 0;

	private nextEmitterId = 1;
	nextParticleId = 1;
	/** field currently evaluating (error attribution) */
	current: { path: string; emitter: number; particle: number; phase: Phase } = { path: '', emitter: 0, particle: -1, phase: 'creation' };
	private traceCache = new Map<CompiledExpression, CompiledExpression>();
	/**
	 * Variables, temps and the random state as the last update left them, before render preparation wrote to
	 * them (render-pass counters, temps, math.random). Preparing the same frame again (a paused preview
	 * redrawing, an edit re-rendering a paused frame) starts over from here, so those writes don't pile up.
	 */
	private renderBase: RenderBase = { frame: -1, rng: 0, tempsV: [], tempsG: [], tempsGen: 0, vars: new WeakMap() };
	/**
	 * Emitters adopted from another world (a worker thread) arrive already prepared for their frame, with the
	 * variables they had before that preparation. If this world hasn't prepared the frame yet, its first preparation
	 * starts them from those; an update in between moves on and drops them.
	 */
	private adoptedBase = new Map<EmitterInstance, Value[]>();

	constructor(options: WorldOptions = {}) {
		const cap = options.particleCap;
		this.options = {
			f32: options.f32 ?? true,
			particleCap: typeof cap === 'number' ? { command: cap, script: cap, entity: cap, event: cap } : { ...DEFAULT_PARTICLE_CAPS, ...(cap ?? {}) },
			loopingContexts: new Set(options.loopingContexts ?? ['entity']),
			unsetMode: options.unsetMode ?? 'abort',
			seed: options.seed ?? 0x5eed,
			engine: options.engine ?? null,
			queryExists: options.queryExists ?? null,
		};
		this.rng = new Rng(this.options.seed);
		const s = this.symbols;
		for (const b of BUILTIN_VARIABLES) s.variable(b);
		this.slots = {
			emitterAge: s.variable('variable.emitter_age'),
			emitterLifetime: s.variable('variable.emitter_lifetime'),
			emitterRandom: [1, 2, 3, 4].map((i) => s.variable(`variable.emitter_random_${i}`)),
			particleAge: s.variable('variable.particle_age'),
			particleLifetime: s.variable('variable.particle_lifetime'),
			particleRandom: [1, 2, 3, 4].map((i) => s.variable(`variable.particle_random_${i}`)),
		};
	}

	/** Compile particle JSON against this world's symbol table */
	loadEffect(json: unknown, engine?: string | readonly number[] | null): EffectDefinition {
		return readEffect(json, {
			symbols: this.symbols,
			engine: engine ?? this.options.engine,
			f32: this.options.f32,
			queryExists: this.options.queryExists ?? undefined,
		});
	}

	/**
	 * Run an edited definition in the emitters running `from`, keeping their state and live particles, so
	 * per-frame changes (appearance, motion, curves) show at once. What was decided when particles or the
	 * emitter were created stays as it was until they're created again. Returns how many emitters switched.
	 */
	swapEffect(from: EffectDefinition, to: EffectDefinition): number {
		let n = 0;
		for (const e of this.emitters) {
			if (e.def !== from) continue;
			e.def = to;
			n++;
		}
		return n;
	}

	spawn(def: EffectDefinition, options: SpawnOptions = {}): EmitterInstance {
		const e = new EmitterInstance(this, def, this.nextEmitterId++, options);
		this.emitters.push(e);
		e.create(options);
		return e;
	}

	/**
	 * A looping emitter begins a new loop. The game makes a new emitter for each loop, so the particles already out
	 * stay with the old one: they keep its variable map (index counters go on counting only them), they count toward
	 * its particle cap, not the new loop's, and it lives on, expired, until they're gone. Here the emitter keeps its id
	 * and starts the loop empty; its particles move to an expired copy right after it, updated later this frame.
	 */
	retireLoop(e: EmitterInstance): EmitterInstance | null {
		if (!e.pool.count) return null;
		const old = new EmitterInstance(this, e.def, this.nextEmitterId++, e.spawnOptions);
		old.restore(e.snapshot());
		old.parent = e.parent;
		old.expired = true;
		old.active = false;
		e.pool.clear();
		this.emitters.splice(this.emitters.indexOf(e) + 1, 0, old);
		return old;
	}

	/** Advance the simulation by dt seconds: update pass, then render preparation. */
	step(dt: number): HaltSignal | null {
		try {
			this.update(dt);
			this.prepareRender();
			return null;
		} catch (e) {
			if (e instanceof HaltSignal) return e;
			throw e;
		}
	}

	update(dt: number): void {
		this.adoptedBase.clear();
		this.frame++;
		this.time += dt;
		this.traces.length = 0;
		this.evalCount = 0;
		this.beforeUpdate?.(this);
		// emitters spawned during this loop (child events) are updated this frame too
		for (let i = 0; i < this.emitters.length; i++) this.emitters[i].update(dt);
		this.emitters = this.emitters.filter((e) => !e.removable());
	}

	prepareRender(): void {
		this.restoreRenderBase();
		for (const e of this.emitters) {
			e.culled = this.cullEmitters && e.isCulled(this.camera);
			if (!e.culled) e.prepareRender();
		}
	}

	/** The first render preparation of a frame records the update's result; later ones in that frame restore it */
	private restoreRenderBase(): void {
		const b = this.renderBase;
		const again = b.frame === this.frame;
		if (again) {
			this.rng.state = b.rng;
			copyInto(this.temps.v, b.tempsV);
			copyInto(this.temps.g, b.tempsG);
			this.temps.gen = b.tempsGen;
		} else {
			b.frame = this.frame;
			b.rng = this.rng.state;
			copyInto(b.tempsV, this.temps.v);
			copyInto(b.tempsG, this.temps.g);
			b.tempsGen = this.temps.gen;
		}
		for (const e of this.emitters) {
			let saved = b.vars.get(e);
			if (!saved) b.vars.set(e, (saved = { frame: -1, vars: [] }));
			// an emitter spawned since this frame's first preparation has nothing recorded yet
			if (again && saved.frame === b.frame) copyInto(e.vars, saved.vars);
			else {
				const adopted = this.adoptedBase.get(e);
				if (adopted) copyInto(e.vars, adopted);
				saved.frame = b.frame;
				copyInto(saved.vars, e.vars);
			}
		}
		this.adoptedBase.clear();
	}

	clear(): void {
		this.emitters = [];
		this.errors.clear();
		this.traces.length = 0;
		this.log.length = 0;
		this.time = 0;
		this.frame = 0;
		this.renderBase.frame = -1;
		this.adoptedBase.clear();
		this.rng = new Rng(this.options.seed);
		this.temps.v.length = 0;
		this.temps.g.length = 0;
		this.contexts.length = 0;
		this.nextParticleId = 1;
		this.nextEmitterId = 1;
	}

	get particleCount(): number {
		let n = 0;
		for (const e of this.emitters) n += e.pool.count;
		return n;
	}

	// ---- evaluation plumbing

	createEnv(vars: Value[]) {
		const world = this;
		return createEnv({
			v: vars,
			t: this.temps,
			c: this.contexts,
			rnd: this.rng.next,
			unsetMode: this.options.unsetMode,
			err: (code, node) => world.reportError(code, node),
			q: () => 0,
			// structs (v.a.b) need the names behind the slots
			sym: this.symbols,
		});
	}

	/** `detail` can be a function: it's only worked out the first time this error is seen */
	reportError(code: ContentError['code'], node: number, detail?: string | (() => string)): void {
		const { path, emitter } = this.current;
		const key = `${code}|${path}|${node}`;
		const existing = this.errors.get(key);
		if (existing) {
			existing.count++;
			existing.lastFrame = this.frame;
		} else {
			this.errors.set(key, { code, path, node, emitter, count: 1, firstFrame: this.frame, lastFrame: this.frame, detail: typeof detail === 'function' ? detail() : detail });
		}
	}

	/** Trace-mode twin of a compiled expression (lazily compiled, cached) */
	traceVersion(field: MolangField): CompiledExpression {
		let t = this.traceCache.get(field.expr);
		if (!t) {
			t = compile(typeof field.raw === 'number' ? field.raw : field.expr.source, {
				symbols: this.symbols,
				features: field.expr.program.features,
				version: field.version,
				f32: this.options.f32,
				mode: 'trace',
				context: 'particle',
			});
			this.traceCache.set(field.expr, t);
		}
		return t;
	}

	/**
	 * Change an emitter's variable or a temp from outside (the debugger), as if an expression had set it just now.
	 * A frame already prepared for drawing is drawn again with it, rather than going back to what the update left.
	 */
	setValue(emitter: EmitterInstance | null, name: string, value: Value): void {
		const full = name.toLowerCase().replace(/^v\./, 'variable.').replace(/^t\./, 'temp.');
		const b = this.renderBase;
		if (full.startsWith('temp.')) {
			const slot = this.symbols.temp(full);
			this.temps.set(slot, value);
			if (b.frame === this.frame) {
				b.tempsV[slot] = value;
				b.tempsG[slot] = this.temps.gen;
			}
			return;
		}
		if (!emitter) return;
		const slot = this.symbols.variable(full);
		emitter.vars[slot] = value;
		const saved = b.vars.get(emitter);
		if (saved && saved.frame === b.frame) saved.vars[slot] = value;
	}

	snapshotVars(vars: Value[]): Record<string, Value> {
		const out: Record<string, Value> = {};
		const names = this.symbols.variableNames;
		for (let i = 0; i < vars.length; i++) if (vars[i] !== undefined) out[names[i]] = vars[i];
		return out;
	}

	// ---- moving emitters between worlds (threads)

	/** Start this world's emitter and particle ids at these values, so ids stay unique across worlds */
	reserveIds(emitterStart: number, particleStart: number): void {
		this.nextEmitterId = Math.max(this.nextEmitterId, emitterStart);
		this.nextParticleId = Math.max(this.nextParticleId, particleStart);
	}

	/** Take these emitters out of this world, in a form another world can adopt */
	export(ids: ReadonlySet<number>): PortableEmitter[] {
		const out: PortableEmitter[] = [];
		for (const e of this.emitters) {
			if (!ids.has(e.id)) continue;
			const s = e.snapshot();
			const o = e.spawnOptions;
			const pe = o.preEffect;
			out.push({
				id: e.id,
				effect: e.def.identifier,
				parentId: e.parentId,
				options: {
					context: o.context,
					variables: o.variables,
					preEffect: typeof pe === 'string' ? pe : pe ? pe.expr.source : null,
					bound: o.bound,
					inheritVelocity: o.inheritVelocity,
					singleParticle: o.singleParticle,
					manual: o.manual,
					position: o.position,
					rotation: o.rotation,
					attached: !!o.attachment,
				},
				vars: this.snapshotVars(e.vars),
				renderBase: this.preparedVars(e),
				pool: s.pool,
				scalars: s.scalars,
				position: s.position,
				rotation: s.rotation,
			});
		}
		this.emitters = this.emitters.filter((e) => !ids.has(e.id));
		return out;
	}

	/**
	 * Adopt emitters another world exported, in their order. `resolve` finds a definition by identifier
	 * (compiled in this world); `attach` rebinds emitters that followed an attachment.
	 */
	adopt(list: PortableEmitter[], resolve: EffectResolver, attach?: (e: PortableEmitter) => Attachment | null): EmitterInstance[] {
		const added: EmitterInstance[] = [];
		for (const p of list) {
			const def = resolve(p.effect);
			if (!def) continue;
			const { attached, ...rest } = p.options;
			const spawnOptions: SpawnOptions = { ...rest, attachment: attached ? (attach?.(p) ?? null) : null, parent: null };
			const vars: Value[] = [];
			for (const [name, value] of Object.entries(p.vars)) vars[this.symbols.variable(name)] = value;
			// a structured clone arrives as a plain object: give it the pool's methods back
			const pool = Object.assign(new ParticlePool(1), p.pool);
			const e = new EmitterInstance(this, def, p.id, spawnOptions);
			e.restore({ id: p.id, def, spawnOptions, parentId: p.parentId, vars, pool, scalars: p.scalars, position: p.position, rotation: p.rotation });
			if (p.renderBase) {
				const base: Value[] = [];
				for (const [name, value] of Object.entries(p.renderBase)) base[this.symbols.variable(name)] = value;
				const b = this.renderBase;
				// this world has prepared the frame already: drawing it again starts this emitter from its base too
				if (b.frame === this.frame) b.vars.set(e, { frame: b.frame, vars: base });
				else this.adoptedBase.set(e, base);
			}
			this.emitters.push(e);
			added.push(e);
		}
		const all = new Map(this.emitters.map((e) => [e.id, e]));
		for (const e of added) e.parent = e.parentId !== null ? (all.get(e.parentId) ?? null) : null;
		return added;
	}

	/** An emitter's variables from before this frame's render preparation, by name (null when it wasn't prepared) */
	private preparedVars(e: EmitterInstance): Record<string, Value> | null {
		const b = this.renderBase;
		const saved = b.frame === this.frame ? b.vars.get(e) : undefined;
		return saved && saved.frame === b.frame ? this.snapshotVars(saved.vars) : null;
	}

	// ---- snapshots (scrubbing & stepping)

	snapshot(): WorldSnapshot {
		const b = this.renderBase;
		const prepared = b.frame === this.frame;
		return {
			time: this.time,
			frame: this.frame,
			rng: this.rng.state,
			nextParticleId: this.nextParticleId,
			nextEmitterId: this.nextEmitterId,
			temps: { v: this.temps.v.slice(), g: this.temps.g.slice(), gen: this.temps.gen },
			contexts: this.contexts.slice(),
			emitters: this.emitters.map((e) => {
				const s = e.snapshot();
				const saved = prepared ? b.vars.get(e) : undefined;
				if (saved && saved.frame === b.frame) s.renderBase = saved.vars.slice();
				return s;
			}),
			renderBase: prepared ? { rng: b.rng, temps: { v: b.tempsV.slice(), g: b.tempsG.slice(), gen: b.tempsGen } } : null,
		};
	}

	restore(s: WorldSnapshot): void {
		this.time = s.time;
		this.frame = s.frame;
		this.rng.state = s.rng;
		this.nextParticleId = s.nextParticleId;
		this.nextEmitterId = s.nextEmitterId;
		this.temps.v = s.temps.v.slice();
		this.temps.g = s.temps.g.slice();
		this.temps.gen = s.temps.gen;
		// the emitters' environments hold this array, so it's refilled rather than replaced
		this.contexts.length = 0;
		this.contexts.push(...(s.contexts ?? []));
		const b = this.renderBase;
		const rb = s.renderBase;
		// drawing the restored frame again prepares it from where its own render preparation started
		b.frame = rb ? s.frame : -1;
		if (rb) {
			b.rng = rb.rng;
			copyInto(b.tempsV, rb.temps.v);
			copyInto(b.tempsG, rb.temps.g);
			b.tempsGen = rb.temps.gen;
		}
		const byId = new Map(this.emitters.map((e) => [e.id, e]));
		this.emitters = s.emitters.map((es) => {
			const e = byId.get(es.id) ?? new EmitterInstance(this, es.def, es.id, es.spawnOptions);
			e.restore(es);
			const saved = b.vars.get(e);
			if (rb && es.renderBase) b.vars.set(e, { frame: s.frame, vars: es.renderBase.slice() });
			else if (saved) saved.frame = -1;
			return e;
		});
		// re-link parents
		const all = new Map(this.emitters.map((e) => [e.id, e]));
		for (const e of this.emitters) e.parent = e.parentId !== null ? all.get(e.parentId) ?? null : null;
	}
}

interface RenderBase {
	/** the frame recorded, -1 for none */
	frame: number;
	rng: number;
	tempsV: Value[];
	tempsG: number[];
	tempsGen: number;
	vars: WeakMap<EmitterInstance, { frame: number; vars: Value[] }>;
}

/** Overwrite `to` with `from`'s elements, reusing `to`'s storage */
function copyInto<T>(to: T[], from: readonly T[]): void {
	to.length = from.length;
	for (let i = 0; i < from.length; i++) to[i] = from[i];
}

export interface EmitterSnapshot {
	id: number;
	def: EffectDefinition;
	spawnOptions: SpawnOptions;
	parentId: number | null;
	vars: Value[];
	pool: ParticlePool;
	scalars: Record<string, unknown>;
	position: Vec3;
	rotation: Quat;
	/** its variables before the snapshot frame's render preparation, when that frame was prepared */
	renderBase?: Value[];
}

/**
 * An emitter in a form another world can adopt (another thread, for instance): its definition by
 * identifier, variables by name (each world numbers its own slots), particles as typed arrays.
 */
export interface PortableEmitter {
	id: number;
	effect: string;
	parentId: number | null;
	options: {
		context?: SpawnContext;
		variables?: Record<string, Value>;
		preEffect?: string | null;
		bound?: boolean;
		inheritVelocity?: Vec3 | null;
		singleParticle?: boolean;
		manual?: SpawnOptions['manual'];
		position?: Vec3;
		rotation?: Quat;
		/** it followed an attachment (entity locator): the adopting world rebinds it */
		attached: boolean;
	};
	vars: Record<string, Value>;
	/** its variables before the current frame's render preparation, when that frame was prepared */
	renderBase?: Record<string, Value> | null;
	pool: ParticlePool;
	scalars: Record<string, unknown>;
	position: Vec3;
	rotation: Quat;
}

export interface WorldSnapshot {
	time: number;
	frame: number;
	rng: number;
	nextParticleId: number;
	nextEmitterId: number;
	/** temps are global and persistent in-game (t05/t30), so they're part of the state */
	temps: { v: Value[]; g: number[]; gen: number };
	/** context.* values the host supplied */
	contexts?: Value[];
	emitters: EmitterSnapshot[];
	/** the random state and temps before the snapshot frame's render preparation (null when it wasn't prepared) */
	renderBase?: { rng: number; temps: { v: Value[]; g: number[]; gen: number } } | null;
}
