import type { FacingMode } from './definition';
import { rotateByQuat, type Quat, type Vec3 } from './vec';

export interface FacingBasis {
	/** billboard local X (right) */
	right: Vec3;
	/** billboard local Y (up) */
	up: Vec3;
	/** face normal (local Z) */
	normal: Vec3;
	/** the direction was (nearly) vertical, so the fallback up axis was used */
	usedFallback: boolean;
	/** the direction was ~zero, so a fixed orientation was used */
	degenerate: boolean;
	/** normalized input direction (direction modes) */
	direction: Vec3 | null;
}

const UP: Vec3 = [0, 1, 0];

function cross(a: Vec3, b: Vec3): Vec3 {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(v: Vec3, fallback: Vec3): Vec3 {
	const l = Math.hypot(v[0], v[1], v[2]);
	return l > 1e-6 ? [v[0] / l, v[1] / l, v[2] / l] : [...fallback];
}

/**
 * CPU mirror of the vertex shader's facing math (used for gizmos, the debugger and tests).
 * Direction modes: the suffix names which billboard axis follows the direction; the rest is built
 * from world up, with fixed axes when the direction is vertical (|d.y| > 0.9999). Measured in-game.
 * `fallbackUp` is only used by lookat_direction.
 */
export function facingBasis(
	mode: FacingMode,
	position: Vec3,
	direction: Vec3,
	camera: { position: Vec3; right: Vec3; up: Vec3 },
	emitterRotation: Quat,
	fallbackUp: Vec3 = [0, 0, -1],
): FacingBasis {
	const dl = Math.hypot(direction[0], direction[1], direction[2]);
	const degenerate = dl <= 1e-6;
	const d: Vec3 = degenerate ? [0, 0, 0] : [direction[0] / dl, direction[1] / dl, direction[2] / dl];
	const vertical = !degenerate && Math.abs(d[1]) > 0.9999;
	const upRef = vertical ? fallbackUp : UP;
	const toCam = norm([camera.position[0] - position[0], camera.position[1] - position[1], camera.position[2] - position[2]], cross(camera.right, camera.up));
	let right: Vec3 = [...camera.right];
	let up: Vec3 = [...camera.up];
	const er = (x: number, y: number, z: number): Vec3 => rotateByQuat([0, 0, 0], x, y, z, emitterRotation);
	switch (mode) {
		case 'rotate_y':
			right = norm([camera.right[0], 0, camera.right[2]], [1, 0, 0]);
			up = [...UP];
			break;
		case 'lookat_xyz':
			right = norm(cross(UP, toCam), camera.right);
			up = cross(toCam, right);
			break;
		case 'lookat_y': {
			const n = norm([camera.position[0] - position[0], 0, camera.position[2] - position[2]], [0, 0, 1]);
			right = norm(cross(UP, n), [1, 0, 0]);
			up = [...UP];
			break;
		}
		case 'lookat_direction':
			if (degenerate) right = up = [0, 0, 0];
			else {
				right = d;
				const k = toCam[0] * d[0] + toCam[1] * d[1] + toCam[2] * d[2];
				const n = norm([toCam[0] - d[0] * k, toCam[1] - d[1] * k, toCam[2] - d[2] * k], upRef);
				up = cross(n, right);
			}
			break;
		// direction_* axes as measured in-game (t34–t36). A zero direction is degenerate: the quad
		// collapses and nothing is drawn.
		case 'direction_x':
			if (degenerate) right = up = [0, 0, 0];
			else if (vertical) {
				// X = d, normal = -Z
				right = d;
				up = cross([0, 0, -1], d);
			} else {
				// X = d, Y = world up (re-orthogonalized), normal = X × Y
				const Z = norm(cross(d, UP), [0, 0, 1]);
				right = d;
				up = cross(Z, d);
			}
			break;
		case 'direction_y':
			if (degenerate) right = up = [0, 0, 0];
			else if (vertical) {
				// Y = d, normal = +Z (so -Y renders upside down)
				up = d;
				right = cross(d, [0, 0, 1]);
			} else {
				// Y = d, X = d × up: a horizontal direction lies flat, facing +Y
				up = d;
				right = norm(cross(d, UP), [1, 0, 0]);
			}
			break;
		case 'direction_z':
			if (degenerate) right = up = [0, 0, 0];
			else if (vertical) {
				// normal = -d, Y = +Z
				up = [0, 0, 1];
				right = cross(up, [-d[0], -d[1], -d[2]]);
			} else {
				// normal = d, Y = world up (re-orthogonalized), X = up × d
				right = norm(cross(UP, d), [1, 0, 0]);
				up = cross(d, right);
			}
			break;
		case 'emitter_transform_xy':
			right = er(1, 0, 0);
			up = er(0, 1, 0);
			break;
		case 'emitter_transform_xz':
			right = er(1, 0, 0);
			up = er(0, 0, -1);
			break;
		case 'emitter_transform_yz':
			right = er(0, 0, -1);
			up = er(0, 1, 0);
			break;
	}
	return { right, up, normal: norm(cross(right, up), [0, 0, 1]), usedFallback: vertical, degenerate, direction: degenerate ? null : d };
}
