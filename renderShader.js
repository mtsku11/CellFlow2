export function getRenderShaderCode(numParticleTypes, canvasWidth, canvasHeight, particleColors) {
  let colorAssignments = '';
  for (let i = 0; i < numParticleTypes; i++) {
    colorAssignments += `          if (p.ptype == ${i}u) { c = ${particleColors[i]}; }\n`;
  }
  colorAssignments += `          if (p.ptype >= ${numParticleTypes}u) { c = vec3f(1.0, 1.0, 0.0); } // Amarillo para tipos fuera de rango\n`;

  return `
    const GLOW_SPAN: u32 = 11u;
    const GLOW_HALF: f32 = 5.0;
    const VERTS_PER_PARTICLE: u32 = GLOW_SPAN * GLOW_SPAN;

    struct Particle {
      pos: vec2f,
      vel: vec2f,
      acc: vec2f,
      ptype: u32,
      pad: u32
    };

    @group(0) @binding(0) var<storage, read> particles: array<Particle>;

    struct VSOut {
      @builtin(position) pos: vec4f,
      @location(0) color: vec3f,
      @location(1) localOffset: vec2f
    };

    @vertex
    fn vs_main(@builtin(vertex_index) i: u32) -> VSOut {
      // Cada partícula genera una nube de píxeles para glow.
      let particleIndex = i / VERTS_PER_PARTICLE;
      let subIndex = i % VERTS_PER_PARTICLE;
      let p = particles[particleIndex];
      var c = vec3f(0.5); // Gris por defecto
${colorAssignments}

      let ox = f32(i32(subIndex % GLOW_SPAN)) - GLOW_HALF;
      let oy = f32(i32(subIndex / GLOW_SPAN)) - GLOW_HALF;
      let offset = vec2f(ox, oy);

      // Calcular posición con offset
      let pixelPos = p.pos + offset;

      // Validar límites para evitar dibujar fuera del canvas
      var out: VSOut;
      if (pixelPos.x < 0.0 || pixelPos.x >= ${canvasWidth}.0 || pixelPos.y < 0.0 || pixelPos.y >= ${canvasHeight}.0) {
        out.pos = vec4f(0.0, 0.0, -1.0, 1.0); // Fuera de pantalla (no visible)
      } else {
        out.pos = vec4f((pixelPos.x / ${canvasWidth}.0) * 2.0 - 1.0,
                        (pixelPos.y / ${canvasHeight}.0) * -2.0 + 1.0,
                        0.0, 1.0);
      }
      out.color = c;
      out.localOffset = offset;

      return out;
    }

    @fragment
    fn fs_main(in: VSOut) -> @location(0) vec4f {
      let dist = length(in.localOffset) / (GLOW_HALF + 0.0001);
      if (dist > 1.08) {
        discard;
      }
      let halo = pow(max(0.0, 1.0 - dist), 1.9);
      let core = pow(max(0.0, 1.0 - dist), 4.8);
      let alpha = clamp(halo * 0.34 + core * 0.78, 0.0, 1.0);
      let glowColor = in.color * (1.18 + halo * 0.55 + core * 1.15);
      return vec4f(glowColor, alpha);
    }
  `;
}
