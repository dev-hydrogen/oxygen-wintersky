import { compile, type CompiledExpression, type Diagnostic, type SymbolTable } from 'molangjs';

/** A compiled Molang field with its JSON location (used for diagnostics, tracing and editor mapping) */
export interface MolangField {
	expr: CompiledExpression;
	/** JSON pointer-ish path, e.g. `components/minecraft:particle_appearance_billboard/size/0` */
	path: string;
	/** Raw JSON value (string, number or {expression, version}) */
	raw: unknown;
	constant: number | null;
	/** Per-expression version, when the field used `{ "expression", "version" }` */
	version: number | null;
	/**
	 * The field's Molang failed to load. In-game the whole field is dropped (statements in it never run)
	 * and it takes its default value, which `expr`/`constant` now hold. Oxygen test t03/t28.
	 */
	broken?: { message: string; expr: CompiledExpression };
}

export type Vec3Field = [MolangField, MolangField, MolangField];

export interface EffectDiagnostic extends Diagnostic {
	path: string;
}

export interface EventNode {
	sequence?: EventNode[];
	randomize?: { weight: number; node: EventNode }[];
	expression?: MolangField;
	sound?: { event: string };
	particleEffect?: { effect: string; type: 'emitter' | 'emitter_bound' | 'particle' | 'particle_with_velocity'; preEffect?: MolangField };
	path: string;
}

export interface EventTrigger {
	at: number;
	events: string[];
}

export interface CurveDefinition {
	name: string;
	slot: number;
	type: 'linear' | 'bezier' | 'catmull_rom' | 'bezier_chain';
	input: MolangField;
	/** ignored for bezier_chain (as in game) */
	range: MolangField | null;
	nodes: MolangField[];
	chain: { key: number; leftValue: MolangField; rightValue: MolangField; leftSlope: MolangField; rightSlope: MolangField }[];
	path: string;
}

export type ShapeType = 'point' | 'sphere' | 'box' | 'disc' | 'custom' | 'entity_aabb';

export interface ShapeDefinition {
	type: ShapeType;
	offset: Vec3Field | null;
	radius: MolangField | null;
	halfDimensions: Vec3Field | null;
	planeNormal: Vec3Field | null;
	surfaceOnly: boolean;
	direction: 'outwards' | 'inwards' | Vec3Field;
}

export type FacingMode =
	| 'rotate_xyz'
	| 'rotate_y'
	| 'lookat_xyz'
	| 'lookat_y'
	| 'lookat_direction'
	| 'direction_x'
	| 'direction_y'
	| 'direction_z'
	| 'emitter_transform_xy'
	| 'emitter_transform_xz'
	| 'emitter_transform_yz';

export const FACING_MODES: FacingMode[] = [
	'rotate_xyz',
	'rotate_y',
	'lookat_xyz',
	'lookat_y',
	'lookat_direction',
	'direction_x',
	'direction_y',
	'direction_z',
	'emitter_transform_xy',
	'emitter_transform_xz',
	'emitter_transform_yz',
];

export interface BillboardDefinition {
	size: [MolangField, MolangField];
	facing: FacingMode;
	direction: { mode: 'derive_from_velocity'; minSpeed: number } | { mode: 'custom'; custom: Vec3Field | null };
	uv:
		| null
		| {
				textureWidth: number;
				textureHeight: number;
				uv: [MolangField, MolangField] | null;
				uvSize: [MolangField, MolangField] | null;
				flipbook: null | {
					base: [MolangField, MolangField];
					size: [number, number];
					step: [number, number];
					fps: number;
					maxFrame: MolangField;
					stretchToLifetime: boolean;
					loop: boolean;
				};
		  };
}

export type ColorFields = [MolangField, MolangField, MolangField, MolangField];

export type TintDefinition =
	| { type: 'color'; color: ColorFields }
	| { type: 'gradient'; interpolant: MolangField; stops: { key: number; color: ColorFields }[] };

