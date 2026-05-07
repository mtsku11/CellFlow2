// main.js
import * as GPU from './gpuSetup.js?v=20260507k';
import * as Audio from './audio/index.js?v=20260507k';

const canvas = document.getElementById('canvas');
const numParticlesSlider = document.getElementById('num-particles-slider');
const numParticlesValueSpan = document.getElementById('num-particles-value');
const numTypesSlider = document.getElementById('num-types-slider');
const numTypesValueSpan = document.getElementById('num-types-value');
const radiusSlider = document.getElementById('radius-slider');
const radiusValueSpan = document.getElementById('radius-value');
const deltaTSlider = document.getElementById('delta_t-slider');
const deltaTValueSpan = document.getElementById('delta_t-value');
const frictionSlider = document.getElementById('friction-slider');
const frictionValueSpan = document.getElementById('friction-value');

const repulsionSlider = document.getElementById('repulsion-slider');
const repulsionValueSpan = document.getElementById('repulsion-value');
const attractionSlider = document.getElementById('attraction-slider');
const attractionValueSpan = document.getElementById('attraction-value');
const kSlider = document.getElementById('k-slider');
const kValueSpan = document.getElementById('k-value');

const forceRangeSlider = document.getElementById('force-range-slider');
const forceRangeValueSpan = document.getElementById('force-range-value');
const forceBiasSlider = document.getElementById('force-bias-slider');
const forceBiasValueSpan = document.getElementById('force-bias-value');

const ratioSlider = document.getElementById('ratio-slider');
const ratioValueSpan = document.getElementById('ratio-value');
const lfoASlider = document.getElementById('lfoa-slider');
const lfoAValueSpan = document.getElementById('lfoa-value');
const lfoSSlider = document.getElementById('lfos-slider');
const lfoSValueSpan = document.getElementById('lfos-value');

const forceMultiplierSlider = document.getElementById('force-multiplier-slider');
const forceMultiplierValueSpan = document.getElementById('force-multiplier-value');
const balanceSlider = document.getElementById('balance-slider');
const balanceValueSpan = document.getElementById('balance-value');
const forceOffsetSlider = document.getElementById('force-offset-slider');
const forceOffsetValueSpan = document.getElementById('force-offset-value');

const regenButton = document.getElementById('regen-button');
const resetButton = document.getElementById('reset-button');
const rexButton = document.getElementById('rex-button');

// Variable global para el desplazamiento con las flechas
export let wrappingMovement = 10;

const startBtn = document.getElementById('start-recording');
const stopBtn = document.getElementById('stop-recording');
const downloadBtn = document.getElementById('download-video');

const saveParamsButton = document.getElementById('save-params-button');
const loadParamsButton = document.getElementById('load-params-button');
const loadParamsFile = document.getElementById('load-params-file');


let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let simulationFrameCount = 0;
let lastCaptureTime = 0;
const desiredCaptureInterval = 1000 / 60; // 60 frames per second
let audioDebugPanel = null;
let lastAudioDebugPaint = 0;
const queryParams = new URLSearchParams(window.location.search);
const AUDIO_DENSITY_SOURCE = queryParams.get('audioDensity') === 'gpu_neighbor'
    ? 'gpu_neighbor'
    : 'cpu_spatial';
const AUDIO_BENCHMARK_MODE = queryParams.get('audioBench') === '1';
const AUDIO_FEED_MODE = (queryParams.get('audioFeed') === 'legacy' || AUDIO_BENCHMARK_MODE)
    ? 'legacy'
    : 'gpu_summary';
const benchmarkStats = {
    readbackPlain: { samples: 0, avgMs: 0, lastMs: 0 },
    readbackNeighbor: { samples: 0, avgMs: 0, lastMs: 0 },
    cpuSpatial: { samples: 0, avgMs: 0, lastMs: 0 },
    gpuNeighbor: { samples: 0, avgMs: 0, lastMs: 0 },
};
let benchmarkToggle = 0;

function pushBenchSample(bucket, value) {
    if (!bucket || !Number.isFinite(value)) return;
    bucket.samples += 1;
    bucket.lastMs = value;
    bucket.avgMs += (value - bucket.avgMs) / bucket.samples;
}

