import * as THREE from 'three';
import type { EffectDefinition } from '../definition';
import type { ParticleWorld } from '../world';
import type { Quat, Vec3 } from '../vec';

/**
 * What the renderer needs from an emitter. A live EmitterInstance is one; so is a stand-in whose arrays
 * were filled by a simulation running elsewhere (a worker).
 */
export interface RenderableEmitter {
	readonly def: EffectDefinition;
	readonly pool: {
		readonly count: number;
		readonly capacity: number;
		readonly pos: Float32Array;
		readonly size: Float32Array;
		readonly rot: Float32Array;
		readonly facing: Float32Array;
		readonly uv: Float32Array;
		readonly color: Uint8Array;
		readonly visible: Uint8Array;
		readonly local: Uint8Array;
	};
	readonly culled: boolean;
	readonly localSpace: boolean;
	readonly position: Vec3;
	readonly rotation: Quat;
	particleWorldPos(i: number, out: Vec3): Vec3;
}
import { FACING_ID, MATERIAL_ID, fragmentShader, pickFragmentShader, vertexShader } from './shaders';

export { FACING_ID, MATERIAL_ID } from './shaders';

export type TextureProvider = (path: string, emitter: RenderableEmitter) => THREE.Texture | null;

export interface LightingSettings {
	/** 0–15 */
	skyLight: number;
	/** 0–15 */
	blockLight: number;
	/** 0 = sunrise … 0.25 noon … 0.5 sunset … 0.75 midnight (Bedrock time-of-day fraction) */
	timeOfDay: number;
}

/** Vibrant Visuals approximation inputs (null = classic rendering) */
export interface VibrantSettings {
	/**
	 * Light on every particle, lit or not: in-game the two look the same under Vibrant Visuals (t65). Linear,
	 * pre-exposed, before tone mapping.
	 */
	light: [number, number, number];
	/** Added in front of non-additive particles (atmospheric in-scattering), linear */
	haze: [number, number, number];
	/** Additive particles are lit this much brighter (measured: about 2.85, t65) */
	additive: number;
	/** strength of MERS emissive */
	emissive: number;
	/**
	 * Response to the MERS emissive channel: emissive light grows as channel^gamma. The game's grows faster than
	 * linear at low values (an emissive of 8/255 already glows), so this is below 1. Default 1.
	 */
	emissiveGamma?: number;
	/** emissive desaturation from lighting/global.json */
	desaturation: number;
}

export interface RendererOptions {
	textures: TextureProvider;
	/** MERS texture (texture set) for an emitter's texture, used by the Vibrant Visuals approximation */
	mers?: TextureProvider;
	/** Draw blended particles back-to-front per emitter like the game (t24). Default true. */
	sortBlended?: boolean;
	alphaCutoff?: number;
	/** Fallback up axis for direction_* modes when the direction is vertical */
	fallbackUp?: [number, number, number];
}

const missingTexture = (() => {
	const data = new Uint8Array([255, 0, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 0, 255, 255]);
	const t = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat);
	t.magFilter = THREE.NearestFilter;
	t.minFilter = THREE.NearestFilter;
	t.needsUpdate = true;
	return t;
})();

/** Approximate Bedrock classic lightmap: brightness for (block, sky × daylight) light levels */
export function classicLightFactor(l: LightingSettings): number {
	// daylight: full at noon, dim at night (moon)
	const t = l.timeOfDay;
	const sun = Math.cos((t - 0.25) * Math.PI * 2) * 0.5 + 0.5; // 1 at noon, 0 at midnight
	const daylight = 0.2 + 0.8 * Math.min(1, Math.max(0, sun * 1.6 - 0.15));
	const sky = (l.skyLight / 15) * daylight;
	const block = l.blockLight / 15;
	const level = Math.max(sky, block);
	// Minecraft's light curve: brightness = level / (4 - 3 * level), with a small ambient floor
	const curve = level / (4 - 3 * level);
	return 0.05 + 0.95 * curve;
}

type RenderArrays = {
	pos: Float32Array;
	size: Float32Array;
	rot: Float32Array;
	facing: Float32Array;
	uv: Float32Array;
	color: Uint8Array;
	visible: Uint8Array;
};