export interface EffectDefinition {
	identifier: string;
	formatVersion: string;
	material: string;
	texture: string;
	curves: CurveDefinition[];
	events: Map<string, EventNode>;
	emitter: {
		creation: MolangField | null;
		perUpdate: MolangField | null;
		localSpace: { position: boolean; rotation: boolean; velocity: boolean };
		rate:
			| { type: 'instant'; numParticles: MolangField }
			| { type: 'steady'; spawnRate: MolangField; maxParticles: MolangField }
			| { type: 'manual'; maxParticles: MolangField }
			| null;
		lifetime:
			| { type: 'once'; activeTime: MolangField }
			| { type: 'looping'; activeTime: MolangField; sleepTime: MolangField }
			| { type: 'expression'; activation: MolangField; expiration: MolangField }
			| null;
		events: {
			creation: string[];
			expiration: string[];
			timeline: EventTrigger[];
			travelDistance: EventTrigger[];
			loopingTravelDistance: EventTrigger[];
		};
		shape: ShapeDefinition | null;
	};
	particle: {
		perUpdate: MolangField | null;
		perRender: MolangField | null;
		initialSpeed: MolangField | Vec3Field | null;
		initialRotation: MolangField | null;
		initialRotationRate: MolangField | null;
		dynamic: null | {
			linearAcceleration: Vec3Field | null;
			linearDrag: MolangField | null;
			rotationAcceleration: MolangField | null;
			rotationDrag: MolangField | null;
		};
		parametric: null | { relativePosition: Vec3Field | null; direction: Vec3Field | null; rotation: MolangField | null };
		collision: null | {
			enabled: MolangField | null;
			drag: number;
			restitution: number;
			radius: number;
			expireOnContact: boolean;
			events: { event: string; minSpeed: number }[];
		};
		/** undefined field = component missing or max_lifetime missing */
		maxLifetime: MolangField | null;
		hasLifetimeComponent: boolean;
		expiration: MolangField | null;
		events: { creation: string[]; expiration: string[]; timeline: EventTrigger[] };
		killPlane: [number, number, number, number] | null;
		expireInBlocks: string[] | null;
		expireNotInBlocks: string[] | null;
		billboard: BillboardDefinition | null;
		tint: TintDefinition | null;
		lighting: boolean;
	};
	/** components present in the file but not understood */
	unknownComponents: string[];
	diagnostics: EffectDiagnostic[];
	/**
	 * Set when the game could not register the effect at all (not a particle effect, no identifier).
	 * Molang errors do NOT fail an effect: the broken field falls back to its default (see MolangField.broken).
	 */
	failed: { reason: string; path: string } | null;
}

export interface DefinitionOptions {
	symbols: SymbolTable;
	/** The pack's min_engine_version: selects the Molang rules for plain-string expressions. */
	engine?: string | readonly number[] | null;
	f32?: boolean;
	/**
	 * Query registry for particle Molang. Unknown queries are load errors in-game (the field is dropped),
	 * so pass the game's list here. Omit to accept every query.
	 */
	queryExists?: (name: string) => boolean;
}

const KNOWN_COMPONENTS = new Set([
	'minecraft:emitter_initialization',
	'minecraft:emitter_local_space',
	'minecraft:emitter_rate_instant',
	'minecraft:emitter_rate_steady',
	'minecraft:emitter_rate_manual',
	'minecraft:emitter_lifetime_looping',
	'minecraft:emitter_lifetime_once',
	'minecraft:emitter_lifetime_expression',
	'minecraft:emitter_lifetime_events',
	'minecraft:emitter_shape_point',
	'minecraft:emitter_shape_sphere',
	'minecraft:emitter_shape_box',
	'minecraft:emitter_shape_custom',
	'minecraft:emitter_shape_entity_aabb',
	'minecraft:emitter_shape_disc',
	'minecraft:particle_initial_speed',
	'minecraft:particle_initial_spin',
	'minecraft:particle_initialization',
	'minecraft:particle_motion_dynamic',
	'minecraft:particle_motion_parametric',
	'minecraft:particle_motion_collision',
	'minecraft:particle_appearance_billboard',
	'minecraft:particle_appearance_tinting',
	'minecraft:particle_appearance_lighting',
	'minecraft:particle_lifetime_expression',
	'minecraft:particle_lifetime_events',
	'minecraft:particle_expire_if_in_blocks',
	'minecraft:particle_expire_if_not_in_blocks',
	'minecraft:particle_kill_plane',
]);

export const BUILTIN_VARIABLES = [
	'variable.emitter_age',
	'variable.emitter_lifetime',
	'variable.emitter_random_1',
	'variable.emitter_random_2',
	'variable.emitter_random_3',
	'variable.emitter_random_4',
	'variable.particle_age',
	'variable.particle_lifetime',
	'variable.particle_random_1',
	'variable.particle_random_2',
	'variable.particle_random_3',
	'variable.particle_random_4',
] as const;

class Reader {
	diagnostics: EffectDiagnostic[] = [];
	failed: EffectDefinition['failed'] = null;
	constructor(private o: DefinitionOptions) {}

	diag(path: string, severity: Diagnostic['severity'], code: string, message: string) {
		this.diagnostics.push({ severity, code, message, path, start: 0, end: 0 });
	}