function formatBenchValue(value) {
    return Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

document.addEventListener('DOMContentLoaded', async () => {
    await GPU.setupWebGPU('canvas');
    // Cargar preset 1 al iniciar
    try {
        const response = await fetch('presets/1.json');
        if (!response.ok) throw new Error('No se pudo cargar el preset por defecto');
        const params = await response.json();
        applyParams(params);
    } catch (err) {
        alert('Error cargando preset por defecto: ' + err);
    }
    initializeUIValues();
    setupAudioDebugPanel();
    addEventListeners();
    setRecordingUI('stopped');
    requestAnimationFrame(frame);

    // Soporte para cargar presets con teclas 1-8
    document.addEventListener('keydown', async (event) => {
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;
    const key = event.key;
    if (key >= '1' && key <= '8') {
        try {
            const response = await fetch(`presets/${key}.json`);
            if (!response.ok) throw new Error('No se pudo cargar el preset');
            const params = await response.json();
            const typesChanged = applyParams(params);
            // Treat preset load as a regeneration for audio purposes (new key/world).
            if (typesChanged) {
                await Audio.rebuildVoices(GPU.numParticleTypes);
            }
            Audio.onRegen();
        } catch (err) {
            alert('Error cargando preset: ' + err);
        }
        return;
    }
    // Barra espaciadora: regenerar matriz
    if (key === ' ' || key === 'Spacebar') {
        event.preventDefault();
        regenButton.click();
        return;
    }
    // Tecla X: rotar valores de radio
    if (key === 'x' || key === 'X') {
        event.preventDefault();
        rexButton.click();
        return;
    }
    // Flechas del teclado: mover el universo
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
        event.preventDefault();
        GPU.moveUniverse(key);
        return;
    }
    // Tecla C: expandir/contraer menú de controles
    if (key === 'c' || key === 'C') {
        const controlsDiv = document.querySelector('.controls');
        const toggleBtn = controlsDiv.querySelector('button');
        if (toggleBtn) toggleBtn.click();
        return;
    }
    // Tecla D: mostrar/ocultar diagnóstico de audio
    if (key === 'd' || key === 'D') {
        if (audioDebugPanel) {
            audioDebugPanel.style.display = audioDebugPanel.style.display === 'none' ? 'block' : 'none';
        }
        return;
    }
    // Tecla T: tono de diagnóstico (ruta directa, sin granular)
    if (key === 't' || key === 'T') {
        event.preventDefault();
        try {
            await Audio.playDiagnosticTone({ frequency: 392, seconds: 0.9, amplitude: 0.34 });
        } catch (e) {
            console.error('Diagnostic tone failed:', e);
        }
        return;
    }
});
});

