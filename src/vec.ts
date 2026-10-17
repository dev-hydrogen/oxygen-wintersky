/** Tiny allocation-free vector helpers (the sim core doesn't depend on three.js). */
export type Vec3 = [number, number, number];
/** Quaternion [x, y, z, w] */
export type Quat = [number, number, number, number];

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const quatIdentity = (): Quat => [0, 0, 0, 1];

export function len3(x: number, y: number, z: number): number {
	return Math.sqrt(x * x + y * y + z * z);
}

/** Rotate vector (x,y,z) by quaternion q, writing into out */
export function rotateByQuat(out: Vec3, x: number, y: number, z: number, q: Quat): Vec3 {
	const [qx, qy, qz, qw] = q;
	const ix = qw * x + qy * z - qz * y;
	const iy = qw * y + qz * x - qx * z;
	const iz = qw * z + qx * y - qy * x;
	const iw = -qx * x - qy * y - qz * z;
	out[0] = ix * qw + iw * -qx + iy * -qz - iz * -qy;
	out[1] = iy * qw + iw * -qy + iz * -qx - ix * -qz;
	out[2] = iz * qw + iw * -qz + ix * -qy - iy * -qx;
	return out;
}

export function quatConjugate(q: Quat): Quat {
	return [-q[0], -q[1], -q[2], q[3]];
}

/** Quaternion from Euler angles in degrees (yaw around Y, pitch around X, roll around Z), applied Y·X·Z */
export function quatFromYawPitch(yawDeg: number, pitchDeg: number, rollDeg = 0): Quat {
	const y = (yawDeg * Math.PI) / 360;
	const x = (pitchDeg * Math.PI) / 360;
	const z = (rollDeg * Math.PI) / 360;
	const cy = Math.cos(y), sy = Math.sin(y);
	const cx = Math.cos(x), sx = Math.sin(x);
	const cz = Math.cos(z), sz = Math.sin(z);
	// q = qy * qx * qz
	return [
		cy * sx * cz + sy * cx * sz,
		sy * cx * cz - cy * sx * sz,
		cy * cx * sz - sy * sx * cz,
		cy * cx * cz + sy * sx * sz,
	];
}

/** Deterministic RNG with inspectable state (mulberry32) — snapshots & exact replays */
export class Rng {
	state: number;
	constructor(seed = 0x1234567) {
		this.state = seed >>> 0;
	}
	next = (): number => {
		this.state = (this.state + 0x6d2b79f5) >>> 0;
		let t = this.state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