	private constantField(value: number, path: string, raw: unknown, version: number | null): MolangField {
		const expr = compile(value, { symbols: this.o.symbols, f32: this.o.f32 !== false });
		return { expr, path, raw, constant: expr.constant, version };
	}

	/**
	 * Compile a Molang field. `fallback` is the field's default, used when the value has the wrong type or
	 * fails to load (the game drops the field and keeps its default; statements in it never run).
	 * `fallback: null` means a broken field behaves as if the key were absent.
	 */
	molang(raw: unknown, path: string, fallback: number | null = 0): MolangField | null {
		if (raw === undefined || raw === null) return null;
		let source: string | number;
		let version: number | null = null;
		if (typeof raw === 'number') source = raw;
		else if (typeof raw === 'boolean') source = raw ? 1 : 0;
		else if (typeof raw === 'string') source = raw;
		else if (typeof raw === 'object' && raw && typeof (raw as any).expression === 'string') {
			source = (raw as any).expression;
			if (typeof (raw as any).version === 'number') version = (raw as any).version;
		} else {
			this.diag(path, 'error', 'type', `Expected a number or Molang expression`);
			return fallback === null ? null : this.constantField(fallback, path, raw, null);
		}
		const expr = compile(source, {
			symbols: this.o.symbols,
			version,
			engine: this.o.engine ?? null,
			f32: this.o.f32 !== false,
			context: 'particle',
			queryExists: this.o.queryExists,
		});
		for (const d of expr.diagnostics) this.diagnostics.push({ ...d, path });
		if (!expr.ok) {
			const message = expr.diagnostics.find((d) => d.severity === 'error')?.message ?? 'Molang error';
			if (fallback === null) return null;
			const field = this.constantField(fallback, path, raw, version);
			field.broken = { message, expr };
			return field;
		}
		return { expr, path, raw, constant: expr.constant, version };
	}

	vec(raw: unknown, n: number, path: string, fallback = 0): MolangField[] | null {
		if (raw === undefined || raw === null) return null;
		if (!Array.isArray(raw) || raw.length !== n) {
			this.diag(path, 'error', 'type', `Expected an array of ${n} values`);
			return Array.from({ length: n }, (_, i) => this.constantField(fallback, `${path}/${i}`, undefined, null));
		}
		return raw.map((v, i) => this.molang(v, `${path}/${i}`, fallback) ?? this.constantField(fallback, `${path}/${i}`, v, null));
	}

	num(raw: unknown, path: string, fallback: number): number {
		if (raw === undefined || raw === null) return fallback;
		if (typeof raw === 'number') return raw;
		if (typeof raw === 'string' && raw.trim() !== '' && !isNaN(Number(raw))) return Number(raw);
		this.diag(path, 'error', 'type', 'Expected a number (Molang is not allowed here)');
		return fallback;
	}

	bool(raw: unknown, fallback: boolean): boolean {
		return typeof raw === 'boolean' ? raw : raw === undefined ? fallback : !!raw;
	}

	eventList(raw: unknown): string[] {
		if (typeof raw === 'string') return [raw];
		if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
		return [];
	}

	timeline(raw: unknown): EventTrigger[] {
		if (!raw || typeof raw !== 'object') return [];
		if (Array.isArray(raw)) {
			// looping_travel_distance_events: [{distance, effects}]
			return raw
				.filter((e) => e && typeof e === 'object')
				.map((e: any) => ({ at: Number(e.distance) || 0, events: this.eventList(e.effects) }));
		}
		return Object.entries(raw as Record<string, unknown>)
			.map(([k, v]) => ({ at: parseFloat(k), events: this.eventList(v) }))
			.filter((e) => !isNaN(e.at))
			.sort((a, b) => a.at - b.at);
	}

	fail(reason: string, path: string) {
		if (!this.failed) this.failed = { reason, path };
	}