function applyParams(params) {
    const prevNumTypes = GPU.numParticleTypes;
    if (typeof params.numParticleTypes === 'number') {
        GPU.setNumParticleTypes(params.numParticleTypes);
        numTypesSlider.value = GPU.numParticleTypes;
        numTypesValueSpan.textContent = GPU.numParticleTypes;
    }
    if (typeof params.radius === 'number') {
        GPU.setRadius(params.radius);
        radiusSlider.value = GPU.radius;
        radiusValueSpan.textContent = GPU.radius.toFixed(1);
    }
    if (typeof params.delta_t === 'number') {
        GPU.setDeltaT(params.delta_t);
        deltaTSlider.value = GPU.delta_t;
        deltaTValueSpan.textContent = GPU.delta_t.toFixed(2);
    }
    if (typeof params.friction === 'number') {
        GPU.setFriction(params.friction);
        frictionSlider.value = GPU.friction;
        frictionValueSpan.textContent = GPU.friction.toFixed(2);
    }
    if (typeof params.repulsion === 'number') {
        GPU.setRepulsion(params.repulsion);
        repulsionSlider.value = GPU.repulsion;
        repulsionValueSpan.textContent = GPU.repulsion.toFixed(2);
    }
    if (typeof params.attraction === 'number') {
        GPU.setAttraction(params.attraction);
        attractionSlider.value = GPU.attraction;
        attractionValueSpan.textContent = GPU.attraction.toFixed(2);
    }
    if (typeof params.k === 'number') {
        GPU.setK(params.k);
        kSlider.value = GPU.k;
        kValueSpan.textContent = GPU.k.toFixed(2);
    }
    if (typeof params.forceRange === 'number') {
        GPU.setForceRange(params.forceRange);
        forceRangeSlider.value = GPU.forceRange;
        forceRangeValueSpan.textContent = GPU.forceRange.toFixed(2);
    }
    if (typeof params.forceBias === 'number') {
        GPU.setForceBias(params.forceBias);
        forceBiasSlider.value = GPU.forceBias;
        forceBiasValueSpan.textContent = GPU.forceBias.toFixed(2);
    }
    if (typeof params.ratio === 'number') {
        GPU.setRatio(params.ratio);
        ratioSlider.value = GPU.ratio;
        ratioValueSpan.textContent = GPU.ratio.toFixed(2);
    }
    if (typeof params.lfoA === 'number') {
        GPU.setLfoA(params.lfoA);
        lfoASlider.value = GPU.lfoA;
        lfoAValueSpan.textContent = GPU.lfoA.toFixed(2);
    }
    if (typeof params.lfoS === 'number') {
        GPU.setLfoS(params.lfoS);
        lfoSSlider.value = GPU.lfoS;
        lfoSValueSpan.textContent = GPU.lfoS.toFixed(2);
    }
    if (typeof params.forceMultiplier === 'number') {
        GPU.setForceMultiplier(params.forceMultiplier);
        forceMultiplierSlider.value = GPU.forceMultiplier;
        forceMultiplierValueSpan.textContent = GPU.forceMultiplier.toFixed(2);
    }
    if (typeof params.balance === 'number') {
        GPU.setBalance(params.balance);
        balanceSlider.value = GPU.balance;
        balanceValueSpan.textContent = GPU.balance.toFixed(3);
    }
    if (typeof params.forceOffset === 'number') {
        GPU.setForceOffset(params.forceOffset);
        forceOffsetSlider.value = GPU.forceOffset;
        forceOffsetValueSpan.textContent = GPU.forceOffset.toFixed(2);
    }
    if (Array.isArray(params.rawForceTableValues)) {
        GPU.setRawForceTableValues(new Float32Array(params.rawForceTableValues));
        GPU.updateForceTable(false);
    }
    if (Array.isArray(params.radioByType)) {
        GPU.setRadioByType(new Float32Array(params.radioByType));
        GPU.initializeRadioByType();
    }
    GPU.createPipelines();
    GPU.updateSimParamsBuffer();
    return GPU.numParticleTypes !== prevNumTypes;
}


function initializeUIValues() {
    numTypesSlider.value = GPU.numParticleTypes;
    numTypesValueSpan.textContent = GPU.numParticleTypes;
    radiusSlider.value = GPU.radius;
    radiusValueSpan.textContent = GPU.radius.toFixed(1);
    deltaTSlider.value = GPU.delta_t;
    deltaTValueSpan.textContent = GPU.delta_t.toFixed(2);
    frictionSlider.value = GPU.friction;
    frictionValueSpan.textContent = GPU.friction.toFixed(2);
    repulsionSlider.value = GPU.repulsion;
    repulsionValueSpan.textContent = GPU.repulsion.toFixed(2);
    attractionSlider.value = GPU.attraction;
    attractionValueSpan.textContent = GPU.attraction.toFixed(2);
    kSlider.value = GPU.k;
    kValueSpan.textContent = GPU.k.toFixed(2);
    forceRangeSlider.value = GPU.forceRange;
    forceRangeValueSpan.textContent = GPU.forceRange.toFixed(2);
    forceBiasSlider.value = GPU.forceBias;
    forceBiasValueSpan.textContent = GPU.forceBias.toFixed(2);
    ratioSlider.value = GPU.ratio;
    ratioValueSpan.textContent = GPU.ratio.toFixed(2);
    lfoASlider.value = GPU.lfoA;
    lfoAValueSpan.textContent = GPU.lfoA.toFixed(2);
    lfoSSlider.value = GPU.lfoS;
    lfoSValueSpan.textContent = GPU.lfoS.toFixed(2);
    forceMultiplierSlider.value = GPU.forceMultiplier;
    forceMultiplierValueSpan.textContent = GPU.forceMultiplier.toFixed(2);
    balanceSlider.value = GPU.balance;
    balanceValueSpan.textContent = GPU.balance.toFixed(3);
    forceOffsetSlider.value = GPU.forceOffset;
    forceOffsetValueSpan.textContent = GPU.forceOffset.toFixed(2);
}

