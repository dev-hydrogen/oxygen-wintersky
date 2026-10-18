/** Facing mode ids shared with the vertex shader */
export const FACING_ID: Record<string, number> = {
	rotate_xyz: 0,
	rotate_y: 1,
	lookat_xyz: 2,
	lookat_y: 3,
	lookat_direction: 4,
	direction_x: 5,
	direction_y: 6,
	direction_z: 7,
	emitter_transform_xy: 8,
	emitter_transform_xz: 9,
	emitter_transform_yz: 10,
};

export const MATERIAL_ID: Record<string, number> = {
	particles_alpha: 0,
	particles_opaque: 1,
	particles_blend: 2,
	particles_add: 3,
};

export const vertexShader = /* glsl */ `
precision highp float;
attribute vec3 position;          // quad corner in [-1, 1]
attribute vec3 iPos;
attribute vec2 iSize;
attribute float iRot;
attribute vec3 iDir;
attribute vec4 iUV;
attribute vec4 iColor;
attribute float iVisible;
attribute float iIndex;           // draw order within the batch (picking)

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat4 uSpace;              // particle space -> world (local-space emitters)
uniform mat3 uEmitterRot;         // emitter transform axes (emitter_transform_* modes)
uniform int uFacing;
uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uFallbackUp;         // used when a direction is (anti)parallel to world up

varying vec2 vUv;
varying vec4 vColor;
varying vec3 vNormal;
varying vec3 vWorld;
varying float vIndex;

const vec3 WORLD_UP = vec3(0.0, 1.0, 0.0);

vec3 safeNormalize(vec3 v, vec3 fallback) {
	float l = length(v);
	return l > 1e-6 ? v / l : fallback;
}

void main() {
	if (iVisible < 0.5) {
		gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside clip space
		return;
	}
	vec3 P = (uSpace * vec4(iPos, 1.0)).xyz;
	vec3 R = uCamRight;
	vec3 U = uCamUp;
	vec3 toCam = safeNormalize(uCamPos - P, -cross(uCamRight, uCamUp));
	vec3 d = safeNormalize(iDir, vec3(0.0));
	bool hasDir = length(iDir) > 1e-6;
	bool vertical = abs(d.y) > 0.9999;
	// direction modes with a zero direction are degenerate in-game: nothing is drawn (t34–t36)
	if (!hasDir && uFacing >= 4 && uFacing <= 7) {
		gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
		return;
	}
	vec3 upRef = vertical ? uFallbackUp : WORLD_UP;

	if (uFacing == 1) { // rotate_y
		R = safeNormalize(vec3(uCamRight.x, 0.0, uCamRight.z), vec3(1.0, 0.0, 0.0));
		U = WORLD_UP;
	} else if (uFacing == 2) { // lookat_xyz (biased towards world up)
		R = safeNormalize(cross(WORLD_UP, toCam), uCamRight);
		U = cross(toCam, R);
	} else if (uFacing == 3) { // lookat_y
		vec3 n = safeNormalize(vec3(uCamPos.x - P.x, 0.0, uCamPos.z - P.z), vec3(0.0, 0.0, 1.0));
		R = safeNormalize(cross(WORLD_UP, n), vec3(1.0, 0.0, 0.0));
		U = WORLD_UP;
	} else if (uFacing == 4) { // lookat_direction: X along direction, rotated about it to face the camera
		R = d;
		vec3 n = safeNormalize(toCam - d * dot(toCam, d), upRef);
		U = cross(n, R);
	} else if (uFacing == 5) { // direction_x (measured in-game)
		R = d;
		if (vertical) U = cross(vec3(0.0, 0.0, -1.0), d);                       // normal -Z
		else U = cross(safeNormalize(cross(d, WORLD_UP), vec3(0.0, 0.0, 1.0)), d); // Y ~ world up
	} else if (uFacing == 6) { // direction_y (measured in-game)
		U = d;
		if (vertical) R = cross(d, vec3(0.0, 0.0, 1.0));                       // normal +Z
		else R = safeNormalize(cross(d, WORLD_UP), vec3(1.0, 0.0, 0.0));         // horizontal d lies flat
	} else if (uFacing == 7) { // direction_z (measured in-game)
		if (vertical) {                                                         // normal -d, Y = +Z
			U = vec3(0.0, 0.0, 1.0);
			R = cross(U, -d);
		} else {                                                                // normal d, Y ~ world up
			R = safeNormalize(cross(WORLD_UP, d), vec3(1.0, 0.0, 0.0));
			U = cross(d, R);
		}
	} else if (uFacing == 8) { // emitter_transform_xy
		R = uEmitterRot * vec3(1.0, 0.0, 0.0);
		U = uEmitterRot * vec3(0.0, 1.0, 0.0);
	} else if (uFacing == 9) { // emitter_transform_xz (faces +Y)
		R = uEmitterRot * vec3(1.0, 0.0, 0.0);
		U = uEmitterRot * vec3(0.0, 0.0, -1.0);
	} else if (uFacing == 10) { // emitter_transform_yz (faces +X)
		R = uEmitterRot * vec3(0.0, 0.0, -1.0);
		U = uEmitterRot * vec3(0.0, 1.0, 0.0);
	}

	float a = radians(iRot);
	float c = cos(a);
	float s = sin(a);
	vec3 R2 = R * c + U * s;
	vec3 U2 = U * c - R * s;
	vec3 world = P + R2 * (position.x * iSize.x) + U2 * (position.y * iSize.y);
	vWorld = world;
	vNormal = normalize(cross(R2, U2));
	gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
	vUv = vec2(mix(iUV.x, iUV.z, position.x * 0.5 + 0.5), mix(iUV.y, iUV.w, 0.5 - position.y * 0.5));
	vColor = iColor;
	vIndex = iIndex;
}
`;

