# CellFlow TODO

## Critical

- [x] Fix the preset load ordering bug in `main.js` so voice rebuilds happen when `numParticleTypes` changes.
- [x] Fix the synced-organism scheduler crash caused by the undefined `MOVING_BPM_MIN` reference in `audio/scheduler.js`.
- [x] Add per-color audio diagnostics: `count`, `avgSpeed`, mapped BPM, `mode`, `orgId`.
- [x] Measure real live-sim speed ranges across presets `1` through `8`.
- [x] Re-tune tempo mapping in `audio/scheduler.js` using live measurements (implemented as adaptive speed-window calibration).
- [x] Verify that enabling audio with six colors produces six active sequencers in the live app.

## High Priority

- [x] Add smoothing for per-color tempo updates so motion changes are audible but not jittery.
- [x] Improve gain staging so quieter colors are still perceptible in a six-voice mix.
- [x] Add a visible debug surface in the UI for clock state and organism sync state.
- [x] Re-map low-speed tempo response so near-static particle velocities produce clearly slower sequence rates.
- [x] Add envelope morphing by speed band (slow/mid/fast) so each color's articulation changes audibly with motion.
- [x] Add per-color tremolo/vibrato modulation tied to motion so slow states breathe and fast states warp more aggressively.
- [x] Replace the six current synth instruments with six wav-backed granular engines while preserving existing sequencing, Markov behavior, scheduling, duration scaling, velocity handling, and envelope intent.
- [x] Trim the live granular source assets to short mono excerpts so audio start no longer needs to decode the full 129 MB wav corpus.
- [ ] Validate that each color has a distinct enough source, register, grain behavior, and role in the mix.
- [ ] Confirm the live granular engine no longer drops out after extended playback with all six colors active.
- [ ] Re-test `Audio: Off` startup latency and frame stability on phone/work-laptop hardware after switching to trimmed source assets.
- [ ] Decide whether colors should stay in `synced` mode when `orgBpm` is zero, or fall back to free clocks until the organism is moving again.
- [x] Confirm that free clocks resume cleanly after organism breakup.
- [x] Add a direct output-path diagnostic (`Test Tone`) that bypasses granular voices so silence can be separated into output-routing vs granular-engine causes.
- [ ] Validate the synced-organism rest fallback behavior after the crash fix and decide whether the `BPM_MIN * 0.35` threshold is still the right musical boundary.

## Granular Voice Replacement