const STRIDES: Record<keyof RenderArrays, number> = { pos: 3, size: 2, rot: 1, facing: 3, uv: 4, color: 4, visible: 1 };
const sortTmp: [number, number, number] = [0, 0, 0];

/** 0, 1, 2, … shared by every batch (draw order, for picking); grows, never changes otherwise */
let drawIndex = new Float32Array(0);
function drawIndices(n: number): Float32Array {
	if (drawIndex.length < n) {
		let cap = Math.max(1024, drawIndex.length);
		while (cap < n) cap *= 2;
		drawIndex = new Float32Array(cap);
		for (let i = 0; i < cap; i++) drawIndex[i] = i;
	}
	return drawIndex;
}

/** A particle found by picking: the emitter that simulates it and its index in that emitter's pool */
export interface PickedParticle {
	emitter: RenderableEmitter;
	index: number;
}

class Batch {
	readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.RawShaderMaterial>;
	readonly material: THREE.RawShaderMaterial;
	/** sorted copies of the render arrays (blend material); simulation order is never touched */
	private staging: RenderArrays | null = null;
	private order = new Uint32Array(0);
	private keys = new Float32Array(0);
	/** the last sync drew the sorted copy (draw index → pool index through `order`) */
	private drewSorted = false;
	private pickMat: THREE.RawShaderMaterial | null = null;

	constructor(readonly emitter: RenderableEmitter, base: THREE.BufferGeometry, private opts: RendererOptions) {
		const geometry = new THREE.InstancedBufferGeometry();
		geometry.index = base.index;
		geometry.setAttribute('position', base.getAttribute('position'));
		const material = new THREE.RawShaderMaterial({
			vertexShader,
			fragmentShader,
			uniforms: {
				uMap: { value: missingTexture },
				uMaterial: { value: 0 },
				uLight: { value: new THREE.Vector3(1, 1, 1) },
				uAlphaCutoff: { value: opts.alphaCutoff ?? 0.5 },
				uSpace: { value: new THREE.Matrix4() },
				uEmitterRot: { value: new THREE.Matrix3() },
				uFacing: { value: 0 },
				uCamPos: { value: new THREE.Vector3() },
				uCamRight: { value: new THREE.Vector3(1, 0, 0) },
				uCamUp: { value: new THREE.Vector3(0, 1, 0) },
				uFallbackUp: { value: new THREE.Vector3(...(opts.fallbackUp ?? [0, 0, -1])) },
				uVV: { value: 0 },
				uVVLight: { value: new THREE.Vector3(1, 1, 1) },
				uVVHaze: { value: new THREE.Vector3(0, 0, 0) },
				uVVAdditive: { value: 1 },
				uVVEmissive: { value: 4 },
				uVVEmissiveGamma: { value: 1 },
				uVVDesat: { value: 0.1 },
				uMers: { value: missingTexture },
				uHasMers: { value: 0 },
			},
		});
		this.material = material;
		this.mesh = new THREE.Mesh(geometry, material);
		this.mesh.frustumCulled = false;
		this.configureMaterial();
	}

	/** the definition the material was set up for: an emitter can be given an edited one while it plays */
	private configuredFor: unknown = null;

	configureMaterial() {
		const def = this.emitter.def;
		this.configuredFor = def;
		const id = MATERIAL_ID[def.material] ?? 0;
		const m = this.material;
		m.uniforms.uMaterial.value = id;
		m.uniforms.uFacing.value = FACING_ID[def.particle.billboard?.facing ?? 'rotate_xyz'] ?? 0;
		// Cutout particles are one-sided (t06, measured with particles_alpha); blended and additive ones render both
		// sides, as reported in-game. Camera-facing modes always present their front face either way.
		m.side = id === 2 || id === 3 ? THREE.DoubleSide : THREE.FrontSide;
		if (id === 2 || id === 3) {
			m.transparent = true;
			m.depthWrite = false; // blended/additive particles never occlude each other
			m.blending = id === 3 ? THREE.AdditiveBlending : THREE.NormalBlending;
		} else {
			m.transparent = false;
			m.depthWrite = true;
			m.blending = THREE.NoBlending;
		}
		m.needsUpdate = true;
	}

