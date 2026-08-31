# BLACKSITE

A first-person shooter that runs entirely in the browser. No build step, no
asset downloads, no engine to install — serve the folder and play.

Five modes, three maps, eight weapons, and an AI that uses cover, shares what it
sees with its squad, and takes angles instead of running at you in a line.

**Play it: https://blacksite-fps.onrender.com**

To run it locally instead:

It has to be served rather than opened from disk — browsers refuse to load
JavaScript modules over `file://`. Any static server works, and the page says so
if you try anyway.

**Windows** — double-click `serve.bat`, or:

```powershell
powershell -ExecutionPolicy Bypass -File .\serve.ps1
```

That is a self-contained static server built on the .NET sockets already in
Windows: no Python, no Node, no administrator rights, and it binds to loopback
only. Pass `-Port 8080` if 8931 is taken.

**macOS / Linux** — anything static will do:

```
python3 -m http.server 8931
```

Then open **http://localhost:8931**.

Requires a browser with WebGL 2 (any current Chrome, Edge, Firefox or Safari).

---

## Controls

| | |
|---|---|
| `W A S D` | Move |
| `Shift` | Sprint |
| `Ctrl` / `C` | Crouch |
| `Space` | Jump |
| Mouse 1 / 2 | Fire / aim down sights |
| `R` | Reload |
| `G` | Hold to cook a grenade, release to throw |
| `V` | Quick melee |
| `1` `2` `3` / `Q` / wheel | Weapons |
| `F` | Plant, defuse, interact |
| `T` | Inspect weapon |
| `Tab` | Scoreboard |
| `Esc` | Pause |

Every weapon has a **fixed spray pattern**. The pattern punches your actual view
angles, so bullets follow where the gun has pushed your aim — pull against it and
the shots land where you look. Firing while moving widens the cone; firing in the
air widens it enormously.

## Modes

| Mode | Shape |
|---|---|
| **Team Deathmatch** | Two squads, one score limit, respawns on. |
| **Detonate** | Round-based attack and defend. One life per round, plant and defuse, sides swap at the halfway point. |
| **Domination** | Three zones. Holding them bleeds the enemy score. |
| **Gun Game** | Free-for-all. Every kill promotes you up the weapon ladder; a knife kill knocks your victim back down. |
| **Firefight** | Escalating waves of hostiles. Credits between waves buy permanent upgrades. |

## Maps

| Map | Character |
|---|---|
| **Foundry** | Industrial two-site. Three lanes converge on the plant sites, with a catwalk holding the middle. |
| **Dunes** | Desert compound. A two-storey headquarters owns the centre; long flanking roads reward rifles and the Shrike. |
| **Vault** | Underground bank. A mezzanine ring around a central atrium turns every fight vertical. |

---

## How it works

Everything is generated at runtime. There are no textures, models, or sound
files in the repository — the only dependency is a vendored copy of three.js.

**Surfaces** are synthesised into canvases at load time and turned into albedo,
normal, roughness, metalness and AO maps. Map geometry is authored as boxes and
meshed with world-space planar UVs, so one shared material tiles correctly across
every wall and the whole map draws in a handful of calls.

**Lighting** is physically based, with a sun, a small budget of point lights, and
an authored three-stop gradient for the ambient probe (lighting an interior with
a photographic sky dyes every upward-facing surface blue).

**Post-processing** is a hand-rolled chain rather than `EffectComposer`, so the
pass order is exact: scene → SSAO → progressive-upsample bloom → ACES tonemap,
grade, vignette, chromatic aberration and grain → FXAA.

**Collision** is exact AABB brush intersection with sliding, stair stepping and an
unstick fallback. What you see is what you shoot.

**Navigation** is a grid sampled from the world that also bakes the tactical data
the AI reasons over: per-node cover directions at standing and crouching height,
exposure, and chokepoint scoring. It understands staircases whose treads are
narrower than a nav cell, which a naive voxeliser silently drops.

**The AI** scores a set of candidate actions every few hundred milliseconds
against health, ammunition, cover quality, squad role, contact age and objective
pressure, then commits to the winner. Bots share contacts through a team
blackboard, hand out entry / support / flank / anchor / lurk roles by position,
and pass a single "push token" so one bot takes the first duel instead of five
queueing in a doorway. Aim is turn-rate limited with a drifting error that
converges the longer a target is tracked, imperfect recoil compensation, and
burst discipline that varies by weapon and range. Bots and the player resolve
shots through exactly the same ballistics code.

**Characters and weapons** are assembled from primitives and then baked into a
single skinned or merged mesh, with per-vertex roughness, metalness and emissive
read by a patched standard material — one draw call each instead of forty.

## Layout

```
index.html            entry point and import map
styles/game.css       HUD and menu styling
src/
  core/               loop, input, audio synthesis, settings, math
  render/             renderer, post chain, procedural textures, effects, rig baking
  world/              brush collision, map builder, the three maps
  nav/                navigation grid, A*, cover analysis
  player/             movement, camera, weapon handling
  weapons/            definitions, procedural models, view model, ballistics
  ai/                 agent, perception, squad blackboard, character rig
  modes/              the five game modes
  ui/                 HUD and menus
tools/                map validation, browser smoke tests, screenshot capture
serve.ps1 serve.bat   dependency-free static server for Windows
vendor/three/         pinned three.js r169
```

## Development

```
npm install                 # playwright, for the browser tests only
npm run serve               # http://localhost:8931

npm run check:maps          # geometry, connectivity and spawn safety per map
npm run test:functional     # drives shooting, objectives, respawns and AI, and asserts outcomes
npm run test:smoke          # every mode on every map in a real browser, fails on any console error
npm run shots               # reference screenshots, including a weapon showcase
```

`tools/checkmap.mjs` is worth running after any map edit: it rebuilds the
navigation graph and verifies that every spawn can reach every objective, that no
spawn point is inside geometry, and that no reachable region has been cut off.