function addEventListeners() {
    // Slider de partículas
    numParticlesSlider.addEventListener('input', (event) => {
    const newCount = parseInt(numParticlesSlider.value);
    numParticlesValueSpan.textContent = newCount;
    GPU.setParticleCount(newCount);
    GPU.initializeParticles();
    GPU.createPipelines();
    GPU.updateSimParamsBuffer();
    canvas.focus();
});
    numTypesSlider.addEventListener('input', (event) => {
    GPU.setNumParticleTypes(parseInt(numTypesSlider.value));
    numTypesValueSpan.textContent = GPU.numParticleTypes;
    GPU.setRawForceTableValues(new Float32Array(GPU.numParticleTypes * GPU.numParticleTypes));
    GPU.updateForceTable(true);
    GPU.initializeRadioByType();
    GPU.initializeParticles();
    GPU.createPipelines();
    GPU.updateSimParamsBuffer();
    Audio.rebuildVoices(GPU.numParticleTypes);
    canvas.focus();
});

    radiusSlider.addEventListener('input', (event) => {
    GPU.setRadius(parseFloat(event.target.value));
    radiusValueSpan.textContent = GPU.radius.toFixed(1);
    GPU.updateSimParamsBuffer();
    canvas.focus();
});

    deltaTSlider.addEventListener('input', (event) => {
    GPU.setDeltaT(parseFloat(event.target.value));
    deltaTValueSpan.textContent = GPU.delta_t.toFixed(2);
    GPU.updateSimParamsBuffer();
    canvas.focus();
});

    frictionSlider.addEventListener('input', (event) => {
    GPU.setFriction(parseFloat(event.target.value));
    frictionValueSpan.textContent = GPU.friction.toFixed(2);
    GPU.updateSimParamsBuffer();
    canvas.focus();
});

    repulsionSlider.addEventListener('input', (event) => {
    GPU.setRepulsion(parseFloat(event.target.value));
    repulsionValueSpan.textContent = GPU.repulsion.toFixed(2);
    GPU.updateSimParamsBuffer();
    canvas.focus();
});

    attractionSlider.addEventListener('input', (event) => {
    GPU.setAttraction(parseFloat(event.target.value));
    attractionValueSpan.textContent = GPU.attraction.toFixed(2);
    GPU.updateSimParamsBuffer();
    canvas.focus();
});

    kSlider.addEventListener('input', (event) => {
    GPU.setK(parseFloat(event.target.value));
    kValueSpan.textContent = GPU.k.toFixed(2);
    GPU.updateSimParamsBuffer();
    canvas.focus();
});

    forceRangeSlider.addEventListener('input', (event) => {
    GPU.setForceRange(parseFloat(event.target.value));
    forceRangeValueSpan.textContent = GPU.forceRange.toFixed(2);
    GPU.updateForceTable();
    GPU.updateSimParamsBuffer();
    canvas.focus();
});

    forceBiasSlider.addEventListener('input', (event) => {
    GPU.setForceBias(parseFloat(event.target.value));
    forceBiasValueSpan.textContent = GPU.forceBias.toFixed(2);
    GPU.updateForceTable();
    GPU.updateSimParamsBuffer();
    canvas.focus();
});

    ratioSlider.addEventListener('input', (event) => {
    GPU.setRatio(parseFloat(event.target.value));
    ratioValueSpan.textContent = GPU.ratio.toFixed(2);
    GPU.updateSimParamsBuffer();
    canvas.focus();
});

    lfoASlider.addEventListener('input', (event) => {
    GPU.setLfoA(parseFloat(event.target.value));
    lfoAValueSpan.textContent = GPU.lfoA.toFixed(2);
    canvas.focus();
});

    lfoSSlider.addEventListener('input', (event) => {
    GPU.setLfoS(parseFloat(event.target.value));
    lfoSValueSpan.textContent = GPU.lfoS.toFixed(2);
    canvas.focus();
});

    forceMultiplierSlider.addEventListener('input', (event) => {
    GPU.setForceMultiplier(parseFloat(event.target.value));
    forceMultiplierValueSpan.textContent = GPU.forceMultiplier.toFixed(2);
    GPU.updateSimParamsBuffer();
    canvas.focus();
});

    balanceSlider.addEventListener('input', (event) => {
    GPU.setBalance(parseFloat(event.target.value));
    balanceValueSpan.textContent = GPU.balance.toFixed(3);
    GPU.updateSimParamsBuffer();
    canvas.focus();
});

    forceOffsetSlider.addEventListener('input', (event) => {
    GPU.setForceOffset(parseFloat(event.target.value));
    forceOffsetValueSpan.textContent = GPU.forceOffset.toFixed(2);
    GPU.updateSimParamsBuffer();
    canvas.focus();
});

    regenButton.addEventListener('click', () => {
        GPU.updateForceTable(true);
        GPU.initializeRadioByType();
        Audio.onRegen();
    });

    rexButton.addEventListener('click', () => {
        // Rotar los valores de radioByType
        const rotatedRadios = new Float32Array(GPU.radioByType.length);
        for (let i = 0; i < GPU.radioByType.length; i++) {
            rotatedRadios[i] = GPU.radioByType[(i + 1) % GPU.radioByType.length];
        }
        GPU.setRadioByType(rotatedRadios);
    });

    resetButton.addEventListener('click', () => {
        GPU.initializeParticles();
    });

    window.addEventListener('resize', () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        GPU.setCanvasDimensions(canvas.width, canvas.height);
        GPU.updateSimParamsBuffer();
        GPU.createPipelines();
    });

    startBtn.addEventListener('click', startRecording);
    stopBtn.addEventListener('click', stopRecording);
    downloadBtn.addEventListener('click', downloadVideo);

    // --- Audio toggle ---
    const audioBtn = document.getElementById('audio-toggle-button');
    if (audioBtn) {
        audioBtn.addEventListener('click', async () => {
            if (Audio.isStarted()) {
                Audio.stop();
                audioBtn.textContent = 'Audio: Off';
                audioBtn.style.background = '#444';
            } else {
                try {
                    await Audio.start(GPU.numParticleTypes);
                    audioBtn.textContent = 'Audio: On';
                    audioBtn.style.background = '#2a6';
                } catch (e) {
                    console.error('Failed to start audio:', e);
                    alert('Failed to start audio: ' + e.message);
                }
            }
        });

        const testToneBtn = document.createElement('button');
        testToneBtn.id = 'audio-test-tone-button';
        testToneBtn.textContent = 'Test Tone';
        testToneBtn.style.background = '#58606b';
        testToneBtn.style.color = '#fff';
        testToneBtn.style.marginLeft = '8px';
        testToneBtn.title = 'Play direct diagnostic tone (shortcut: T)';
        testToneBtn.addEventListener('click', async () => {
            try {
                await Audio.playDiagnosticTone({ frequency: 392, seconds: 0.9, amplitude: 0.34 });
            } catch (e) {
                console.error('Diagnostic tone failed:', e);
                alert('Diagnostic tone failed: ' + e.message);
            }
        });
        if (audioBtn.parentElement) {
            audioBtn.parentElement.appendChild(testToneBtn);
        }
    }

    saveParamsButton.addEventListener('click', () => {
        const params = GPU.getCurrentParams();
        const blob = new Blob([JSON.stringify(params, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'cellflow_params.json';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    });

    loadParamsButton.addEventListener('click', () => {
        loadParamsFile.value = '';
        loadParamsFile.click();
    });

    loadParamsFile.addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async function (e) {
            try {
                const params = JSON.parse(e.target.result);
                const typesChanged = applyParams(params);
                if (typesChanged) {
                    await Audio.rebuildVoices(GPU.numParticleTypes);
                }
            } catch (err) {
                alert('Error loading parameters: ' + err);
            }
        };
        reader.readAsText(file);
    });
}