	private bind(name: string, array: Float32Array | Uint8Array, itemSize: number, normalized = false) {
		const g = this.mesh.geometry;
		const existing = g.getAttribute(name) as THREE.InstancedBufferAttribute | undefined;
		if (!existing || existing.array !== array) {
			const attr = new THREE.InstancedBufferAttribute(array, itemSize, normalized);
			attr.setUsage(THREE.DynamicDrawUsage);
			g.setAttribute(name, attr);
			return attr;
		}
		return existing;
	}

	/** Gather the render arrays farthest-first along the camera's view axis */
	private sorted(camera: THREE.Camera): RenderArrays {
		const e = this.emitter;
		const pool = e.pool;
		const n = pool.count;
		if (this.order.length < pool.capacity) {
			this.order = new Uint32Array(pool.capacity);
			this.keys = new Float32Array(pool.capacity);
		}
		const st = this.staging;
		if (!st || st.visible.length < pool.capacity) {
			const cap = pool.capacity;
			this.staging = {
				pos: new Float32Array(cap * 3),
				size: new Float32Array(cap * 2),
				rot: new Float32Array(cap),
				facing: new Float32Array(cap * 3),
				uv: new Float32Array(cap * 4),
				color: new Uint8Array(cap * 4),
				visible: new Uint8Array(cap),
			};
		}
		const out = this.staging!;
		const me = camera.matrixWorld.elements;
		// camera looks down its local -Z
		const fx = -me[8], fy = -me[9], fz = -me[10];
		const cx = me[12], cy = me[13], cz = me[14];
		const order = this.order.subarray(0, n);
		const keys = this.keys;
		for (let i = 0; i < n; i++) {
			e.particleWorldPos(i, sortTmp);
			keys[i] = (sortTmp[0] - cx) * fx + (sortTmp[1] - cy) * fy + (sortTmp[2] - cz) * fz;
			order[i] = i;
		}
		order.sort((a, b) => keys[b] - keys[a]);
		for (const name of Object.keys(STRIDES) as (keyof RenderArrays)[]) {
			const k = STRIDES[name];
			const src = pool[name] as Float32Array | Uint8Array;
			const dst = out[name];
			for (let j = 0; j < n; j++) {
				const s = order[j] * k, d = j * k;
				for (let c = 0; c < k; c++) dst[d + c] = src[s + c];
			}
		}
		return out;
	}

	applyVibrant(vv: VibrantSettings | null, mers: THREE.Texture | null) {
		const u = this.material.uniforms;
		u.uVV.value = vv ? 1 : 0;
		if (vv) {
			(u.uVVLight.value as THREE.Vector3).set(...vv.light);
			(u.uVVHaze.value as THREE.Vector3).set(...vv.haze);
			u.uVVAdditive.value = vv.additive;
			u.uVVEmissive.value = vv.emissive;
			u.uVVEmissiveGamma.value = vv.emissiveGamma ?? 1;
			u.uVVDesat.value = vv.desaturation;
		}
		u.uHasMers.value = vv && mers ? 1 : 0;
		u.uMers.value = mers ?? missingTexture;
	}

	/** The ID-pass material: the same quads, writing `base + draw index + 1` */
	pickMaterial(base: number): THREE.RawShaderMaterial {
		if (!this.pickMat) {
			this.pickMat = new THREE.RawShaderMaterial({
				vertexShader,
				fragmentShader: pickFragmentShader,
				// the draw uniforms themselves (shared objects), so the pass sees this frame's values
				uniforms: { ...this.material.uniforms, uBase: { value: 0 } },
				side: THREE.FrontSide,
				blending: THREE.NoBlending,
				depthTest: true,
				depthWrite: true,
			});
		}
		this.pickMat.side = this.material.side;
		this.pickMat.uniforms.uBase.value = base;
		return this.pickMat;
	}

	/** Which emitter and pool index the instance drawn at `drawIndex` belongs to */
	source(drawIndex: number): PickedParticle | null {
		const index = this.drewSorted ? this.order[drawIndex] : drawIndex;
		if (index === undefined || index >= this.emitter.pool.count) return null;
		return this.emitter instanceof MergedEmitter ? this.emitter.source(index) : { emitter: this.emitter, index };
	}