	event(raw: any, path: string): EventNode {
		const node: EventNode = { path };
		if (!raw || typeof raw !== 'object') return node;
		if (Array.isArray(raw.sequence)) node.sequence = raw.sequence.map((s: any, i: number) => this.event(s, `${path}/sequence/${i}`));
		if (Array.isArray(raw.randomize)) {
			node.randomize = [];
			raw.randomize.forEach((r: any, i: number) => {
				const weight = Number(r?.weight) || 0;
				// the game drops these when it loads the effect: "Weight field must be zero or greater" (t48)
				if (weight < 0) return this.diag(`${path}/randomize/${i}/weight`, 'warning', 'negative-weight', 'A negative weight: the game ignores this option (and logs an error)');
				node.randomize!.push({ weight, node: this.event(r, `${path}/randomize/${i}`) });
			});
		}
		if (raw.expression !== undefined) node.expression = this.molang(raw.expression, `${path}/expression`) ?? undefined;
		if (raw.sound_effect && typeof raw.sound_effect === 'object') node.sound = { event: String(raw.sound_effect.event_name ?? '') };
		if (raw.particle_effect && typeof raw.particle_effect === 'object') {
			const pe = raw.particle_effect;
			const type = ['emitter', 'emitter_bound', 'particle', 'particle_with_velocity'].includes(pe.type) ? pe.type : 'emitter';
			node.particleEffect = {
				effect: String(pe.effect ?? ''),
				type,
				preEffect: pe.pre_effect_expression !== undefined ? this.molang(pe.pre_effect_expression, `${path}/particle_effect/pre_effect_expression`) ?? undefined : undefined,
			};
		}
		return node;
	}

	colorFields(raw: unknown, path: string): ColorFields | null {
		if (typeof raw === 'string') {
			const rgba = parseHexColor(raw);
			if (!rgba) {
				this.diag(path, 'error', 'color', `Invalid color '${raw}' (expected #RRGGBB or #AARRGGBB)`);
				return null;
			}
			return rgba.map((c, i) => this.molang(c, `${path}#${i}`, 1)!) as ColorFields;
		}
		if (Array.isArray(raw) && (raw.length === 3 || raw.length === 4)) {
			const arr = raw.length === 3 ? [...raw, 1] : raw;
			return arr.map((c, i) => this.molang(c, `${path}/${i}`, 1) ?? this.molang(1, `${path}/${i}`, 1)!) as ColorFields;
		}
		this.diag(path, 'error', 'color', 'Expected a color (hex string or [r, g, b, a])');
		return null;
	}
}

/** Parse Bedrock hex colors: "#RRGGBB" or "#AARRGGBB" (alpha FIRST, unlike CSS) → [r,g,b,a] in 0–1 */
export function parseHexColor(hex: string): [number, number, number, number] | null {
	const h = hex.trim().replace(/^#/, '');
	if (!/^[0-9a-fA-F]+$/.test(h)) return null;
	if (h.length === 6) return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, 1];
	if (h.length === 8) {
		return [parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, parseInt(h.slice(6, 8), 16) / 255, parseInt(h.slice(0, 2), 16) / 255];
	}
	return null;
}

/**
 * Turn particle JSON into a compiled, validated definition. Never throws: problems are collected
 * as diagnostics, and `failed` is set where Bedrock would refuse the whole effect.
 */
