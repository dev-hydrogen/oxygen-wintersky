/**
 * Struct-of-arrays particle storage. Float32 storage mirrors the game's float state.
 * Order is stable (removal compacts in place), because traversal order is observable in Molang
 * through the shared variable map (index-counter patterns).
 */
export class ParticlePool {
	count = 0;
	capacity: number;
	/** stable identity across frames (debugger selection, scrubbing) */
	id: Uint32Array;
	age: Float32Array;
	lifetime: Float32Array;
	/** 0 = no max_lifetime (lives until expired by other means) */
	hasLifetime: Uint8Array;
	random: Float32Array; // 4 per particle
	pos: Float32Array; // 3
	prevPos: Float32Array; // 3
	vel: Float32Array; // 3
	rot: Float32Array;
	rotRate: Float32Array;
	facing: Float32Array; // 3
	dead: Uint8Array;
	/** particle simulated in emitter-local space (attached + local position) */
	local: Uint8Array;
	// render-prep outputs
	size: Float32Array; // 2
	uv: Float32Array; // 4: u0 v0 u1 v1 (normalized)
	color: Uint8Array; // 4 (packed like the game: trunc(c*255) clamped)
	visible: Uint8Array;
	/** collision contact state for collision_drag */
	contact: Uint8Array;

	constructor(capacity = 64) {
		this.capacity = capacity;
		this.id = new Uint32Array(capacity);
		this.age = new Float32Array(capacity);
		this.lifetime = new Float32Array(capacity);
		this.hasLifetime = new Uint8Array(capacity);
		this.random = new Float32Array(capacity * 4);
		this.pos = new Float32Array(capacity * 3);
		this.prevPos = new Float32Array(capacity * 3);
		this.vel = new Float32Array(capacity * 3);
		this.rot = new Float32Array(capacity);
		this.rotRate = new Float32Array(capacity);
		this.facing = new Float32Array(capacity * 3);
		this.dead = new Uint8Array(capacity);
		this.local = new Uint8Array(capacity);
		this.size = new Float32Array(capacity * 2);
		this.uv = new Float32Array(capacity * 4);
		this.color = new Uint8Array(capacity * 4);
		this.visible = new Uint8Array(capacity);
		this.contact = new Uint8Array(capacity);
	}

	private grow(min: number) {
		let cap = this.capacity;
		while (cap < min) cap *= 2;
		const copy = <T extends Float32Array | Uint8Array | Uint32Array>(a: T, stride: number): T => {
			const n = new (a.constructor as any)(cap * stride) as T;
			n.set(a.subarray(0, this.count * stride));
			return n;
		};
		this.id = copy(this.id, 1);
		this.age = copy(this.age, 1);
		this.lifetime = copy(this.lifetime, 1);
		this.hasLifetime = copy(this.hasLifetime, 1);
		this.random = copy(this.random, 4);
		this.pos = copy(this.pos, 3);
		this.prevPos = copy(this.prevPos, 3);
		this.vel = copy(this.vel, 3);
		this.rot = copy(this.rot, 1);
		this.rotRate = copy(this.rotRate, 1);
		this.facing = copy(this.facing, 3);
		this.dead = copy(this.dead, 1);
		this.local = copy(this.local, 1);
		this.size = copy(this.size, 2);
		this.uv = copy(this.uv, 4);
		this.color = copy(this.color, 4);
		this.visible = copy(this.visible, 1);
		this.contact = copy(this.contact, 1);
		this.capacity = cap;
	}

	/** Append a zeroed particle; returns its index */
	add(id: number): number {
		if (this.count >= this.capacity) this.grow(this.count + 1);
		const i = this.count++;
		this.id[i] = id;
		this.age[i] = 0;
		this.lifetime[i] = 0;
		this.hasLifetime[i] = 0;
		this.random.fill(0, i * 4, i * 4 + 4);
		this.pos.fill(0, i * 3, i * 3 + 3);
		this.prevPos.fill(0, i * 3, i * 3 + 3);
		this.vel.fill(0, i * 3, i * 3 + 3);
		this.rot[i] = 0;
		this.rotRate[i] = 0;
		this.facing.fill(0, i * 3, i * 3 + 3);
		this.dead[i] = 0;
		this.local[i] = 0;
		this.size[i * 2] = this.size[i * 2 + 1] = 0;
		this.uv.fill(0, i * 4, i * 4 + 4);
		this.color.fill(255, i * 4, i * 4 + 4);
		this.visible[i] = 0;
		this.contact[i] = 0;
		return i;
	}

	/** Remove dead particles, preserving the order of survivors */
	compact(): number {
		let w = 0;
		const n = this.count;
		for (let r = 0; r < n; r++) {
			if (this.dead[r]) continue;
			if (w !== r) this.move(r, w);
			w++;
		}
		const removed = n - w;
		this.count = w;
		return removed;
	}

	private move(from: number, to: number) {
		this.id[to] = this.id[from];
		this.age[to] = this.age[from];
		this.lifetime[to] = this.lifetime[from];
		this.hasLifetime[to] = this.hasLifetime[from];
		this.random.copyWithin(to * 4, from * 4, from * 4 + 4);
		this.pos.copyWithin(to * 3, from * 3, from * 3 + 3);
		this.prevPos.copyWithin(to * 3, from * 3, from * 3 + 3);
		this.vel.copyWithin(to * 3, from * 3, from * 3 + 3);
		this.rot[to] = this.rot[from];
		this.rotRate[to] = this.rotRate[from];
		this.facing.copyWithin(to * 3, from * 3, from * 3 + 3);
		this.dead[to] = 0;
		this.local[to] = this.local[from];
		this.size.copyWithin(to * 2, from * 2, from * 2 + 2);
		this.uv.copyWithin(to * 4, from * 4, from * 4 + 4);
		this.color.copyWithin(to * 4, from * 4, from * 4 + 4);
		this.visible[to] = this.visible[from];
		this.contact[to] = this.contact[from];
	}

	indexOfId(id: number): number {
		for (let i = 0; i < this.count; i++) if (this.id[i] === id) return i;
		return -1;
	}

	clear(): void {
		this.count = 0;
	}

	/** Deep copy for snapshots */
	clone(): ParticlePool {
		const p = new ParticlePool(Math.max(1, this.count));
		p.count = this.count;
		const n = this.count;
		p.id.set(this.id.subarray(0, n));
		p.age.set(this.age.subarray(0, n));
		p.lifetime.set(this.lifetime.subarray(0, n));
		p.hasLifetime.set(this.hasLifetime.subarray(0, n));
		p.random.set(this.random.subarray(0, n * 4));
		p.pos.set(this.pos.subarray(0, n * 3));
		p.prevPos.set(this.prevPos.subarray(0, n * 3));
		p.vel.set(this.vel.subarray(0, n * 3));
		p.rot.set(this.rot.subarray(0, n));
		p.rotRate.set(this.rotRate.subarray(0, n));
		p.facing.set(this.facing.subarray(0, n * 3));
		p.local.set(this.local.subarray(0, n));
		p.size.set(this.size.subarray(0, n * 2));
		p.uv.set(this.uv.subarray(0, n * 4));
		p.color.set(this.color.subarray(0, n * 4));
		p.visible.set(this.visible.subarray(0, n));
		p.contact.set(this.contact.subarray(0, n));
		return p;
	}
}