	sync(camera: THREE.Camera, light: number, sortBlended: boolean) {
		const e = this.emitter;
		if (e.def !== this.configuredFor) this.configureMaterial();
		const pool = e.pool;
		const g = this.mesh.geometry;
		const n = pool.count;
		camera.updateMatrixWorld();
		const blend = (MATERIAL_ID[e.def.material] ?? 0) === 2;
		const src: RenderArrays = sortBlended && blend && n > 1 && !e.culled ? this.sorted(camera) : pool;
		this.drewSorted = src !== pool;
		// static, uploaded once per growth
		this.bind('iIndex', drawIndices(pool.capacity), 1);
		const attrs: [string, Float32Array | Uint8Array, number, boolean][] = [
			['iPos', src.pos, 3, false],
			['iSize', src.size, 2, false],
			['iRot', src.rot, 1, false],
			['iDir', src.facing, 3, false],
			['iUV', src.uv, 4, false],
			['iColor', src.color, 4, true],
			['iVisible', src.visible, 1, false],
		];
		for (const [name, array, size, norm] of attrs) {
			const attr = this.bind(name, array, size, norm);
			attr.clearUpdateRanges();
			attr.addUpdateRange(0, n * size);
			attr.needsUpdate = true;
		}
		g.instanceCount = e.culled ? 0 : n;
		// three.js caps instanced draws at the size of the first instanced attribute it ever saw, and never
		// re-reads it: once a pool grows past that, everything beyond the old capacity silently isn't drawn.
		// Every attribute bound here holds at least `capacity` instances.
		(g as unknown as { _maxInstanceCount?: number })._maxInstanceCount = pool.capacity;

		const u = this.material.uniforms;
		const space = u.uSpace.value as THREE.Matrix4;
		if (e.localSpace) {
			const q = e.def.emitter.localSpace.rotation ? new THREE.Quaternion(...e.rotation) : new THREE.Quaternion();
			space.compose(new THREE.Vector3(...e.position), q, new THREE.Vector3(1, 1, 1));
		} else space.identity();
		(u.uEmitterRot.value as THREE.Matrix3).setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(...e.rotation)));
		const me = camera.matrixWorld.elements;
		u.uCamPos.value.set(me[12], me[13], me[14]);
		u.uCamRight.value.set(me[0], me[1], me[2]).normalize();
		u.uCamUp.value.set(me[4], me[5], me[6]).normalize();
		const lit = e.def.particle.lighting ? light : 1;
		u.uLight.value.set(lit, lit, lit);
	}

	dispose() {
		this.mesh.geometry.dispose();
		this.material.dispose();
		this.pickMat?.dispose();
	}
}

/**
 * Renders a ParticleWorld with one instanced draw per emitter. Call `sync()` after `world.step()`.
 */
/** emitters at most this big can share a draw with others of the same effect */
const MERGE_MAX_PARTICLES = 4096;
const EMITTER_FACINGS = new Set(['emitter_transform_xy', 'emitter_transform_xz', 'emitter_transform_yz']);

/**
 * Small world-space emitters of one effect drawn as one: thousands of child emitters (splashes, sparks)
 * would otherwise each cost a draw call. Only for materials where draw order doesn't matter (cutout,
 * opaque, additive); blended emitters keep their own back-to-front sorted draw.
 */
class MergedEmitter implements RenderableEmitter {
	readonly pool = {
		count: 0,
		capacity: 0,
		pos: new Float32Array(0),
		size: new Float32Array(0),
		rot: new Float32Array(0),
		facing: new Float32Array(0),
		uv: new Float32Array(0),
		color: new Uint8Array(0),
		visible: new Uint8Array(0),
		local: new Uint8Array(0),
	};
	culled = false;
	readonly localSpace = false;
	readonly position: Vec3 = [0, 0, 0];
	readonly rotation: Quat = [0, 0, 0, 1];

	/** where each member's particles sit in the merged arrays (picking maps back through this) */
	private parts: { emitter: RenderableEmitter; start: number; count: number }[] = [];

	constructor(readonly def: EffectDefinition) {}

