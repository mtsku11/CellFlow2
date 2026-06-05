# CellFlow 2

CellFlow 2 is a WebGPU particle-life instrument with a browser audio engine driven by the live simulation state. The visual system, organism sync behavior, Markov note generation, and granular sample playback are intended to feel like one coupled audiovisual system rather than separate layers.

## Current State

- Particle simulation runs on WebGPU compute.
- Particle rendering runs on WebGPU with additive halo rendering.
- Audio uses six short wav-backed granular instruments from `wav/trimmed/`, while the original long-form corpus remains in `wav/`.
- Sequences and Markov behavior are preserved while the source engine has been replaced with granular playback. Organism membership now applies soft clock attraction instead of forcing hard shared clocks.
- The simulation-to-audio bridge now has a first GPU-offload pass: per-color counts, summed speed, and neighbor totals are accumulated on the GPU and read back as a compact summary buffer for frequent audio updates.
- Full particle readback is now reserved for much slower organism refresh, with minimum gaps and in-flight guards so readback work cannot stack up while audio is enabled.

## Project Layout

- `main.js`: app bootstrap, UI wiring, frame loop, and audio bridge scheduling.
- `gpuSetup.js`: WebGPU setup, compute/render pipelines, readback paths, and particle buffers.
- `simShader.js`: simulation compute shader.
- `renderShader.js`: particle halo render shader.
- `audio/index.js`: audio engine entrypoint and simulation-to-audio adapter.
- `audio/scheduler.js`: drifting per-color clocks, soft organism attraction, probabilistic rests, and note triggering.
- `audio/voices.js`: six granular wav-backed voices.
- `audio/organisms.js`: CPU organism detection and stable ID tracking.
- `PLAN.md`: working plan and implementation history.
- `TODO.md`: backlog and validation checklist.

## Running Locally

Serve the folder over HTTP and open `http://127.0.0.1:8080/`.

Example:

```bash
python3 -m http.server 8080 --bind 127.0.0.1
```

Audio is browser-gated. Click `Audio: Off` to start the audio engine. Use `Test Tone` or press `T` to verify the direct output path.

## Controls

- `Audio: Off`: starts or stops the browser audio engine.
- `Test Tone`: verifies audio output without the granular engine.
- `REGEN`: regenerates the world and advances the musical key/mode cycle.
- `RESET`: resets the particle distribution.
- `reX`: rotates the type-radius modulation state.
- `1` through `8`: load presets.
- `D`: toggle the audio debug panel.
- `T`: play the diagnostic tone.

## Audio Notes

- Six voices are sourced from 6-second mono excerpts in `wav/trimmed/`.
- The trimmed live set is roughly 1.7 MB total instead of loading the full 129 MB source corpus on audio start.
- Granular playback is intentionally extreme: very small grains, tight looping scan islands, slow scan drift, strong pitch lift, and motion-aware runtime/release behavior.
- Default safe mode now uses one persistent granular player per color instead of creating and disposing transient Tone nodes on every note. It also uses slower summary reads, very sparse full organism snapshots, and overlapping-readback guards to reduce steady-state visual stalls and audio dropouts on weaker devices.
- `?audioPerf=balanced` and `?audioPerf=high` still use the heavier transient cloud engine for A/B testing and higher-texture checks.
- The current main performance risk is no longer the core WebGPU simulation. It is the remaining CPU-side work around full-particle organism snapshots under heavier organism states.

## Debugging

The on-screen audio panel reports:

- `Audio bridge`: current simulation-to-audio feed mode.
- `Perf readback`: GPU-to-CPU summary or particle readback timing.
- `Granular active`: live grain load against the current cap, plus `mode=persistent` or `mode=cloud`.
- Per-color `bpm`, `free`, `org`, `sync`, and `drift` values.

Useful query parameters:

- `?audioBench=1`: enable the older benchmark path and extra timing output.
- `?audioFeed=legacy`: force the older full-readback-per-feed audio path for A/B comparison.
- `?audioDensity=gpu_neighbor`: use neighbor-count density mode where applicable.
- `?audioPerf=balanced`: restore the previous balanced cadence for A/B testing.
- `?audioPerf=high`: restore the earlier faster readback cadence for A/B testing.
- `?audioDiag=1`: enable periodic scheduler console logs. Logs are off by default to reduce runtime overhead.
- Default audio performance mode is `safe`, which uses slower GPU summary readbacks, much slower full organism snapshots, frame-stall backoff, lower scheduler density, soft organism clock attraction, and persistent per-color granular players for phones and weaker laptops.

## Known Next Work

- Validate that medium/high-motion audio continuity is improved under the new GPU-summary bridge.
- Validate that audio-enable latency and steady-state frame stability are improved on weaker devices after switching to trimmed source assets and safe audio runtime defaults.
- Validate the June 5 safe-mode pass on weaker hardware and decide whether organism refresh should also move partly to GPU.
- Continue textural tuning so the wav sources are heard more as evolving granular matter and less as recognizable source excerpts.
