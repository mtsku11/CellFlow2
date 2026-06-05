# CellFlow Agent Guide

## Project Purpose

CellFlow is a WebGPU particle simulation with a Tone.js audio layer. The current direction is to stabilize the live audiovisual instrument first: keep the simulation visually consistent, keep six colors audibly distinct, preserve independent color clocks with soft organism attraction, and make the simulation-to-audio bridge observable enough that timing and coupling bugs can be diagnosed quickly.

## Key Commands

- Run locally over HTTP: `python3 -m http.server 8080 --bind 127.0.0.1`
- Open app: `http://127.0.0.1:8080/`
- No automated test suite is currently checked in. Validate browser-visible changes in a WebGPU-capable browser and use the in-app audio diagnostics.

## Important Paths

- `index.html`: module entrypoint and UI shell.
- `main.js`: startup, UI event wiring, frame loop, preset loading, and audio bridge scheduling.
- `gpuSetup.js`: WebGPU device setup, simulation/render pipelines, and readback helpers.
- `audio/index.js`: audio lifecycle, GPU-summary feed adapter, organism refresh handoff, and diagnostics state.
- `audio/scheduler.js`: drifting per-color clocks, soft organism attraction, sync hysteresis, and note scheduling.
- `audio/voices.js`: granular voice engine, wav loading/cache, shared bus, and runtime caps.
- `audio/organisms.js`: CPU organism clustering and stable ID matching.
- `README.md`: operator-oriented run/debug notes and query-parameter switches.
- `PLAN.md`: current direction, completed phases, and next execution order.
- `TODO.md`: live backlog and validation checklist.

## Product Intent

The intended audio behavior is:

- Each particle color owns one sequencer.
- Each sequencer uses its own Markov melody personality.
- Each sequencer uses a distinct voice so six colors means six clearly different musical lines.
- Each color's sequence speed follows that color's average particle velocity.
- When colors merge into an organism, the colors inside that organism should audibly converge without fully snapping to a rigid shared clock.
- Organism sync should feel like an emergent consequence of the simulation rather than an arbitrary music system layered on top.

## Current Architecture

- `index.html`: main UI and app shell.
- `main.js`: app bootstrap, UI wiring, render loop, audio feed trigger.
- `gpuSetup.js`: WebGPU simulation, render pipeline, particle readback.
- `audio/index.js`: audio entrypoint and feed adapter from particle data to scheduler.
- `audio/scheduler.js`: per-color drifting clocks with soft per-organism tempo attraction.
- `audio/markov.js`: melodic Markov chains per color.
- `audio/voices.js`: voice design and output bus.
- `audio/organisms.js`: organism detection and stable ID matching.
- `cellflow-audio-preview.html`: earlier standalone audio prototype and useful behavior reference.
- `wav/`: tracked binary corpus (~130MB of WAVs). Treat filenames as the public surface — don't read these files into context.

## Verified Findings

- The browser audio path is alive. Tone starts and the app logs normal startup.
- The current live app is not musically well-coupled to the simulation.
- The scheduler no longer uses a fixed low-speed floor; `audio/scheduler.js` now adapts its speed window to live data so velocity-to-tempo mapping stays expressive across presets.
- The default audio path now feeds the scheduler from a compact GPU summary in `audio/index.js`, while full particle readback is reserved for much slower organism refresh with in-flight guards.
- Organism sync now exists as soft attraction with `syncStrength` and per-color `drift`; it still needs listening validation to confirm that convergence feels causally tied to visible clustering without becoming too clocked.
- Preset loading and file-loaded parameter changes now rebuild voices when `numParticleTypes` changes.
- The preview file contains useful reference behavior, diagnostics, and bootstrapping ideas, but it is a prototype, not a source of truth.

## Constraints

- Preserve the existing visual behavior unless a change is required for stronger AV coupling.
- Treat `cellflow-audio-preview.html` as reference material, not production code to copy blindly.
- Prefer making the live app observable before rewriting core audio logic.
- Keep the mapping explainable: each audible behavior should have a clear simulation-side cause.
- Test in a browser with WebGPU support. A static file open is not enough because presets and modules depend on HTTP serving.

## Documentation Discipline

- After each build completion, update `PLAN.md` and `TODO.md` in the same working pass.
- After each phase completion, update `PLAN.md` and `TODO.md` again to reflect the new project state.
- In `PLAN.md`, mark what was completed and what phase objectives are next.
- In `TODO.md`, check off completed items, add new follow-up tasks discovered during the build, and reorder remaining priorities if needed.
- Treat these updates as required deliverables, not optional cleanup.

## Context Management

- Prefer file querying over conversation history when rebuilding context.
- Treat repository files as the source of truth, especially `AGENTS.md`, `PLAN.md`, and `TODO.md`.
- At the start of each new work pass, re-read the relevant files instead of assuming prior chat context is still available.
- Assume conversation compaction can remove important details; recover state from files first.

## Engineering Rules

- Preserve existing visual behavior unless a change is required for stronger AV coupling.
- Treat `cellflow-audio-preview.html` as reference material, not production code to copy blindly.
- Prefer making the live app observable before rewriting core audio logic.
- Keep the mapping explainable: each audible behavior should have a clear simulation-side cause.
- Do not read `wav/` contents into context unless a task explicitly requires inspecting filenames; treat the directory as a binary asset surface.
- Test in a browser with WebGPU support. A static file open is not enough because presets and modules depend on HTTP serving.
- If Markdown docs disagree with implementation, update the docs in the same pass.

## MCP usage

- For visible/audible behavior changes, verify with Playwright MCP — check console errors, confirm WebGPU pipeline init succeeds, audio bus comes up cleanly.
- Use Context7 for current WebGPU spec, Tone.js API, or any browser audio details before retuning the simulation-to-audio bridge.

## Subagent usage

For non-trivial changes:
1. Use `code_mapper` to locate relevant files, architecture paths, and implementation points before editing.
2. Use `docs_researcher` when external libraries, framework APIs, OpenAI APIs, build tooling, or config formats are involved (WebGPU spec, Tone.js, Web Audio).
3. Let the main agent perform edits.
4. Use `reviewer` to review the final diff before committing.
5. Use `test_triage` for failing tests/build/lint output before making speculative fixes.

For browser-visible changes, use `frontend_tester` with Playwright MCP to verify the affected route/component and check console errors. Confirm WebGPU pipeline init succeeds and audio bus comes up cleanly.

**Subagents must not read `wav/` into context unless explicitly instructed for a specific task.** The 130MB binary corpus is intentionally tracked — filenames are sufficient context for almost all work.

Keep subagent outputs concise. Do not run multiple write-capable agents against overlapping files.

## Recommended Working Order

1. Measure the live app before changing mappings.
2. Fix correctness issues that block intended behavior.
3. Calibrate the current architecture so six colors reliably produce six audible lines.
4. Strengthen organism detection and sync transitions.
5. Only then refine timbre, mix, and polish.

## Context-Loading Order

1. `AGENTS.md`
2. `PLAN.md`
3. `TODO.md`
4. `README.md`
5. The specific files implicated by the task, located first with `rg`

## Success Criteria

- With six colors active, the user can clearly hear six distinct musical roles.
- Speed changes in a single color produce an obvious tempo response in that color's line.
- Organism formation causes those colors to audibly converge within a short and predictable window while retaining individual drift.
- Organism breakup causes a smooth return to fully independent clocks.
- The sound remains stable and intentional across presets, regen, reset, and type-count changes.