export function readEffect(json: unknown, options: DefinitionOptions): EffectDefinition {
	const r = new Reader(options);
	const root = (json && typeof json === 'object' ? json : {}) as any;
	const pe = root.particle_effect ?? {};
	const desc = pe.description ?? {};
	const brp = desc.basic_render_parameters ?? {};
	const comps: Record<string, any> = pe.components && typeof pe.components === 'object' ? pe.components : {};
	const C = (name: string) => comps[`minecraft:${name}`];
	const P = (name: string, field?: string) => `particle_effect/components/minecraft:${name}${field ? '/' + field : ''}`;

	if (!root.particle_effect) r.fail('Missing particle_effect', 'particle_effect');
	if (!desc.identifier) {
		r.diag('particle_effect/description/identifier', 'error', 'required', 'The effect needs an identifier');
		r.fail('No identifier: the game cannot register this effect', 'particle_effect/description/identifier');
	}

	// curves
	const curves: CurveDefinition[] = [];
	if (pe.curves && typeof pe.curves === 'object') {
		for (const [name, c] of Object.entries<any>(pe.curves)) {
			const path = `particle_effect/curves/${name}`;
			const full = name.toLowerCase().replace(/^v\./, 'variable.');
			if (!full.startsWith('variable.')) r.diag(path, 'error', 'curve-name', 'Curve names must begin with "variable."');
			const type = ['linear', 'bezier', 'catmull_rom', 'bezier_chain'].includes(c?.type) ? c.type : 'linear';
			const def: CurveDefinition = {
				name: full,
				slot: options.symbols.variable(full),
				type,
				input: r.molang(c?.input ?? 0, `${path}/input`)!,
				range: type === 'bezier_chain' ? null : r.molang(c?.horizontal_range ?? 1, `${path}/horizontal_range`, 1),
				nodes: [],
				chain: [],
				path,
			};
			if (type === 'bezier_chain') {
				if (c?.nodes && typeof c.nodes === 'object' && !Array.isArray(c.nodes)) {
					for (const [key, node] of Object.entries<any>(c.nodes)) {
						const np = `${path}/nodes/${key}`;
						const value = node?.value;
						def.chain.push({
							key: parseFloat(key),
							leftValue: r.molang(node?.left_value ?? value ?? 0, `${np}/left_value`)!,
							rightValue: r.molang(node?.right_value ?? value ?? 0, `${np}/right_value`)!,
							leftSlope: r.molang(node?.left_slope ?? node?.slope ?? 0, `${np}/left_slope`)!,
							rightSlope: r.molang(node?.right_slope ?? node?.slope ?? 0, `${np}/right_slope`)!,
						});
					}
					def.chain.sort((a, b) => a.key - b.key); // "nodes will be sorted prior to parsing"
				}
			} else if (Array.isArray(c?.nodes)) {
				def.nodes = c.nodes.map((n: unknown, i: number) => r.molang(n, `${path}/nodes/${i}`) ?? r.molang(0, `${path}/nodes/${i}`)!);
			}
			if (type === 'bezier' && def.nodes.length !== 4) r.diag(`${path}/nodes`, 'warning', 'curve-nodes', 'Bezier curves use exactly 4 nodes');
			if (type === 'catmull_rom' && def.nodes.length < 4) r.diag(`${path}/nodes`, 'warning', 'curve-nodes', 'Catmull-Rom curves need at least 4 nodes');
			curves.push(def);
		}
	}

	// events
	const events = new Map<string, EventNode>();
	if (pe.events && typeof pe.events === 'object') {
		for (const [name, ev] of Object.entries<any>(pe.events)) events.set(name, r.event(ev, `particle_effect/events/${name}`));
	}

	const unknownComponents = Object.keys(comps).filter((k) => !KNOWN_COMPONENTS.has(k));
	for (const k of unknownComponents) r.diag(`particle_effect/components/${k}`, 'warning', 'unknown-component', `Unknown component '${k}'`);

	// emitter
	const init = C('emitter_initialization');
	const ls = C('emitter_local_space');
	let localSpace = { position: !!ls?.position, rotation: !!ls?.rotation, velocity: !!ls?.velocity };
	if (localSpace.rotation && !localSpace.position) {
		// the game rejects the component and the effect runs in world space (e13)
		r.diag(P('emitter_local_space', 'rotation'), 'error', 'local-space', 'We do not support rotation being true and position being false. The game ignores this component, so the effect runs in world space');
		localSpace = { position: false, rotation: false, velocity: false };
	}

	let rate: EffectDefinition['emitter']['rate'] = null;
	if (C('emitter_rate_instant')) rate = { type: 'instant', numParticles: r.molang(C('emitter_rate_instant').num_particles ?? 10, P('emitter_rate_instant', 'num_particles'), 10)! };
	else if (C('emitter_rate_steady')) {
		const s = C('emitter_rate_steady');
		rate = {
			type: 'steady',
			spawnRate: r.molang(s.spawn_rate ?? 1, P('emitter_rate_steady', 'spawn_rate'), 1)!,
			maxParticles: r.molang(s.max_particles ?? 50, P('emitter_rate_steady', 'max_particles'), 50)!,
		};
	} else if (C('emitter_rate_manual')) rate = { type: 'manual', maxParticles: r.molang(C('emitter_rate_manual').max_particles ?? 50, P('emitter_rate_manual', 'max_particles'), 50)! };

	let lifetime: EffectDefinition['emitter']['lifetime'] = null;
	if (C('emitter_lifetime_once')) lifetime = { type: 'once', activeTime: r.molang(C('emitter_lifetime_once').active_time ?? 10, P('emitter_lifetime_once', 'active_time'), 10)! };
	else if (C('emitter_lifetime_looping')) {
		const l = C('emitter_lifetime_looping');
		lifetime = {
			type: 'looping',
			activeTime: r.molang(l.active_time ?? 10, P('emitter_lifetime_looping', 'active_time'), 10)!,
			sleepTime: r.molang(l.sleep_time ?? 0, P('emitter_lifetime_looping', 'sleep_time'))!,
		};
	} else if (C('emitter_lifetime_expression')) {
		const l = C('emitter_lifetime_expression');
		lifetime = {
			type: 'expression',
			activation: r.molang(l.activation_expression ?? 1, P('emitter_lifetime_expression', 'activation_expression'), 1)!,
			expiration: r.molang(l.expiration_expression ?? 0, P('emitter_lifetime_expression', 'expiration_expression'))!,
		};
	}

	const le = C('emitter_lifetime_events') ?? {};
	const shape = readShape(r, C, P);

	// particle
	const pinit = C('particle_initialization');
	const speedRaw = C('particle_initial_speed');
	let initialSpeed: MolangField | Vec3Field | null = null;
	if (Array.isArray(speedRaw)) initialSpeed = r.vec(speedRaw, 3, P('particle_initial_speed')) as Vec3Field;
	else if (speedRaw !== undefined) initialSpeed = r.molang(speedRaw, P('particle_initial_speed'));
	const spin = C('particle_initial_spin');
	const dyn = C('particle_motion_dynamic');
	const par = C('particle_motion_parametric');
	const col = C('particle_motion_collision');
	const lifeExpr = C('particle_lifetime_expression');
	const ple = C('particle_lifetime_events') ?? {};
	const kp = C('particle_kill_plane');

	const collision: EffectDefinition['particle']['collision'] = col
		? {
				enabled: col.enabled === undefined ? null : r.molang(col.enabled, P('particle_motion_collision', 'enabled'), 1),
				drag: r.num(col.collision_drag, P('particle_motion_collision', 'collision_drag'), 0),
				restitution: r.num(col.coefficient_of_restitution, P('particle_motion_collision', 'coefficient_of_restitution'), 0),
				radius: r.num(col.collision_radius, P('particle_motion_collision', 'collision_radius'), 0),
				expireOnContact: r.bool(col.expire_on_contact, false),
				events: (Array.isArray(col.events) ? col.events : col.events ? [col.events] : [])
					.filter((e: any) => e && typeof e === 'object')
					.map((e: any) => ({ event: String(e.event ?? ''), minSpeed: Math.max(2, Number(e.min_speed) || 2) })),
			}
		: null;
	if (collision && collision.radius > 0.5) r.diag(P('particle_motion_collision', 'collision_radius'), 'warning', 'collision-radius', 'collision_radius must be at most 0.5 blocks');

	const effect: EffectDefinition = {
		identifier: String(desc.identifier ?? ''),
		formatVersion: String(root.format_version ?? ''),
		material: String(brp.material ?? 'particles_alpha'),
		texture: String(brp.texture ?? ''),
		curves,
		events,
		emitter: {
			creation: init ? r.molang(init.creation_expression, P('emitter_initialization', 'creation_expression')) : null,
			perUpdate: init ? r.molang(init.per_update_expression, P('emitter_initialization', 'per_update_expression')) : null,
			localSpace,
			rate,
			lifetime,
			events: {
				creation: r.eventList(le.creation_event),
				expiration: r.eventList(le.expiration_event),
				timeline: r.timeline(le.timeline),
				travelDistance: r.timeline(le.travel_distance_events),
				loopingTravelDistance: r.timeline(le.looping_travel_distance_events),
			},
			shape,
		},
		particle: {
			perUpdate: pinit ? r.molang(pinit.per_update_expression, P('particle_initialization', 'per_update_expression')) : null,
			perRender: pinit ? r.molang(pinit.per_render_expression, P('particle_initialization', 'per_render_expression')) : null,
			initialSpeed,
			initialRotation: spin ? r.molang(spin.rotation ?? 0, P('particle_initial_spin', 'rotation')) : null,
			initialRotationRate: spin ? r.molang(spin.rotation_rate ?? 0, P('particle_initial_spin', 'rotation_rate')) : null,
			dynamic: dyn
				? {
						linearAcceleration: r.vec(dyn.linear_acceleration, 3, P('particle_motion_dynamic', 'linear_acceleration')) as Vec3Field | null,
						linearDrag: r.molang(dyn.linear_drag_coefficient, P('particle_motion_dynamic', 'linear_drag_coefficient')),
						rotationAcceleration: r.molang(dyn.rotation_acceleration, P('particle_motion_dynamic', 'rotation_acceleration')),
						rotationDrag: r.molang(dyn.rotation_drag_coefficient, P('particle_motion_dynamic', 'rotation_drag_coefficient')),
					}
				: null,
			parametric: par
				? {
						relativePosition: r.vec(par.relative_position, 3, P('particle_motion_parametric', 'relative_position')) as Vec3Field | null,
						direction: r.vec(par.direction, 3, P('particle_motion_parametric', 'direction')) as Vec3Field | null,
						rotation: r.molang(par.rotation, P('particle_motion_parametric', 'rotation')),
					}
				: null,
			collision,
			maxLifetime: lifeExpr ? r.molang(lifeExpr.max_lifetime, P('particle_lifetime_expression', 'max_lifetime'), null) : null,
			hasLifetimeComponent: !!lifeExpr,
			expiration: lifeExpr ? r.molang(lifeExpr.expiration_expression, P('particle_lifetime_expression', 'expiration_expression'), null) : null,
			events: { creation: r.eventList(ple.creation_event), expiration: r.eventList(ple.expiration_event), timeline: r.timeline(ple.timeline) },
			killPlane: Array.isArray(kp) && kp.length === 4 ? (kp.map((v: unknown, i: number) => r.num(v, `${P('particle_kill_plane')}/${i}`, 0)) as [number, number, number, number]) : null,
			expireInBlocks: Array.isArray(C('particle_expire_if_in_blocks')) ? C('particle_expire_if_in_blocks').map(String) : null,
			expireNotInBlocks: Array.isArray(C('particle_expire_if_not_in_blocks')) ? C('particle_expire_if_not_in_blocks').map(String) : null,
			billboard: readBillboard(r, C('particle_appearance_billboard'), P),
			tint: readTint(r, C('particle_appearance_tinting'), P),
			lighting: C('particle_appearance_lighting') !== undefined,
		},
		unknownComponents,
		diagnostics: r.diagnostics,
		failed: r.failed,
	};

	// event references
	const checkRefs = (names: string[], path: string) => {
		for (const n of names) if (!events.has(n)) r.diag(path, 'warning', 'unknown-event', `Event '${n}' is not defined in this effect`);
	};
	checkRefs(effect.emitter.events.creation, P('emitter_lifetime_events', 'creation_event'));
	checkRefs(effect.emitter.events.expiration, P('emitter_lifetime_events', 'expiration_event'));
	checkRefs(effect.particle.events.creation, P('particle_lifetime_events', 'creation_event'));
	checkRefs(effect.particle.events.expiration, P('particle_lifetime_events', 'expiration_event'));
	if (!rate) r.diag('particle_effect/components', 'warning', 'no-rate', 'No emitter rate component — nothing will spawn');
	if (!effect.particle.billboard) r.diag('particle_effect/components', 'warning', 'no-billboard', 'No billboard component — particles are invisible');
	return effect;
}

