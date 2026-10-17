# Wintersky (Bedrock-faithful)

Minecraft Bedrock particle simulation and three.js renderer, modelled on what the game actually
does — evaluation order, shared variable maps, temp leaking, caps and failure modes included.

```ts
import { ParticleWorld } from 'wintersky';
import { ParticleRenderer } from 'wintersky/render';

const world = new ParticleWorld({ seed: 1 });
const def = world.loadEffect(particleJson);
world.spawn(def, { position: [0, 0, 0] });

const renderer = new ParticleRenderer({ textures: (path) => myTextures.get(path) ?? null });
scene.add(renderer.group);

function frame(dt) {
	world.step(dt);            // update pass + render preparation
	renderer.sync(world, camera);
}
```

## What "faithful" means here

- **Phases**: emitter creation (lifetime/rate setup → pre_effect → creation_expression) → emitter
  update (age → activation → per_update → expiration → rate/spawn → timeline/travel events) →
  per-particle update, interleaved per particle (per_update → motion → age → events → expiry) →
  a later render-preparation pass (per_render → size → UV → facing → tint).
- `v.*` is one map per emitter; update→render carry is not per particle.
- `t.*` resets per expression except across an event sequence into a child's pre_effect (temp leaking).
- 10,000 particles per emitter; at the cap new spawns are blocked.
- Particles outlive their emitter and their loop; looping keeps `v.*` and re-rolls emitter randoms.
- Any Molang syntax error fails the whole effect (nothing spawns), as in-game.
- Kill plane is a sign-crossing test; collision is sphere-vs-blocks; Kill/Only-in-blocks use the block at the particle.
- Curves are refreshed per particle at update and render boundaries; nodes may be Molang;
  bezier_chain holds its ends and ignores `horizontal_range`.
- Tint multiplies and is packed `trunc(c * 255)` clamped; negative sizes don't render; a zero UV size samples a sliver.
- Deterministic seeded RNG, snapshots and a halt counter for exact replay / stepping, plus per-particle expression tracing.

Renderer: one instanced draw per emitter, all facing modes in the vertex shader (direction modes per
the Bedrock axis construction with a vertical fallback), blend/additive never write depth, cutouts discard.
