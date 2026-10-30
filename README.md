# Tall Order

A physics stacking game where every piece is a 3D model I generated with [Vi3W](https://app.vi3w.in).
Drop a rubber duck, an anvil and a potted cactus onto a wobbly pedestal and build the tallest tower
you can before three pieces hit the floor.

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ — deploys anywhere (base path is relative)
```

## How to play

| | Desktop | Touch |
|---|---|---|
| Move the piece | mouse | drag |
| Drop | click / Space | **DROP** |
| Spin | Q / E / mouse wheel | ↻ |
| Tip over | R / F | ⤵ |
| Orbit camera | A / D | ⟲ ⟳ |
| Show physics colliders | H | Colliders |

Every metre gets a chime. After 2.5 m, gusts of wind start pushing the top of the tower.
Three dropped pieces ends the run, and your best height is saved.

## Why these models

Stacking only works if the *shape* of each object matters, so I picked three objects that behave very differently:

- **Rubber duck**: light, round and slippery. Fine on top, useless underneath.
- **Anvil**: very heavy, with a flat working face. A great base, but it crushes or knocks off whatever it lands on.
- **Potted cactus**: tall, with arms that snag other pieces. You can stand it upright in its pot or lay it down.

## Vi3W workflow

Each model went through Vi3W's three-step pipeline. The in-game **Made with Vi3W** screen shows all three
stages side by side for every model, along with its triangle count and collider breakdown.

1. **Sketch**: a hand-drawn line sketch on the Vi3W canvas (`public/models/sketches/*-sketch.png`).
2. **Image Gen** (Nano Banana): the sketch plus a short prompt (the prompts are in `public/models/manifest.json`).
3. **3D Gen** (Trellis, Fast): image to textured GLB, downloaded into `raw/`.

The free plan includes 100 XP. An image costs 10 XP and a Trellis model 20 XP, so three models used 90 XP.

## From Vi3W GLB to game piece

| Step | Where | Why |
|---|---|---|
| `gltf-transform optimize` (meshopt + WebP 1024) | `scripts/optimize-models.sh` | 4.6 MB of raw GLBs → 280 KB |
| Override PBR material | `src/models.js` | Trellis leaves out `metallicFactor`, which glTF defaults to **1**, so everything rendered as dark chrome |
| Compute normals | `src/models.js` | the exports have none |
| Strip floating debris | `removeDebris()` | the cactus came with a detached 1.5k-triangle slab hovering beside the pot; parts outside the main body are dropped |
| Normalise scale and centre | `preparePiece()` | each manifest entry sets its size in metres |
| **Compound convex colliders** | `kmeans()` + Rapier `convexHull` | one hull per k-means cluster of surface points (duck 3, anvil 4, cactus 5), each reduced to 80 extreme points |

The last step is what makes the game work. A single convex hull would wrap the cactus arms or the anvil's waist
in an invisible blob. Clustering the mesh's own vertices and building one hull per cluster keeps the
concave shape, so pieces snag, rock and balance the way they look. Press **H** in game, or open the gallery
and choose *Show colliders*, to see them.

## Tech

- [three.js](https://threejs.org) for rendering, with a RoomEnvironment for reflections and soft shadows
- [Rapier](https://rapier.rs) (WASM) for physics: CCD, collision events for impact sounds, fixed 60 Hz step with slow motion on collapses
- Vite for builds. All sound is synthesised with WebAudio, so the game ships no audio files.

```
src/main.js      game loop, input, camera, rules
src/models.js    GLB loading, clean-up, normalisation, collider generation
src/gallery.js   "Made with Vi3W" turntable
src/audio.js     synthesised SFX
public/models/   optimised GLBs, manifest, sketches and generated images
raw/             untouched Vi3W exports
```

## Notes on Vi3W

- Sketch → image → 3D took about a minute per model, and the textured Trellis output was game-ready apart from the issues above.
- An "export for games" preset would help: setting `metallicFactor: 0`, including normals and removing loose parts would cover everything I had to fix by hand.
- Exporting several objects from one generation would make building an asset set cheaper.