function readShape(r: Reader, C: (n: string) => any, P: (n: string, f?: string) => string): ShapeDefinition | null {
	const types: [string, ShapeType][] = [
		['emitter_shape_point', 'point'],
		['emitter_shape_sphere', 'sphere'],
		['emitter_shape_box', 'box'],
		['emitter_shape_disc', 'disc'],
		['emitter_shape_custom', 'custom'],
		['emitter_shape_entity_aabb', 'entity_aabb'],
	];
	for (const [name, type] of types) {
		const s = C(name);
		if (!s) continue;
		const dirRaw = s.direction;
		let direction: ShapeDefinition['direction'] = type === 'point' || type === 'custom' ? (r.vec([0, 0, 0], 3, P(name, 'direction')) as Vec3Field) : 'outwards';
		if (dirRaw === 'inwards' || dirRaw === 'outwards') direction = dirRaw;
		else if (Array.isArray(dirRaw)) direction = (r.vec(dirRaw, 3, P(name, 'direction')) as Vec3Field) ?? direction;
		let planeNormal: Vec3Field | null = null;
		if (type === 'disc') {
			const pn = s.plane_normal;
			if (pn === 'x') planeNormal = r.vec([1, 0, 0], 3, P(name, 'plane_normal')) as Vec3Field;
			else if (pn === 'y' || pn === undefined) planeNormal = r.vec([0, 1, 0], 3, P(name, 'plane_normal')) as Vec3Field;
			else if (pn === 'z') planeNormal = r.vec([0, 0, 1], 3, P(name, 'plane_normal')) as Vec3Field;
			else planeNormal = r.vec(pn, 3, P(name, 'plane_normal')) as Vec3Field;
		}
		return {
			type,
			offset: type === 'entity_aabb' ? null : ((r.vec(s.offset ?? [0, 0, 0], 3, P(name, 'offset')) as Vec3Field) ?? null),
			radius: type === 'sphere' || type === 'disc' ? r.molang(s.radius ?? 1, P(name, 'radius'), 1) : null,
			halfDimensions: type === 'box' ? ((r.vec(s.half_dimensions ?? [0, 0, 0], 3, P(name, 'half_dimensions')) as Vec3Field) ?? null) : null,
			planeNormal,
			surfaceOnly: !!s.surface_only,
			direction,
		};
	}
	return null;
}