	source(i: number): PickedParticle | null {
		for (const p of this.parts) if (i >= p.start && i < p.start + p.count) return { emitter: p.emitter, index: i - p.start };
		return null;
	}

	fill(members: RenderableEmitter[]) {
		this.parts = [];
		let total = 0;
		for (const e of members) if (!e.culled) total += e.pool.count;
		const p = this.pool;
		if (total > p.capacity) {
			let cap = Math.max(256, p.capacity);
			while (cap < total) cap *= 2;
			p.capacity = cap;
			p.pos = new Float32Array(cap * 3);
			p.size = new Float32Array(cap * 2);
			p.rot = new Float32Array(cap);
			p.facing = new Float32Array(cap * 3);
			p.uv = new Float32Array(cap * 4);
			p.color = new Uint8Array(cap * 4);
			p.visible = new Uint8Array(cap);
			p.local = new Uint8Array(cap);
		}
		let o = 0;
		for (const e of members) {
			if (e.culled) continue;
			const s = e.pool;
			const n = s.count;
			p.pos.set(s.pos.subarray(0, n * 3), o * 3);
			p.size.set(s.size.subarray(0, n * 2), o * 2);
			p.rot.set(s.rot.subarray(0, n), o);
			p.facing.set(s.facing.subarray(0, n * 3), o * 3);
			p.uv.set(s.uv.subarray(0, n * 4), o * 4);
			p.color.set(s.color.subarray(0, n * 4), o * 4);
			p.visible.set(s.visible.subarray(0, n), o);
			this.parts.push({ emitter: e, start: o, count: n });
			o += n;
		}
		p.count = total;
		this.culled = total === 0;
	}

	particleWorldPos(i: number, out: Vec3): Vec3 {
		out[0] = this.pool.pos[i * 3];
		out[1] = this.pool.pos[i * 3 + 1];
		out[2] = this.pool.pos[i * 3 + 2];
		return out;
	}
}

function mergeable(e: RenderableEmitter): boolean {
	const material = MATERIAL_ID[e.def.material] ?? 0;
	return material !== 2 && !e.localSpace && e.pool.count <= MERGE_MAX_PARTICLES && !EMITTER_FACINGS.has(e.def.particle.billboard?.facing ?? '');
}

export class ParticleRenderer {
	readonly group = new THREE.Group();
	lighting: LightingSettings = { skyLight: 15, blockLight: 0, timeOfDay: 0.25 };
	/** Vibrant Visuals approximation; null renders classic */
	vibrant: VibrantSettings | null = null;
	private batches = new Map<RenderableEmitter, Batch>();
	private base: THREE.BufferGeometry;

	constructor(private opts: RendererOptions) {
		this.base = new THREE.BufferGeometry();
		this.base.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
		this.base.setIndex([0, 1, 2, 0, 2, 3]);
		this.group.name = 'particles';
	}

	sync(world: ParticleWorld, camera: THREE.Camera): void {
		this.syncEmitters(world.emitters, camera);
	}

	/** one merged stand-in per effect, kept across frames so its GPU buffers are reused */
	private merged = new Map<EffectDefinition, MergedEmitter>();

	/** Draw these emitters (a world's, plus any simulated elsewhere) */
	syncEmitters(emitters: Iterable<RenderableEmitter>, camera: THREE.Camera): void {
		const live = new Set<RenderableEmitter>();
		const light = classicLightFactor(this.lighting);
		// small emitters of the same effect share a draw
		const groups = new Map<EffectDefinition, RenderableEmitter[]>();
		const draw: RenderableEmitter[] = [];
		for (const e of emitters) {
			if (!mergeable(e)) {
				draw.push(e);
				continue;
			}
			let g = groups.get(e.def);
			if (!g) groups.set(e.def, (g = []));
			g.push(e);
		}
		for (const [def, members] of groups) {
			if (members.length < 2) {
				draw.push(...members);
				continue;
			}
			let m = this.merged.get(def);
			if (!m) this.merged.set(def, (m = new MergedEmitter(def)));
			m.fill(members);
			draw.push(m);
		}
		for (const def of [...this.merged.keys()]) if (!groups.has(def) || groups.get(def)!.length < 2) this.merged.delete(def);
		for (const e of draw) {
			live.add(e);
			let b = this.batches.get(e);
			if (!b) {
				b = new Batch(e, this.base, this.opts);
				this.batches.set(e, b);
				this.group.add(b.mesh);
			}
			const tex = this.opts.textures(e.def.texture, e) ?? missingTexture;
			b.material.uniforms.uMap.value = tex;
			b.applyVibrant(this.vibrant, this.vibrant && this.opts.mers ? this.opts.mers(e.def.texture, e) : null);
			b.sync(camera, light, this.opts.sortBlended !== false);
		}
		for (const [e, b] of this.batches) {
			if (!live.has(e)) {
				this.group.remove(b.mesh);
				b.dispose();
				this.batches.delete(e);
			}
		}
	}