- [x] Assign one uploaded wav source to each color voice: `wav/NHU05079160.wav`, `wav/NHU05093004.wav`, `wav/07070189.wav`, `wav/07070190.wav`, `wav/07070191.wav`, and `wav/07074118.wav`.
- [x] Add one-time async sample loading after `Tone.start()` and before voice construction; do not decode samples per note.
- [x] Keep `audio/scheduler.js`, `audio/markov.js`, and sequence constants unchanged during this pass.
- [x] Keep the scheduler-facing API in `audio/voices.js`: `buildVoiceBus`, `setVoiceLevel`, `shapeVoiceForMotion`, and `triggerVoice`.
- [x] Replace `Tone.MonoSynth`, `Tone.FMSynth`, `Tone.PluckSynth`, `Tone.AMSynth`, `Tone.MetalSynth`, and `Tone.Synth` construction with granular voice objects sourced from the wav buffers.
- [x] Implement per-note grain clouds in `triggerVoice(...)` using the scheduler-provided MIDI, duration, time, and velocity values.
- [x] Map MIDI to playback-rate/pitch offset without changing Markov note choices or octave offsets unless a specific sample needs a documented calibration offset.
- [x] Add controlled organic grain variation per color: sample-position jitter, grain-size jitter, inter-grain timing jitter, detune jitter, stereo pan spread, and optional reverse-grain probability.
- [x] Add an initial anti-masking role map per color (scan-zone center/width, stereo center/spread scale, playback-rate bias/jitter, per-color amp trim).
- [x] Move the existing slow/mid/fast motion morph target from synth patching to granular parameters only, such as grain size, density, position travel, detune range, filter brightness, and stereo spread.
- [x] Add a second texture pass that pushes grains further from raw-source playback using octave-up grain pitch bias, shorter effective grains, stronger scan deformation, and higher reverse/detune scatter.
- [x] Add a hard concurrent-grain cap so dense scheduler activity cannot accumulate unbounded transient grain nodes.
- [x] Add a third texture pass with tighter scan windows, shorter grain windows, stronger playback-rate warping, and another octave of grain transposition.
- [x] Add a fourth texture pass that constrains each trigger to a very tight looping scan island with extremely small grains and slow scan drift so the source evolves gradually instead of reading like a recognisable wav excerpt.
- [x] Extend the granular cloud release tails substantially without changing scheduler timing or Markov sequencing behavior.
- [x] Add granular runtime telemetry (`activeGrains`, cap, per-note cap) to the debug surface.
- [x] Add a starvation-mitigation pass to granular triggering (lower per-note layering and shorter per-grain runtime tails) to prevent abrupt post-startup dropouts.
- [x] Add adaptive cloud preemption at the global grain cap so high-speed note triggers can retire the oldest tails instead of silently dropping new grains.
- [x] Make granular loop/runtime and release-tail scaling motion-aware so slow states sustain longer while fast states release quicker to avoid overload.
- [x] Push all granular playback up one additional octave.
- [x] Tighten envelope/runtime further at medium/high motion (shorter loop hold and release under speed) while keeping longer low-speed tails.
- [x] Preserve existing per-voice gain ramps, shared reverb send, limiter, master gain, and startup sanity trigger behavior.
- [x] Dispose transient grain players and all voice-owned Tone nodes on `stop()` and audio rebuild.
- [x] Add lightweight diagnostics or console warnings for failed wav loading so silent instruments are easy to identify.
- [x] Update the live debug panel to distinguish `effective`, `free`, and `org` BPM, and rename the sync exit counter from `x` to `exit`.

## Organism Coupling

- [x] Review `audio/organisms.js` thresholds against the live WebGPU sim instead of the preview.
- [x] Add hysteresis or confidence thresholds for entering synced mode.
- [x] Add hysteresis or decay for leaving synced mode.
- [x] Evaluate whether membership should use strongest contributing organism, nearest organism, or a weighted confidence score.
- [x] Decide whether local density or actual neighbor count should influence sync strength, note velocity, or timbre (both paths prototyped; default remains `cpu_spatial`, optional `gpu_neighbor` mode added for A/B testing).

## Data Quality

- [x] Replace placeholder density estimation in `audio/index.js` with stronger simulation-derived metrics.
- [x] Clamp or robustly filter velocity outliers in long-run telemetry so calibration is less sensitive to rare spikes.
- [x] Stabilize per-color velocity feed so low-count/outlier noise cannot force a single color (e.g. `c4`) into an incorrect high-BPM state.
- [x] Decide whether to extend GPU readback data beyond raw particles (prototype now includes neighbor-count payload readback).
- [x] Check the cost of richer audio metrics against frame rate and readback frequency (`audioBench=1` benchmark path + live perf diagnostics).
- [x] Verify that readback cadence is stable enough for musical responsiveness (no readback stalls observed in benchmark runs at default 4k particles).

## UX

- [ ] Add a graceful non-WebGPU failure message instead of crashing on startup.
- [x] Add `REGEN` behavior to cycle musical key/mode (matching preview intent, but adapted to live sim state).
- [ ] Document what the user should hear when organisms form and dissolve.
- [x] Add a short troubleshooting section for "audio starts but feels weak."

## Validation