function readBillboard(r: Reader, b: any, P: (n: string, f?: string) => string): BillboardDefinition | null {
	if (!b) return null;
	const name = 'particle_appearance_billboard';
	// A broken size falls back to 1 x 1 in-game (t28); a missing size is assumed to do the same (t44).
	let size = r.vec(b.size, 2, P(name, 'size'), 1) as [MolangField, MolangField] | null;
	if (!size) {
		r.diag(P(name, 'size'), 'warning', 'required', 'Billboard size is missing, so it uses the default 1 × 1');
		size = r.vec([1, 1], 2, P(name, 'size'), 1) as [MolangField, MolangField];
	}
	let facing = b.facing_camera_mode as FacingMode;
	if (!(FACING_MODES as string[]).includes(facing)) {
		r.diag(P(name, 'facing_camera_mode'), 'error', 'facing', `Unknown facing_camera_mode '${facing}'`);
		facing = 'rotate_xyz';
	}
	let direction: BillboardDefinition['direction'] = { mode: 'derive_from_velocity', minSpeed: 0.01 };
	if (b.direction && typeof b.direction === 'object') {
		if (b.direction.mode === 'custom') direction = { mode: 'custom', custom: r.vec(b.direction.custom_direction ?? [0, 0, 0], 3, P(name, 'direction/custom_direction')) as Vec3Field | null };
		else {
			if (b.direction.mode !== undefined && b.direction.mode !== 'derive_from_velocity') {
				r.diag(P(name, 'direction/mode'), 'error', 'direction-mode', `Unknown direction mode '${b.direction.mode}' (expected derive_from_velocity or custom)`);
			}
			direction = { mode: 'derive_from_velocity', minSpeed: r.num(b.direction.min_speed_threshold, P(name, 'direction/min_speed_threshold'), 0.01) };
		}
	}
	let uv: BillboardDefinition['uv'] = null;
	if (b.uv && typeof b.uv === 'object') {
		const u = b.uv;
		const fb = u.flipbook;
		uv = {
			textureWidth: r.num(u.texture_width, P(name, 'uv/texture_width'), 1),
			textureHeight: r.num(u.texture_height, P(name, 'uv/texture_height'), 1),
			uv: r.vec(u.uv, 2, P(name, 'uv/uv')) as [MolangField, MolangField] | null,
			uvSize: r.vec(u.uv_size, 2, P(name, 'uv/uv_size')) as [MolangField, MolangField] | null,
			flipbook:
				fb && typeof fb === 'object'
					? {
							base: (r.vec(fb.base_UV ?? [0, 0], 2, P(name, 'uv/flipbook/base_UV')) as [MolangField, MolangField]) ?? (r.vec([0, 0], 2, '') as [MolangField, MolangField]),
							size: [r.num(fb.size_UV?.[0], P(name, 'uv/flipbook/size_UV/0'), 0), r.num(fb.size_UV?.[1], P(name, 'uv/flipbook/size_UV/1'), 0)],
							step: [r.num(fb.step_UV?.[0], P(name, 'uv/flipbook/step_UV/0'), 0), r.num(fb.step_UV?.[1], P(name, 'uv/flipbook/step_UV/1'), 0)],
							fps: r.num(fb.frames_per_second, P(name, 'uv/flipbook/frames_per_second'), 0),
							maxFrame: r.molang(fb.max_frame ?? 1, P(name, 'uv/flipbook/max_frame'), 1)!,
							stretchToLifetime: !!fb.stretch_to_lifetime,
							loop: !!fb.loop,
						}
					: null,
		};
	}
	return { size, facing, direction, uv };
}