	private pickTarget: THREE.WebGLRenderTarget | null = null;

	/**
	 * The particle drawn at a point of the canvas (CSS pixels from its top-left; `width`/`height` the canvas'
	 * CSS size), exactly as rendered: facing, size, rotation, texture alpha and which particle is in front.
	 * Looks up to `radius` pixels around the point and takes the hit nearest to it, so tiny particles can be
	 * clicked. Uses the batches drawn by the last sync.
	 */
	pick(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, x: number, y: number, width: number, height: number, radius = 4): PickedParticle | null {
		const size = radius * 2 + 1;
		if (!this.pickTarget) this.pickTarget = new THREE.WebGLRenderTarget(size, size, { depthBuffer: true });
		else if (this.pickTarget.width !== size) this.pickTarget.setSize(size, size);
		const ranges: { batch: Batch; base: number; count: number }[] = [];
		const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
		let base = 0;
		for (const b of this.batches.values()) {
			const count = b.mesh.geometry.instanceCount;
			ranges.push({ batch: b, base, count });
			swapped.push([b.mesh, b.mesh.material]);
			b.mesh.material = b.pickMaterial(base);
			base += count;
		}
		if (!base) {
			for (const [m, mat] of swapped) m.material = mat;
			return null;
		}
		const prevTarget = renderer.getRenderTarget();
		const prevClear = renderer.getClearColor(new THREE.Color());
		const prevAlpha = renderer.getClearAlpha();
		const prevView = camera.view?.enabled ? { ...camera.view } : null;
		const pixels = new Uint8Array(size * size * 4);
		try {
			camera.setViewOffset(width, height, Math.round(x) - radius, Math.round(y) - radius, size, size);
			renderer.setRenderTarget(this.pickTarget);
			renderer.setClearColor(0x000000, 0);
			renderer.clear();
			renderer.render(this.group, camera);
			renderer.readRenderTargetPixels(this.pickTarget, 0, 0, size, size, pixels);
		} finally {
			renderer.setRenderTarget(prevTarget);
			renderer.setClearColor(prevClear, prevAlpha);
			if (prevView) camera.setViewOffset(prevView.fullWidth, prevView.fullHeight, prevView.offsetX, prevView.offsetY, prevView.width, prevView.height);
			else camera.clearViewOffset();
			for (const [m, mat] of swapped) m.material = mat;
		}
		let best = -1;
		let bestD = Infinity;
		for (let row = 0; row < size; row++) {
			for (let col = 0; col < size; col++) {
				const o = (row * size + col) * 4;
				const id = pixels[o] + pixels[o + 1] * 256 + pixels[o + 2] * 65536;
				if (!id) continue;
				const d = (col - radius) ** 2 + (row - radius) ** 2;
				if (d < bestD) {
					bestD = d;
					best = id - 1;
				}
			}
		}
		if (best < 0) return null;
		const r = ranges.find((r) => best >= r.base && best < r.base + r.count);
		return r ? r.batch.source(best - r.base) : null;
	}

	/** Re-read material/facing after a definition hot-swap */
	refreshMaterials(): void {
		for (const b of this.batches.values()) b.configureMaterial();
	}

	dispose(): void {
		for (const b of this.batches.values()) b.dispose();
		this.batches.clear();
		this.base.dispose();
		this.pickTarget?.dispose();
	}
}

export { missingTexture };
