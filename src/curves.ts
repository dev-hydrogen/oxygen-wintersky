import type { CurveDefinition } from './definition';

/** Evaluate a numeric field in the emitter's context */
export type NumEval = (field: CurveDefinition['input']) => number;

function clamp01(x: number) {
	return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Evaluate a curve the way Bedrock does. Node values are Molang (evaluated each time).
 * - linear: nodes equally spaced over [0,1] after input / horizontal_range
 * - bezier: 4 nodes; first/last are the values at 0 and 1, middle ones shape the slopes
 * - catmull_rom: passes through all but the first/last node, which form the end slopes
 * - bezier_chain: keyed nodes (input positions, sorted), held before the first / after the last key,
 *   `horizontal_range` ignored
 */
export function evaluateCurve(curve: CurveDefinition, num: NumEval): number {
	const input = num(curve.input);
	if (curve.type === 'bezier_chain') return evaluateChain(curve, input, num);

	let range = curve.range ? num(curve.range) : 1;
	let t = range === 0 ? 0 : input / range;
	if (Number.isNaN(t)) t = 0;
	t = clamp01(t);
	const nodes = curve.nodes;
	const n = nodes.length;
	if (n === 0) return 0;
	if (n === 1) return num(nodes[0]);

	switch (curve.type) {
		case 'linear': {
			const seg = n - 1;
			const x = t * seg;
			let i = Math.floor(x);
			if (i >= seg) i = seg - 1;
			const f = x - i;
			const a = num(nodes[i]);
			const b = num(nodes[i + 1]);
			return a + (b - a) * f;
		}
		case 'bezier': {
			const p0 = num(nodes[0]);
			const p1 = num(nodes[Math.min(1, n - 1)]);
			const p2 = num(nodes[Math.min(2, n - 1)]);
			const p3 = num(nodes[Math.min(3, n - 1)]);
			const u = 1 - t;
			return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
		}
		case 'catmull_rom': {
			if (n < 4) {
				// degenerate: behave linearly between available nodes
				const x = t * (n - 1);
				const i = Math.min(Math.floor(x), n - 2);
				const a = num(nodes[i]);
				const b = num(nodes[i + 1]);
				return a + (b - a) * (x - i);
			}
			const segs = n - 3; // interior segments between nodes[1..n-2]
			const x = t * segs;
			let i = Math.floor(x);
			if (i >= segs) i = segs - 1;
			const f = x - i;
			const p0 = num(nodes[i]);
			const p1 = num(nodes[i + 1]);
			const p2 = num(nodes[i + 2]);
			const p3 = num(nodes[i + 3]);
			const f2 = f * f;
			const f3 = f2 * f;
			return 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
		}
	}
	return 0;
}

function evaluateChain(curve: CurveDefinition, input: number, num: NumEval): number {
	const nodes = curve.chain;
	if (nodes.length === 0) return 0;
	if (Number.isNaN(input)) input = 0;
	if (input <= nodes[0].key) return num(nodes[0].rightValue);
	const last = nodes[nodes.length - 1];
	if (input >= last.key) return num(last.leftValue);
	let i = 0;
	while (i < nodes.length - 1 && nodes[i + 1].key <= input) i++;
	const a = nodes[i];
	const b = nodes[i + 1];
	const span = b.key - a.key;
	const u = span === 0 ? 0 : (input - a.key) / span;
	const p0 = num(a.rightValue);
	const p3 = num(b.leftValue);
	// slopes are in value-per-input units; control points sit at thirds of the segment
	const p1 = p0 + (num(a.rightSlope) * span) / 3;
	const p2 = p3 - (num(b.leftSlope) * span) / 3;
	const w = 1 - u;
	return w * w * w * p0 + 3 * w * w * u * p1 + 3 * w * u * u * p2 + u * u * u * p3;
}