export const fragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform int uMaterial;            // 0 alpha (cutout), 1 opaque, 2 blend, 3 add
uniform vec3 uLight;              // classic lighting multiplier (1 when the effect is unlit)
uniform float uAlphaCutoff;
// Vibrant Visuals approximation (HDR output, tone mapped afterwards)
uniform float uVV;
uniform vec3 uVVLight;            // light on every particle, lit or not (measured in-game, t65)
uniform vec3 uVVHaze;             // in-scattering added in front of non-additive particles
uniform float uVVAdditive;        // additive particles are lit brighter
uniform float uVVEmissive;        // MERS emissive strength
uniform float uVVEmissiveGamma;   // emissive light grows as channel^gamma
uniform float uVVDesat;           // emissive desaturation (lighting/global.json)
uniform sampler2D uMers;
uniform float uHasMers;

varying vec2 vUv;
varying vec4 vColor;

void main() {
	vec4 tex = texture2D(uMap, vUv);
	vec4 c = tex * vColor;
	if (uMaterial == 0) {
		// cutout tests the TEXTURE alpha only; tint alpha is ignored (t06). Discarded texels write no depth.
		if (tex.a < uAlphaCutoff) discard;
		c.a = 1.0;
	} else if (uMaterial == 1) {
		c.a = 1.0;
	} else if (c.a <= 0.0) {
		discard;
	}
	if (uVV > 0.5) {
		// textures and tints are sRGB; light in linear space (the output pass encodes back)
		vec3 base = pow(max(c.rgb, vec3(0.0)), vec3(2.2));
		vec3 col = uMaterial == 3 ? base * uVVLight * uVVAdditive : base * uVVLight + uVVHaze;
		if (uHasMers > 0.5) {
			float e = pow(texture2D(uMers, vUv).g, uVVEmissiveGamma);
			vec3 eb = mix(base, vec3(dot(base, vec3(0.2126, 0.7152, 0.0722))), uVVDesat);
			col += eb * e * uVVEmissive;
		}
		c.rgb = col;
	} else {
		c.rgb *= uLight;
	}
	gl_FragColor = c;
}
`;

/**
 * Picking: which particle covers a pixel. Same quads and the same texel rules as drawing (cutout threshold,
 * blended texels that show), with depth so the front-most wins; the id is written as 24 bits of RGB.
 */
export const pickFragmentShader = /* glsl */ `
precision highp float;
uniform sampler2D uMap;
uniform int uMaterial;
uniform float uAlphaCutoff;
uniform float uBase;              // first id of this batch

varying vec2 vUv;
varying vec4 vColor;
varying float vIndex;

void main() {
	vec4 tex = texture2D(uMap, vUv);
	if (uMaterial == 0) {
		if (tex.a < uAlphaCutoff) discard;
	} else if (uMaterial != 1) {
		if (tex.a * vColor.a < 0.02) discard;
	}
	float id = uBase + floor(vIndex + 0.5) + 1.0;
	float r = mod(id, 256.0);
	float g = mod(floor(id / 256.0), 256.0);
	float b = floor(id / 65536.0);
	gl_FragColor = vec4(r, g, b, 255.0) / 255.0;
}
`;