function readTint(r: Reader, t: any, P: (n: string, f?: string) => string): TintDefinition | null {
	if (!t) return null;
	const name = 'particle_appearance_tinting';
	const c = t.color;
	if (c && typeof c === 'object' && !Array.isArray(c) && (c.gradient !== undefined || c.interpolant !== undefined)) {
		const stops: { key: number; color: ColorFields }[] = [];
		if (Array.isArray(c.gradient)) {
			const n = c.gradient.length;
			c.gradient.forEach((col: unknown, i: number) => {
				const color = r.colorFields(col, `${P(name, 'color/gradient')}/${i}`);
				if (color) stops.push({ key: n > 1 ? i / (n - 1) : 0, color });
			});
		} else if (c.gradient && typeof c.gradient === 'object') {
			for (const [k, col] of Object.entries(c.gradient)) {
				const color = r.colorFields(col, `${P(name, 'color/gradient')}/${k}`);
				if (color) stops.push({ key: parseFloat(k), color });
			}
		}
		stops.sort((a, b) => a.key - b.key);
		return { type: 'gradient', interpolant: r.molang(c.interpolant ?? 0, P(name, 'color/interpolant'))!, stops };
	}
	const color = r.colorFields(c ?? [1, 1, 1, 1], P(name, 'color'));
	return color ? { type: 'color', color } : null;
}