function frame(currentTime) {
    GPU.updateSimParamsBuffer();
    GPU.renderSimulationFrame();
    try {
        maybeUpdateAudioDebugPanel(currentTime);
    } catch (error) {
        console.warn('Audio debug panel update failed:', error);
    }

    // --- Audio bridge (throttled) ---
    // Default mode reads a tiny GPU-produced summary frequently and only falls
    // back to full particle snapshots at a slower cadence for organism refresh.
    if (Audio.isStarted()) {
        audioFrameCounter++;
        organismFrameCounter++;
        if (AUDIO_FEED_MODE === 'gpu_summary') {
            if (audioFrameCounter >= READBACK_INTERVAL) {
                audioFrameCounter = 0;
                GPU.readAudioSummary().then(summary => {
                    if (!summary) return;
                    Audio.feedGpuSummary(
                        summary,
                        GPU.numParticleTypes,
                        GPU.radius,
                        GPU.canvasWidth,
                        GPU.canvasHeight
                    );
                });
            }
            if (organismFrameCounter >= ORGANISM_READBACK_INTERVAL) {
                organismFrameCounter = 0;
                GPU.readParticles().then(result => {
                    if (!result) return;
                    const floats = new Float32Array(result.buffer);
                    const uints = new Uint32Array(result.buffer);
                    Audio.refreshOrganisms(
                        floats,
                        uints,
                        result.count,
                        GPU.radius,
                        GPU.canvasWidth,
                        GPU.canvasHeight
                    );
                });
            }
        } else if (audioFrameCounter >= READBACK_INTERVAL) {
            audioFrameCounter = 0;
            const benchFlip = AUDIO_BENCHMARK_MODE ? ((benchmarkToggle++ % 2) === 0) : false;
            const includeNeighbors = (AUDIO_DENSITY_SOURCE === 'gpu_neighbor') || benchFlip;
            const readFn = (includeNeighbors && typeof GPU.readParticlesWithNeighborCounts === 'function')
                ? GPU.readParticlesWithNeighborCounts
                : GPU.readParticles;
            readFn().then(result => {
                if (!result) return;
                const floats = new Float32Array(result.buffer);
                const uints = new Uint32Array(result.buffer);
                if (AUDIO_BENCHMARK_MODE) {
                    if (result.neighborCounts) pushBenchSample(benchmarkStats.readbackNeighbor, result.readbackMs || 0);
                    else pushBenchSample(benchmarkStats.readbackPlain, result.readbackMs || 0);
                    const densityBench = Audio.benchmarkDensityEstimators(
                        floats,
                        uints,
                        result.count,
                        GPU.numParticleTypes,
                        GPU.radius,
                        GPU.canvasWidth,
                        GPU.canvasHeight,
                        result.neighborCounts
                    );
                    pushBenchSample(benchmarkStats.cpuSpatial, densityBench.cpuSpatialMs);
                    if (densityBench.gpuNeighborMs != null) {
                        pushBenchSample(benchmarkStats.gpuNeighbor, densityBench.gpuNeighborMs);
                    }
                }
                Audio.feed(
                    floats, uints, result.count,
                    GPU.numParticleTypes, GPU.radius,
                    GPU.canvasWidth, GPU.canvasHeight,
                    {
                        densitySource: AUDIO_DENSITY_SOURCE,
                        neighborCounts: result.neighborCounts,
                        readbackMs: result.readbackMs,
                    }
                );
            });
        }
    }

    if (isRecording) {
        if (!lastCaptureTime) {
            lastCaptureTime = currentTime;
        }

        const elapsed = currentTime - lastCaptureTime;
        if (elapsed >= desiredCaptureInterval) {
            mediaRecorder.requestData();
            lastCaptureTime = currentTime - (elapsed % desiredCaptureInterval);
        }
    }

    requestAnimationFrame(frame);
}