- [x] Test the live app with audio on for presets `1` through `8`.
- [x] Test `REGEN`, `RESET`, `reX`, and type-count changes while audio is running.
- [x] Verify that near-static scenes do not leave a single color reporting inflated velocity/BPM (`c4` issue resolved in live test).
- [ ] Add a focused listening test matrix for slow-motion cases to confirm tempo floor behavior is perceptibly slower.
- [ ] Validate that each granular color keeps a unique identity at low, medium, and high speed ranges without changing the existing envelope/scheduling behavior.
- [ ] Validate that grain clouds feel organic rather than looped or machine-gunned at both sparse and dense scheduler rates.
- [ ] Validate that octave-up pitch bias and stronger scan deformation do not make any one voice too brittle or disconnected from the mix.
- [ ] Validate that the tighter scan-island pass and second octave-up shift do not over-homogenize the six voices.
- [ ] Validate that the micro-loop scan-island pass now suppresses recognisable source excerpts across all six wav files.
- [ ] Validate that the much longer granular release tails do not reintroduce dropouts, excessive buildup, or muddiness during dense organism states.
- [x] Add balanced default audio runtime settings after trimmed-source startup exposed steady-state stutter: lower grain cap, shorter grain tails, and slower organism readback cadence.
- [x] Add safe default audio runtime settings after phone/laptop retest still showed visual stalls and audio dropouts: slower summary cadence, much slower organism refresh, frame-stall/readback backoff, quieter scheduler logs, and a lower active-grain cap.
- [ ] Validate that active grain load remains safely below cap in long runs (`Granular active=...`) and that audible continuity is preserved after the startup burst.
- [ ] Re-test steady-state audio on the phone and work laptop with default safe mode; compare against `?audioPerf=balanced` and `?audioPerf=high` only if needed.
- [ ] Validate that high-speed motion no longer enters extended near-silence/dropout due to saturated grain runtime pressure.
- [ ] Validate that medium-speed passages also remain continuous (no partial dropout band between slow and fast regimes).
- [ ] Validate that the new longer slow-speed sustain does not cause muddy buildup during low-motion passages.
- [ ] Validate that the new GPU-summary audio bridge reduces stutter/dropout risk compared with the old full-readback-per-feed path, especially at medium/high motion.
- [ ] Decide whether organism refresh can be thinned further or partially moved to GPU after listening/runtime validation of the summary bridge.
- [ ] If continuity is stable, re-expand texture complexity carefully (scan/rate/reverse) without reintroducing active-grain starvation.
- [ ] Validate the new `free`/`org`/effective BPM diagnostics against observed synced/free clock behavior during organism formation and rest.
- [ ] Verify in-browser that audio bridge failures now surface as explicit console errors for `gpu_summary`, organism refresh, and legacy feed paths.
- [ ] Validate that wav loading, audio start, `STOP`, rebuild on type-count changes, and repeated audio enable/disable do not leak Tone nodes or leave stale grains running.
- [ ] Validate `REGEN` key/mode cycling in live app against `cellflow-audio-preview.html` behavior (post-implementation listening pass).
- [ ] Compare live app behavior directly against `cellflow-audio-preview.html`.
- [ ] Record short before/after clips once the granular voice replacement is implemented so changes can be judged by ear.

## Sound Design Ideas

- [ ] Defer any separate granulated "insect biome" texture layer until the six core granular instruments are implemented and validated; if revisited, keep it strictly ducked under the core color sequencers.

## Visual

- [x] Add a much stronger particle glow treatment with additive blending and a larger per-particle halo footprint.
- [x] Increase glow halo strength again (larger radius + stronger falloff/brightness) so halos are clearly visible around individual particles.
- [x] Reduce the glow halo again after the enlarged version proved visually doubled-up in live reloads.
- [x] Ensure debug-panel failures cannot halt the render loop (frame safety guard around audio debug paint).

## GPU Audio Bridge

- [x] Accumulate per-color particle counts on the GPU during the simulation pass.
- [x] Accumulate per-color summed speed on the GPU during the simulation pass.
- [x] Accumulate per-color neighbor totals on the GPU during the simulation pass.
- [x] Read back the compact per-color audio summary buffer at high cadence instead of full particle state.
- [x] Keep full particle readback only for slower organism refresh while the scheduler remains unchanged.
- [x] Expose a legacy A/B switch (`?audioFeed=legacy`) so the old full-readback path can still be compared during validation.