function setupAudioDebugPanel() {
    const panel = document.createElement('pre');
    panel.id = 'audio-debug-panel';
    panel.style.position = 'fixed';
    panel.style.right = '10px';
    panel.style.bottom = '10px';
    panel.style.zIndex = '1000';
    panel.style.margin = '0';
    panel.style.padding = '10px 12px';
    panel.style.maxWidth = '460px';
    panel.style.maxHeight = '45vh';
    panel.style.overflow = 'auto';
    panel.style.whiteSpace = 'pre-wrap';
    panel.style.font = '12px/1.4 Menlo, Consolas, monospace';
    panel.style.color = '#b7ffd0';
    panel.style.background = 'rgba(8, 14, 12, 0.82)';
    panel.style.border = '1px solid rgba(120, 230, 175, 0.35)';
    panel.style.borderRadius = '8px';
    panel.style.pointerEvents = 'none';
    panel.textContent = 'Audio Debug: waiting for audio start (press D to hide/show)';
    document.body.appendChild(panel);
    audioDebugPanel = panel;
}

function maybeUpdateAudioDebugPanel(now) {
    if (!audioDebugPanel) return;
    if (now - lastAudioDebugPaint < 180) return;
    lastAudioDebugPaint = now;
    const debug = Audio.getDebugState ? Audio.getDebugState() : null;
    if (!debug) {
        audioDebugPanel.textContent = 'Audio Debug: unavailable';
        return;
    }
    if (!debug.started) {
        audioDebugPanel.textContent = 'Audio Debug: audio off\nPress Audio: Off button to start\nPress T or Test Tone to verify output path';
        return;
    }
    const s = debug.scheduler;
    if (!s) {
        audioDebugPanel.textContent = `Audio Debug: starting...\nfeeds=${debug.feedCount}`;
        return;
    }
    const lines = [];
    lines.push(`Audio ON | feeds=${debug.feedCount} | colors=${debug.numColors}`);
    const ctxState = debug.audioContextState || 'unknown';
    const toneCount = Number.isFinite(debug.diagnosticToneCount) ? debug.diagnosticToneCount : 0;
    const toneAgeMs = Number.isFinite(debug.lastDiagnosticToneAt) && debug.lastDiagnosticToneAt > 0
        ? Math.max(0, performance.now() - debug.lastDiagnosticToneAt)
        : null;
    const toneAgeLabel = toneAgeMs == null ? 'n/a' : `${(toneAgeMs / 1000).toFixed(1)}s`;
    lines.push(`AudioContext=${ctxState} | testTone=${toneCount} | toneAge=${toneAgeLabel}`);
    if (debug.granular) {
        const activeGrains = Number.isFinite(debug.granular.activeGrains) ? debug.granular.activeGrains : 0;
        const maxGrains = Number.isFinite(debug.granular.maxActiveGrains) ? debug.granular.maxActiveGrains : 0;
        const perNote = Number.isFinite(debug.granular.maxGrainsPerNote) ? debug.granular.maxGrainsPerNote : 0;
        lines.push(`Granular active=${activeGrains}/${maxGrains} perNote<=${perNote}`);
    }
    if (debug.currentKey) {
        lines.push(`Key: ${debug.currentKey.rootMidi} ${debug.currentKey.scaleName} | regen=${debug.regenCount || 0}`);
    }
    lines.push(`Audio bridge: ${AUDIO_FEED_MODE} | density: ${debug.perf?.densitySource || AUDIO_DENSITY_SOURCE}${AUDIO_BENCHMARK_MODE ? ' (bench)' : ''}`);
    const globalAvgSpeed = Number.isFinite(s.globalAvgSpeed) ? s.globalAvgSpeed : 0;
    const globalBpm = Number.isFinite(s.globalBpm) ? s.globalBpm : 0;
    const speedFloor = Number.isFinite(s.speedFloor) ? s.speedFloor : 0;
    const speedCeil = Number.isFinite(s.speedCeil) ? s.speedCeil : 0;
    lines.push(
        `Global speed avg=${globalAvgSpeed.toFixed(2)} ` +
        `bpm=${globalBpm.toFixed(1)} ` +
        `window=[${speedFloor.toFixed(2)}, ${speedCeil.toFixed(2)}]`
    );
    if (debug.perf) {
        const readbackLast = Number.isFinite(debug.perf.lastReadbackMs) ? debug.perf.lastReadbackMs : 0;
        const readbackAvg = Number.isFinite(debug.perf.avgReadbackMs) ? debug.perf.avgReadbackMs : 0;
        const densityLast = Number.isFinite(debug.perf.lastDensityMs) ? debug.perf.lastDensityMs : 0;
        const densityAvg = Number.isFinite(debug.perf.avgDensityMs) ? debug.perf.avgDensityMs : 0;
        const feedLast = Number.isFinite(debug.perf.lastFeedMs) ? debug.perf.lastFeedMs : 0;
        const feedAvg = Number.isFinite(debug.perf.avgFeedMs) ? debug.perf.avgFeedMs : 0;
        lines.push(
            `Perf readback=${readbackLast.toFixed(2)}/${readbackAvg.toFixed(2)}ms ` +
            `density=${densityLast.toFixed(2)}/${densityAvg.toFixed(2)}ms ` +
            `feed=${feedLast.toFixed(2)}/${feedAvg.toFixed(2)}ms`
        );
    }
    if (AUDIO_BENCHMARK_MODE) {
        lines.push(
            `Bench rb plain=${formatBenchValue(benchmarkStats.readbackPlain.avgMs)}ms ` +
            `(n=${benchmarkStats.readbackPlain.samples}) | rb+neighbors=${formatBenchValue(benchmarkStats.readbackNeighbor.avgMs)}ms ` +
            `(n=${benchmarkStats.readbackNeighbor.samples})`
        );
        lines.push(
            `Bench density cpu=${formatBenchValue(benchmarkStats.cpuSpatial.avgMs)}ms ` +
            `(n=${benchmarkStats.cpuSpatial.samples}) | gpu-neighbor=${formatBenchValue(benchmarkStats.gpuNeighbor.avgMs)}ms ` +
            `(n=${benchmarkStats.gpuNeighbor.samples})`
        );
    }
    const minSeen = Number.isFinite(debug.speedRange.minAvgSpeed) ? debug.speedRange.minAvgSpeed.toFixed(2) : 'n/a';
    const maxSeen = Number.isFinite(debug.speedRange.maxAvgSpeed) ? debug.speedRange.maxAvgSpeed.toFixed(2) : 'n/a';
    lines.push(`Observed avgSpeed range: ${minSeen} -> ${maxSeen}`);
    lines.push('Colors:');
    for (const c of Array.isArray(s.colors) ? s.colors : []) {
        const bpmDisplay = Number.isFinite(c.effectiveBpm) ? c.effectiveBpm
            : (Number.isFinite(c.smoothedBpm) ? c.smoothedBpm : 0);
        const bpmValue = Number.isFinite(bpmDisplay) ? bpmDisplay : 0;
        const freeBpm = Number.isFinite(c.freeBpm) ? c.freeBpm : bpmValue;
        const orgBpm = Number.isFinite(c.orgBpm) ? c.orgBpm : 0;
        const velDisplay = Number.isFinite(c.vel) ? c.vel : 0;
        const membershipDisplay = Number.isFinite(c.membershipScore) ? c.membershipScore : 0;
        const exitDisplay = Number.isFinite(c.exitTicks) ? c.exitTicks : 0;
        const noteDisplay = Number.isFinite(c.notesTriggered) ? c.notesTriggered : 0;
        const bpmLabel = c.orgId != null
            ? `bpm=${bpmValue.toFixed(1)} free=${freeBpm.toFixed(1)} org=${orgBpm.toFixed(1)}`
            : `bpm=${bpmValue.toFixed(1)} free=${freeBpm.toFixed(1)}`;
        lines.push(
            `c${c.idx} ${c.mode}${c.orgId != null ? `#${c.orgId}` : ''} ` +
            `n=${c.count} v=${velDisplay.toFixed(2)} ${bpmLabel} ` +
            `m=${membershipDisplay.toFixed(2)} exit=${exitDisplay} ` +
            `notes=${noteDisplay}`
        );
    }
    lines.push(`Organisms active: ${Array.isArray(s.organisms) ? s.organisms.length : 0}`);
    audioDebugPanel.textContent = lines.join('\n');
}

// --- Audio readback throttling ---
// At ~60fps a value of 4 gives ~15Hz summary updates, while organisms refresh
// more slowly because they still require a full particle snapshot.
const READBACK_INTERVAL = 4;
let audioFrameCounter = 0;
const ORGANISM_READBACK_INTERVAL = 24;
let organismFrameCounter = 0;

function setRecordingUI(state) {
    startBtn.disabled = state === 'recording';
    stopBtn.disabled = state !== 'recording';
    downloadBtn.disabled = recordedChunks.length === 0;
}

function startRecording() {
    if (isRecording) return;
    recordedChunks = [];
    lastCaptureTime = 0; // Reset capture time
    const stream = canvas.captureStream(); // No need to specify FPS here
    mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'video/webm; codecs=vp9',
        videoBitsPerSecond: 15000000
    });

    mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) {
            recordedChunks.push(e.data);
        }
    };
    mediaRecorder.onstop = () => {
        setRecordingUI('stopped');
    };

    mediaRecorder.start(desiredCaptureInterval); // Capture data every desiredCaptureInterval (e.g., 16.67ms for 60fps)
    isRecording = true;
    setRecordingUI('recording');
}

function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    mediaRecorder.stop();
    setRecordingUI('stopped');
}

function downloadVideo() {
    if (!recordedChunks.length) return;
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = 'simulation.webm';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 100);
}
