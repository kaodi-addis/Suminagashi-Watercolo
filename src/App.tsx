import React, { useState, useEffect, useRef } from 'react';
import { 
  RefreshCw, 
  Play, 
  Pause, 
  Info, 
  Settings,
  HelpCircle
} from 'lucide-react';

// ==========================================
// SHADER SOURCE CODE
// ==========================================

const VERTEX_SHADER_SOURCE = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const SIMULATION_FRAG_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_prev_tex;
uniform float u_time;

uniform vec2 u_brush_pos;
uniform vec2 u_brush_prev_pos;
uniform float u_brush_radius;
uniform vec4 u_brush_color;
uniform float u_brush_pressure;
uniform float u_brush_dryness;

uniform float u_clear_fade; // Increments to clear or wash out
uniform vec4 u_diffusion_rates;

// Mouse displacement triggers water currents
uniform vec2 u_mouse_pos;
uniform vec2 u_mouse_dir;
uniform float u_mouse_speed;

in vec2 v_uv;
out vec4 fragColor;

// 2D Hash
float hash2d(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// 2D Noise
float noise2d(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2d(i + vec2(0.0, 0.0)), hash2d(i + vec2(1.0, 0.0)), u.x),
             mix(hash2d(i + vec2(0.0, 1.0)), hash2d(i + vec2(1.0, 1.0)), u.x), u.y);
}

// Distance to a line segment for seamless calligraphic strokes
float distToSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  vec2 uv = v_uv;
  
  // 1. Water flow/turbulence
  // Create an organic fluid drift (faint gravity and natural swirling currents)
  float flowSpeed = 0.0003;
  vec2 noiseCoord = uv * 3.8 + vec2(u_time * 0.05);
  float n1 = noise2d(noiseCoord);
  float n2 = noise2d(noiseCoord + vec2(43.7, 88.1));
  vec2 turbulence = vec2(sin(n1 * 6.28318 + u_time * 0.1), cos(n2 * 6.28318 - u_time * 0.08)) * flowSpeed;
  
  // Add slow, downward water-soaking gravity drift
  vec2 gravityDrift = vec2(0.0, -0.00004);
  
  // Add interactive mouse water current ripples
  float mDist = distance(uv, u_mouse_pos);
  if (mDist < 0.20 && u_mouse_speed > 0.0005) {
    float strength = smoothstep(0.20, 0.008, mDist);
    // Push the liquid along mouse trajectory coordinates
    vec2 pushForce = u_mouse_dir * strength * u_mouse_speed * 1.8;
    turbulence += pushForce;
  }
  
  // Track coordinate backwards along velocity field
  vec2 advected_uv = clamp(uv - turbulence - gravityDrift, 0.0, 1.0);
  
  // Read previous paint state
  vec4 current = texture(u_prev_tex, advected_uv);
  
  // 2. Watercolor Ink Diffusion
  // Calculate Laplacian coordinates using a 4-tap box filter
  vec2 eps = vec2(1.0 / 1024.0); // Fluid sim buffer resolution is fixed at 1024x1024
  vec4 neighbors = (
    texture(u_prev_tex, clamp(advected_uv + vec2(1.0, 0.0) * eps, 0.0, 1.0)) +
    texture(u_prev_tex, clamp(advected_uv + vec2(-1.0, 0.0) * eps, 0.0, 1.0)) +
    texture(u_prev_tex, clamp(advected_uv + vec2(0.0, 1.0) * eps, 0.0, 1.0)) +
    texture(u_prev_tex, clamp(advected_uv + vec2(0.0, -1.0) * eps, 0.0, 1.0))
  ) * 0.25;
  
  // Diffuse channels independently based on mineral weight settings
  vec4 next_state = mix(current, neighbors, u_diffusion_rates);
  
  // 3. Ink Injection via User Brush or Auto-paint
  float d = distToSegment(uv, u_brush_prev_pos, u_brush_pos);
  if (d < u_brush_radius) {
    // Beautiful feathered profile
    float brushIntensity = smoothstep(u_brush_radius, u_brush_radius * 0.15, d);
    
    // Sumi-e styled dry-brush skip/breakup:
    // When the brush moves fast or has low flow, it skips over the paper's deep recesses.
    float paperSkipRandom = noise2d(uv * 180.0 + sin(u_time * 0.5));
    float dryBlend = mix(1.0, paperSkipRandom, u_brush_dryness);
    
    // Accumulate sum of pigment density
    vec4 addedInk = u_brush_color * brushIntensity * u_brush_pressure * dryBlend * 1.6;
    next_state = clamp(next_state + addedInk, 0.0, 2.0);
  }
  
  // Washing wash effect (fading previous layers)
  if (u_clear_fade > 0.0) {
    next_state *= (1.0 - u_clear_fade);
  }
  
  fragColor = clamp(next_state, 0.0, 2.0);
}
`;

const PRESENTATION_FRAG_SOURCE = `#version 300 es
precision highp float;

uniform sampler2D u_sim_tex;
uniform float u_time;
uniform vec2 u_res;
uniform float u_dark_mode; // Lerps between 0 (Paper) and 1 (Dark Gallery)

in vec2 v_uv;
out vec4 fragColor;

// 2D Hash
float hash2d(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// 2D Noise
float noise2d(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2d(i + vec2(0.0, 0.0)), hash2d(i + vec2(1.0, 0.0)), u.x),
             mix(hash2d(i + vec2(0.0, 1.0)), hash2d(i + vec2(1.0, 1.0)), u.x), u.y);
}

// Procedural Washi Paper Raw Fibers
float get_fiber(vec2 uv) {
  vec2 p = uv * 320.0;
  float n1 = noise2d(p);
  float n2 = noise2d(p * 2.0 + vec2(15.2, 37.4));
  
  // Swirling long mulberry paper strands
  float rawStrandA = sin(p.x * 0.45 + sin(p.y * 0.75) * 4.8 + n1 * 3.5);
  float rawStrandB = cos(p.y * 0.55 + cos(p.x * 0.85) * 4.8 + n2 * 3.5);
  
  return smoothstep(0.952, 1.0, sin(rawStrandA + rawStrandB));
}

void main() {
  vec2 uv = v_uv;
  
  // 1. Core Canvas Background Colors
  // Elegant Handmade Ivory Washi: #f4f0e7
  vec3 ivoryPaper = vec3(0.957, 0.941, 0.906);
  
  // Premium Museum Gallery Deep Forest Moss: #0a130d
  vec3 darkGreenPaper = vec3(0.039, 0.075, 0.051);
  
  vec3 bg_color = mix(ivoryPaper, darkGreenPaper, u_dark_mode);
  
  // 2. Sample fluid texture channels
  vec4 sim = texture(u_sim_tex, uv);
  float p_black     = clamp(sim.r, 0.0, 1.0);
  float p_indigo    = clamp(sim.g, 0.0, 1.0);
  float p_vermilion = clamp(sim.b, 0.0, 1.0);
  float p_jade      = clamp(sim.a, 0.0, 1.0);
  
  float total_pigment = p_black + p_indigo + p_vermilion + p_jade;
  
  // 3. Define Inks (Absorptive/Subtractive in Light Washi Paper, glowing mineral/gold-dust in Dark Mode)
  // Black Ink
  vec3 col_black_light = vec3(0.114, 0.110, 0.133); // Sumi coal black
  vec3 col_black_dark  = vec3(0.24, 0.28, 0.25);    // Soft charcoal green-slate
  vec3 col_black = mix(col_black_light, col_black_dark, u_dark_mode);
  
  // Indigo Link
  vec3 col_indigo_light = vec3(0.302, 0.435, 0.659);
  vec3 col_indigo_dark  = vec3(0.485, 0.627, 0.882); // Stellar luminescent indigo
  vec3 col_indigo = mix(col_indigo_light, col_indigo_dark, u_dark_mode);
  
  // Vermilion Ink
  vec3 col_vermilion_light = vec3(0.851, 0.420, 0.337);
  vec3 col_vermilion_dark  = vec3(0.937, 0.518, 0.408); // Shimmering cinnabar/gold dust
  vec3 col_vermilion = mix(col_vermilion_light, col_vermilion_dark, u_dark_mode);
  
  // Jade Ink
  vec3 col_jade_light = vec3(0.373, 0.561, 0.451);
  vec3 col_jade_dark  = vec3(0.498, 0.824, 0.612); // Magical sage-green glow
  vec3 col_jade = mix(col_jade_light, col_jade_dark, u_dark_mode);
  
  // Sequence overlays simulating translucent watercolor layers
  vec3 color = bg_color;
  color = mix(color, col_black, p_black * mix(0.95, 0.80, u_dark_mode));
  color = mix(color, col_indigo, p_indigo * mix(0.91, 0.78, u_dark_mode));
  color = mix(color, col_vermilion, p_vermilion * mix(0.91, 0.78, u_dark_mode));
  color = mix(color, col_jade, p_jade * mix(0.91, 0.78, u_dark_mode));
  
  // 4. Watercolor Edge Pooling (Coffee Ring Effect) & Crystalline Shimmer
  // Sample adjacent coordinates to construct local Sobel derivatives
  vec2 eps = vec2(1.8) / u_res;
  
  float p_l = texture(u_sim_tex, uv - vec2(eps.x, 0.0)).r + texture(u_sim_tex, uv - vec2(eps.x, 0.0)).g + texture(u_sim_tex, uv - vec2(eps.x, 0.0)).b + texture(u_sim_tex, uv - vec2(eps.x, 0.0)).a;
  float p_r = texture(u_sim_tex, uv + vec2(eps.x, 0.0)).r + texture(u_sim_tex, uv + vec2(eps.x, 0.0)).g + texture(u_sim_tex, uv + vec2(eps.x, 0.0)).b + texture(u_sim_tex, uv + vec2(eps.x, 0.0)).a;
  float p_d = texture(u_sim_tex, uv - vec2(0.0, eps.y)).r + texture(u_sim_tex, uv - vec2(0.0, eps.y)).g + texture(u_sim_tex, uv - vec2(0.0, eps.y)).b + texture(u_sim_tex, uv - vec2(0.0, eps.y)).a;
  float p_u = texture(u_sim_tex, uv + vec2(0.0, eps.y)).r + texture(u_sim_tex, uv + vec2(0.0, eps.y)).g + texture(u_sim_tex, uv + vec2(0.0, eps.y)).b + texture(u_sim_tex, uv + vec2(0.0, eps.y)).a;
  
  float grad = length(vec2(p_r - p_l, p_u - p_d));
  float edge_ring = smoothstep(0.02, 0.16, grad) * smoothstep(0.005, 0.08, total_pigment);
  
  // Boundary designs (Dark ink ring in Light, Gold Powder border in Dark)
  vec3 edge_darken_mult = vec3(0.66, 0.62, 0.58);
  vec3 gold_shimmer_rim = vec3(0.85, 0.71, 0.44); // 24-carat gold powder leaf
  
  // Add golden rim glow
  color += edge_ring * gold_shimmer_rim * 0.45 * u_dark_mode;
  
  // Blend pooling dark shadows
  color = mix(color, color * edge_darken_mult, edge_ring * (1.0 - u_dark_mode));
  
  // 5. Paper Fiber Composition & Shading details
  float fiber = get_fiber(uv);
  float noiseValue = noise2d(uv * 1200.0);
  
  vec3 fiber_col_light = vec3(0.83, 0.81, 0.76); // Raw wood pulp fibers
  vec3 fiber_col_dark  = vec3(0.063, 0.118, 0.082); // Sage strands in washi
  vec3 fiber_col = mix(fiber_col_light, fiber_col_dark, u_dark_mode);
  
  // Draw organic threads onto paper
  color = mix(color, fiber_col, fiber * mix(0.09, 0.15, u_dark_mode));
  
  // Pigment granulation: minerals settling in the paper pores
  float granulation = mix(1.0, 1.0 - 0.28 * noiseValue, total_pigment);
  color = mix(color, color * granulation, clamp(total_pigment * 0.75, 0.0, 1.0));
  
  // Add subtle high-frequency paper grain to background
  color += vec3((noiseValue - 0.5) * mix(0.024, 0.012, u_dark_mode));
  
  // 6. Paper bevel drop shadow vignette
  float vignette = smoothstep(1.24, 0.36, length(uv - 0.5));
  color = color * mix(0.87 + 0.13 * vignette, 0.94 + 0.06 * vignette, u_dark_mode);
  
  fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

// ==========================================
// COLOR WELL TYPES & DETAILS
// ==========================================

interface InkColor {
  name: string;
  jpName: string;
  lightValue: string; // HEX to show in HTML
  weightColor: number[]; // R, G, B, A injection ratios
  diffusion: number[]; // R,G,B,A diffusion rates
  description: string;
}

const INK_WELLS: InkColor[] = [
  {
    name: 'Sumi Black',
    jpName: '墨',
    lightValue: '#1d1c22',
    weightColor: [1.2, 0.0, 0.0, 0.0],
    diffusion: [0.08, 0.05, 0.05, 0.05],
    description: 'Traditional pine-soot black pigment.'
  },
  {
    name: 'Indigo Blue',
    jpName: '藍',
    lightValue: '#4d6fa8',
    weightColor: [0.0, 1.4, 0.0, 0.0],
    diffusion: [0.05, 0.15, 0.05, 0.05],
    description: 'Deep navy pigment of fermented leaf dyes.'
  },
  {
    name: 'Cinnabar Vermilion',
    jpName: '朱',
    lightValue: '#d96b56',
    weightColor: [0.0, 0.0, 1.4, 0.0],
    diffusion: [0.05, 0.05, 0.12, 0.05],
    description: 'Warm scarlet extracted from cinnabar rocks.'
  },
  {
    name: 'Jade Moss',
    jpName: '翡翠',
    lightValue: '#5f8f73',
    weightColor: [0.0, 0.0, 0.0, 1.4],
    diffusion: [0.05, 0.05, 0.05, 0.11],
    description: 'Elegant serene green leaf sediment.'
  },
  {
    name: 'Smoke Mist Gray',
    jpName: '墨淡',
    lightValue: '#a9b0b5',
    // Smoky gray is Black pigment (R) injected with water qualities: wide diffusion, lower opacity!
    weightColor: [0.45, 0.0, 0.0, 0.0],
    diffusion: [0.22, 0.05, 0.05, 0.05],
    description: 'Watery diluted Ink Black capturing mist washes.'
  }
];

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  
  // React UI States
  const [selectedColorIdx, setSelectedColorIdx] = useState<number>(0);
  const [themeMode, setThemeMode] = useState<'paper' | 'gallery'>('paper');
  const [isMeditationFlow, setIsMeditationFlow] = useState<boolean>(true);
  const [brushWeight, setBrushWeight] = useState<number>(0.024); // default intermediate brush width
  const [activeInfoTab, setActiveInfoTab] = useState<boolean>(false);
  const [canvasCleared, setCanvasCleared] = useState<boolean>(false);
  const [customStrokeColor, setCustomStrokeColor] = useState<string>(''); // For informational logs

  // Coordinates and variables for WebGL interaction
  const mouseStateRef = useRef({
    x: 0.5,
    y: 0.5,
    prevX: 0.5,
    prevY: 0.5,
    isDown: false,
    dirX: 0,
    dirY: 0,
    speed: 0,
    lastTime: 0
  });

  // WebGL context & references to prevent full re-renders
  const glRef = useRef<WebGL2RenderingContext | null>(null);
  const renderReqRef = useRef<number | null>(null);
  const simBuffersRef = useRef<{
    read: { texture: WebGLTexture; framebuffer: WebGLFramebuffer };
    write: { texture: WebGLTexture; framebuffer: WebGLFramebuffer };
    swap: () => void;
  } | null>(null);

  // Program refs
  const simProgramRef = useRef<WebGLProgram | null>(null);
  const presProgramRef = useRef<WebGLProgram | null>(null);

  // Position attributes
  const positionBufferRef = useRef<WebGLBuffer | null>(null);

  // Animation ticks and auto-drawn strokes track
  const frameCounterRef = useRef<number>(0);
  const currentDarkModeRef = useRef<number>(0.0); // Smooth interpolation
  const clearFadeRegisterRef = useRef<number>(0.0);
  
  // Track automated calligraphic brushes
  const autoStrokeRef = useRef({
    drawing: true,
    progress: 0.0,
    x: 0.2,
    y: 0.45,
    prevX: 0.2,
    prevY: 0.45
  });

  // ==========================================
  // WATERCOLOR & WEBGL INITS
  // ==========================================

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Get WebGL 2 Context: WebGL2 is required for GLSL 300 ES support
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      depth: false,
      stencil: false,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true
    });

    if (!gl) {
      console.error('WebGL 2 context not available on this device.');
      return;
    }
    glRef.current = gl;

    // Compile Helper
    function compileShader(source: string, type: number): WebGLShader {
      const shader = gl!.createShader(type)!;
      gl!.shaderSource(shader, source);
      gl!.compileShader(shader);
      if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
        const info = gl!.getShaderInfoLog(shader);
        gl!.deleteShader(shader);
        throw new Error('Shader compilation failed: ' + info);
      }
      return shader;
    }

    // Link Helper
    function linkProgram(vsSource: string, fsSource: string): WebGLProgram {
      const vs = compileShader(vsSource, gl!.VERTEX_SHADER);
      const fs = compileShader(fsSource, gl!.FRAGMENT_SHADER);
      const program = gl!.createProgram()!;
      gl!.attachShader(program, vs);
      gl!.attachShader(program, fs);
      gl!.linkProgram(program);
      if (!gl!.getProgramParameter(program, gl!.LINK_STATUS)) {
        const info = gl!.getProgramInfoLog(program);
        gl!.deleteProgram(program);
        throw new Error('Program linking failed: ' + info);
      }
      return program;
    }

    // 1. Compile Shaders
    try {
      simProgramRef.current = linkProgram(VERTEX_SHADER_SOURCE, SIMULATION_FRAG_SOURCE);
      presProgramRef.current = linkProgram(VERTEX_SHADER_SOURCE, PRESENTATION_FRAG_SOURCE);
    } catch (err) {
      console.error('Core WebGL shaders failed compiles:', err);
      return;
    }

    // 2. Initialize simulation grid double-buffer (Ping Pong)
    // We run the fluid simulation on a fixed 1024x1024 square to preserve
    // identical physics and ink diffusion rate across resize events.
    const simW = 1024;
    const simH = 1024;
    const buffers: { texture: WebGLTexture; framebuffer: WebGLFramebuffer }[] = [];

    for (let i = 0; i < 2; i++) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, simW, simH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

      // Verify Framebuffer Complete
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        console.error('WebGL Framebuffer complete validation failed.');
      }
      buffers.push({ texture: tex, framebuffer: fb });
    }
    
    // Clear initial state to transparent black (no pigments)
    gl.bindFramebuffer(gl.FRAMEBUFFER, buffers[0].framebuffer);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, buffers[1].framebuffer);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    simBuffersRef.current = {
      read: buffers[0],
      write: buffers[1],
      swap() {
        const tmp = this.read;
        this.read = this.write;
        this.write = tmp;
      }
    };

    // 3. Create Full Screen Quad Buffer
    const quadVertices = new Float32Array([
      -1.0, -1.0,
       1.0, -1.0,
      -1.0,  1.0,
      -1.0,  1.0,
       1.0, -1.0,
       1.0,  1.0,
    ]);

    positionBufferRef.current = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBufferRef.current);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);

    // Bind clean viewport bindings
    const handleResize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect() || { width: 1200, height: 800 };
      canvas.width = rect.width * window.devicePixelRatio;
      canvas.height = rect.height * window.devicePixelRatio;
      canvas.style.width = '100%';
      canvas.style.height = '100%';
    };

    window.addEventListener('resize', handleResize);
    handleResize();

    // Cleanup on unmount
    return () => {
      window.removeEventListener('resize', handleResize);
      if (renderReqRef.current) {
        cancelAnimationFrame(renderReqRef.current);
      }
    };
  }, []);

  // ==========================================
  // RENDER & PHYSICS LOOP
  // ==========================================

  useEffect(() => {
    const gl = glRef.current;
    if (!gl || !simBuffersRef.current) return;

    const canvas = canvasRef.current!;
    const simW = 1024;
    const simY = 1024;

    const render = () => {
      frameCounterRef.current += 1;
      const count = frameCounterRef.current;

      // 1. Smooth Dark Mode Transition Linear Interpolation
      const targetDarkMode = themeMode === 'gallery' ? 1.0 : 0.0;
      currentDarkModeRef.current += (targetDarkMode - currentDarkModeRef.current) * 0.06;

      // 2. Clear Fade decay (wash effect)
      if (clearFadeRegisterRef.current > 0.0) {
        clearFadeRegisterRef.current -= 0.03;
        if (clearFadeRegisterRef.current < 0.0) {
          clearFadeRegisterRef.current = 0;
        }
      }

      // 3. Setup Brush inputs (detect user brush vs starting calligraphic curves)
      let brushPos = [0.0, 0.0];
      let brushPrevPos = [0.0, 0.0];
      let brushColor = [0.0, 0.0, 0.0, 0.0];
      let brushRad = brushWeight;
      let brushPressure = 0.0;
      let brushDryness = 0.0;

      // Handle continuous automated calligraphic brush drawing on load
      if (count < 260) {
        // First majestic brush stroke sweep (Sumi Ink R) during frames 1-130
        if (count >= 10 && count < 110) {
          const t = (count - 10) / 100.0;
          
          // Bezier calligraphic loop sweeps elegantly through screen
          const scaleX = 0.15 + t * 0.7 + 0.03 * Math.sin(t * Math.PI * 2.0);
          const scaleY = 0.38 + 0.24 * Math.sin(t * Math.PI) + 0.12 * t;

          autoStrokeRef.current.prevX = autoStrokeRef.current.x;
          autoStrokeRef.current.prevY = autoStrokeRef.current.y;
          autoStrokeRef.current.x = scaleX;
          autoStrokeRef.current.y = scaleY;

          // Align initial coords on frame 10
          if (count === 10) {
            autoStrokeRef.current.prevY = scaleY;
            autoStrokeRef.current.prevX = scaleX;
          }

          brushPos = [autoStrokeRef.current.x, autoStrokeRef.current.y];
          brushPrevPos = [autoStrokeRef.current.prevX, autoStrokeRef.current.prevY];
          
          // Splat-to-hair calligraphy variance
          brushRad = brushWeight * (1.1 * Math.sin(t * Math.PI) + 0.5);
          brushPressure = 0.9 * Math.sin(t * Math.PI) + 0.15;
          brushDryness = t > 0.72 ? (t - 0.72) * 3.5 : 0.0; // skips on dry paper edge

          // Black pine-soot charcoal sumi
          brushColor = INK_WELLS[0].weightColor;
        }
        // Second intersecting accent branch (Jade/Vermilion) frames 135-230
        else if (count >= 135 && count < 225) {
          const t = (count - 135) / 90.0;
          
          // Branch arches vertically crossing sumi black line
          const scaleX = 0.52 - 0.18 * Math.cos(t * Math.PI * 1.5);
          const scaleY = 0.22 + 0.6 * t;

          autoStrokeRef.current.prevX = autoStrokeRef.current.x;
          autoStrokeRef.current.prevY = autoStrokeRef.current.y;
          autoStrokeRef.current.x = scaleX;
          autoStrokeRef.current.y = scaleY;

          if (count === 135) {
            autoStrokeRef.current.prevY = scaleY;
            autoStrokeRef.current.prevX = scaleX;
          }

          brushPos = [autoStrokeRef.current.x, autoStrokeRef.current.y];
          brushPrevPos = [autoStrokeRef.current.prevX, autoStrokeRef.current.prevY];
          brushRad = brushWeight * 0.55 * (0.8 * Math.sin(t * Math.PI) + 0.3);
          brushPressure = 0.6;
          brushDryness = t > 0.85 ? 0.45 : 0.0;

          // Radiate selected Jade/Indigo accent colors based on initial index
          brushColor = INK_WELLS[3].weightColor; // Moss Jade green accent!
        }
      }
      // If auto-drawing is finished or user is actively drawing
      else {
        if (mouseStateRef.current.isDown) {
          brushPos = [mouseStateRef.current.x, mouseStateRef.current.y];
          brushPrevPos = [mouseStateRef.current.prevX, mouseStateRef.current.prevY];
          brushRad = brushWeight;
          brushPressure = 1.0;
          
          // Inject correct active well colors
          brushColor = INK_WELLS[selectedColorIdx].weightColor;
          
          // High dragging velocity naturally dry-brush skips across cotton grain
          const dragSpeed = mouseStateRef.current.speed;
          brushDryness = Math.min(dragSpeed * 25.0, 0.82);

          // Trace coordinates back
          mouseStateRef.current.prevX = mouseStateRef.current.x;
          mouseStateRef.current.prevY = mouseStateRef.current.y;
        }
        // Meditation flow brings gentle bleeding spots over time
        else if (isMeditationFlow && count % 35 === 0) {
          // Soft decorative background seeping blooms
          const angle = count * 0.021 + selectedColorIdx * 1.25;
          const r = 0.25 + 0.15 * Math.sin(count * 0.005);
          const px = 0.5 + Math.cos(angle) * r;
          const py = 0.5 + Math.sin(angle) * r;

          brushPos = [px, py];
          brushPrevPos = [px + 0.002, py - 0.002];
          brushRad = brushWeight * (2.0 + 1.2 * Math.sin(count * 0.12)); // larger wet blooms
          brushPressure = 0.08; // extremely faint dilution to morph artwork color
          brushDryness = 0.0; // fully watery saturation
          
          // Morph painting colors to align with user selection
          brushColor = INK_WELLS[selectedColorIdx].weightColor;
        }
      }

      // ==========================================
      // PASS 1: FLUID SIMULATION (Render to Framebuffer)
      // ==========================================
      const buffers = simBuffersRef.current!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffers.write.framebuffer);
      gl.viewport(0, 0, simW, simY);

      gl.useProgram(simProgramRef.current!);

      // Set simulation variables
      gl.uniform1i(gl.getUniformLocation(simProgramRef.current!, 'u_prev_tex'), 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, buffers.read.texture);

      gl.uniform1f(gl.getUniformLocation(simProgramRef.current!, 'u_time'), count * 0.016);
      
      // Brush coordinates
      gl.uniform2f(gl.getUniformLocation(simProgramRef.current!, 'u_brush_pos'), brushPos[0], brushPos[1]);
      gl.uniform2f(gl.getUniformLocation(simProgramRef.current!, 'u_brush_prev_pos'), brushPrevPos[0], brushPrevPos[1]);
      gl.uniform1f(gl.getUniformLocation(simProgramRef.current!, 'u_brush_radius'), brushRad);
      gl.uniform4f(gl.getUniformLocation(simProgramRef.current!, 'u_brush_color'), brushColor[0], brushColor[1], brushColor[2], brushColor[3]);
      gl.uniform1f(gl.getUniformLocation(simProgramRef.current!, 'u_brush_pressure'), brushPressure);
      gl.uniform1f(gl.getUniformLocation(simProgramRef.current!, 'u_brush_dryness'), brushDryness);

      // Decaying wash properties
      gl.uniform1f(gl.getUniformLocation(simProgramRef.current!, 'u_clear_fade'), canvasCleared ? 0.99 : (clearFadeRegisterRef.current > 0.0 ? clearFadeRegisterRef.current : 0.0));
      
      // Active ink water diffusion settings
      const currentInk = INK_WELLS[selectedColorIdx];
      gl.uniform4f(
        gl.getUniformLocation(simProgramRef.current!, 'u_diffusion_rates'),
        currentInk.diffusion[0],
        currentInk.diffusion[1],
        currentInk.diffusion[2],
        currentInk.diffusion[3]
      );

      // Mouse water displacements currents
      gl.uniform2f(
        gl.getUniformLocation(simProgramRef.current!, 'u_mouse_pos'),
        mouseStateRef.current.x,
        mouseStateRef.current.y
      );
      gl.uniform2f(
        gl.getUniformLocation(simProgramRef.current!, 'u_mouse_dir'),
        mouseStateRef.current.dirX,
        mouseStateRef.current.dirY
      );
      gl.uniform1f(
        gl.getUniformLocation(simProgramRef.current!, 'u_mouse_speed'),
        mouseStateRef.current.speed
      );

      // Set position attribute bindings
      const posAttrSim = gl.getAttribLocation(simProgramRef.current!, 'a_position');
      gl.enableVertexAttribArray(posAttrSim);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBufferRef.current);
      gl.vertexAttribPointer(posAttrSim, 2, gl.FLOAT, false, 0, 0);

      // Render fullscreen simulation step
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Swap buffers to propagate textures
      buffers.swap();

      // Reset cleared state indicator
      if (canvasCleared) {
        setCanvasCleared(false);
      }

      // ==========================================
      // PASS 2: MAIN PRESENTATION DISPLAY
      // ==========================================
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);

      gl.useProgram(presProgramRef.current!);

      // Bind simulated fluid texture
      gl.uniform1i(gl.getUniformLocation(presProgramRef.current!, 'u_sim_tex'), 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, buffers.read.texture);

      gl.uniform1f(gl.getUniformLocation(presProgramRef.current!, 'u_time'), count * 0.016);
      gl.uniform2f(gl.getUniformLocation(presProgramRef.current!, 'u_res'), canvas.width, canvas.height);
      gl.uniform1f(gl.getUniformLocation(presProgramRef.current!, 'u_dark_mode'), currentDarkModeRef.current);

      // Position attribute binding
      const posAttrPres = gl.getAttribLocation(presProgramRef.current!, 'a_position');
      gl.enableVertexAttribArray(posAttrPres);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBufferRef.current);
      gl.vertexAttribPointer(posAttrPres, 2, gl.FLOAT, false, 0, 0);

      // Render finished textured washi composition
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Slowly damp mouse speed and physical directions
      mouseStateRef.current.speed *= 0.95;
      mouseStateRef.current.dirX *= 0.95;
      mouseStateRef.current.dirY *= 0.95;

      renderReqRef.current = requestAnimationFrame(render);
    };

    renderReqRef.current = requestAnimationFrame(render);

    return () => {
      if (renderReqRef.current) {
        cancelAnimationFrame(renderReqRef.current);
      }
    };
  }, [selectedColorIdx, themeMode, isMeditationFlow, brushWeight, canvasCleared]);

  // ==========================================
  // MOUSE & TOUCH INTERACTIVE BINDINGS
  // ==========================================

  const handlePointerDown = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    let clientX = 0;
    let clientY = 0;

    if ('touches' in e) {
      if (e.touches.length === 0) return;
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
      // Prevent double scrolling behaviors on mobile
      if (e.cancelable) e.preventDefault();
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const x = (clientX - rect.left) / rect.width;
    const y = 1.0 - (clientY - rect.top) / rect.height; // Y-up normalization

    mouseStateRef.current.isDown = true;
    mouseStateRef.current.x = x;
    mouseStateRef.current.y = y;
    mouseStateRef.current.prevX = x;
    mouseStateRef.current.prevY = y;
    mouseStateRef.current.dirX = 0;
    mouseStateRef.current.dirY = 0;
    mouseStateRef.current.speed = 0.05; // initial bloom impact speed
    mouseStateRef.current.lastTime = performance.now();
  };

  const handlePointerMove = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    let clientX = 0;
    let clientY = 0;

    if ('touches' in e) {
      if (e.touches.length === 0) return;
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }

    const x = (clientX - rect.left) / rect.width;
    const y = 1.0 - (clientY - rect.top) / rect.height;

    const now = performance.now();
    const dt = Math.max(now - mouseStateRef.current.lastTime, 1);

    const dx = x - mouseStateRef.current.x;
    const dy = y - mouseStateRef.current.y;
    const dragDist = Math.sqrt(dx * dx + dy * dy);

    // Update mouse properties
    mouseStateRef.current.dirX = dx / (dt * 0.05);
    mouseStateRef.current.dirY = dy / (dt * 0.05);
    mouseStateRef.current.speed = Math.max(dragDist / (dt * 0.02), 0.0);

    mouseStateRef.current.x = x;
    mouseStateRef.current.y = y;
    mouseStateRef.current.lastTime = now;
  };

  const handlePointerUp = () => {
    mouseStateRef.current.isDown = false;
  };

  // Trigger a full paper wash animation
  const handlePaperWash = () => {
    // Increment clear Fade register values to trigger simulation decay pass
    clearFadeRegisterRef.current = 0.95;
    setTimeout(() => {
      setCanvasCleared(true);
    }, 150);
  };

  return (
    <div className="relative w-screen h-screen flex items-center justify-center overflow-hidden bg-[#0c120e] text-[#f4f0e7] antialiased">
      
      {/* 
        MUSEUM MATTE BORDER MOUNT BACKPLATE Frame
        Paper Mode: Outer margins have deep moss velvet forest greens framing.
        Dark Gallery: Outer margin merges with dark green-shadow gallery space.
      */}
      <div className={`absolute inset-0 transition-all duration-1000 ${
        themeMode === 'paper' 
          ? 'bg-gradient-to-br from-[#0c1611] via-[#122219] to-[#080d0a]' 
          : 'bg-gradient-to-br from-[#030604] via-[#050907] to-[#020403]'
      }`} />

      {/* 
        ELEGANT MATTE BOARD SHADOW HOLDER 
        Slight scale and beveled offset representing thick paperboard borders.
        Sophisticated Dark: w-[92vw] h-[88vh], border-8 border-[#1a1c1a] shadow-inner
      */}
      <div 
        id="museum-canvas-frame"
        className="relative w-[92vw] h-[88vh] md:w-[90vw] md:h-[86vh] rounded-none overflow-hidden flex items-center justify-center transition-all duration-1000 shadow-2xl"
        style={{
          border: themeMode === 'paper' ? '12px solid #1a1c1a' : '12px solid #0a0c0a',
          boxShadow: 'inset 0 0 40px rgba(0,0,0,0.85), 0 25px 60px -15px rgba(0,0,0,0.9)'
        }}
      >
        <canvas
          id="sumie-canvas"
          ref={canvasRef}
          onMouseDown={handlePointerDown}
          onMouseMove={handlePointerMove}
          onMouseUp={handlePointerUp}
          onMouseLeave={handlePointerUp}
          onTouchStart={handlePointerDown}
          onTouchMove={handlePointerMove}
          onTouchEnd={handlePointerUp}
          className="absolute inset-0 w-full h-full cursor-crosshair block"
        />

        {/* 
          TOP LEFT: SOPHISTICATED CALLIGRAPHY COLUMN
          Features vertical writing-mode calligraphy, premium gold divider line, 
          and exquisite Suminagashi letterings.
        */}
        <div 
          id="traditional-calligraphy"
          className="absolute top-8 left-8 md:top-12 md:left-12 pointer-events-none select-none flex flex-col items-center transition-all duration-1000 ease-in-out font-serif"
        >
          <div className="flex flex-col items-center">
            {/* Beautiful Vertical Characters */}
            <div 
              className={`text-4xl md:text-5xl font-extrabold tracking-[0.3em] space-y-4 transition-colors duration-1000`} 
              style={{ 
                writingMode: 'vertical-rl',
                color: themeMode === 'paper' ? '#1d1c22' : '#eae3d5'
              }}
            >
              墨流し
            </div>
            
            {/* Elegant Subtitle structure from Sophisticated Dark design */}
            <div className="mt-5 flex flex-col items-center">
              <span className="text-[9px] md:text-[10px] uppercase tracking-[0.4em] text-[#5f8f73] font-bold">
                Suminagashi
              </span>
              <div className="w-[1px] h-10 md:h-12 bg-[#5f8f73] mt-2.5 opacity-40"></div>
              
              <span className={`text-[8px] md:text-[9px] mt-4 max-w-[100px] text-center leading-relaxed tracking-wider font-light transition-colors duration-1000 ${
                themeMode === 'paper' ? 'text-[#2d2d2d] opacity-65' : 'text-[#a2b5aa] opacity-55'
              }`}>
                THE ELEGANCE OF FLOATING INK ON WATER
              </span>
            </div>

            {/* Hanko stamp placed beautifully under the calligraphy stack */}
            <div className="mt-4 hanko-stamp scale-90">
              <span className="text-[10px] tracking-tighter">墨雅</span>
            </div>
          </div>
        </div>

        {/* 
          TOP RIGHT: PREMIUM SLIDING MODE SWITCH
          "Paper Mode" vs "Dark Gallery" using Sophisticated Dark design color schemes
        */}
        <div 
          id="gallery-theme-switch"
          className={`absolute top-6 right-6 md:top-12 md:right-12 flex gap-1 p-1 rounded-full backdrop-blur-md transition-all duration-1000 border ${
            themeMode === 'paper' 
              ? 'bg-[#1a1c1a]/5 border-black/5' 
              : 'bg-black/40 border-white/10'
          }`}
        >
          <button
            id="switch-paper-mode"
            onClick={() => setThemeMode('paper')}
            className={`px-5 py-2 text-[9px] md:text-[10px] font-bold tracking-widest uppercase rounded-full transition-all duration-500 cursor-pointer ${
              themeMode === 'paper' 
                ? 'bg-white text-[#1d1c22] shadow-sm' 
                : 'text-[#849a8d] hover:text-[#eae3d5]'
            }`}
          >
            Paper Mode
          </button>
          
          <button
            id="switch-gallery-mode"
            onClick={() => setThemeMode('gallery')}
            className={`px-5 py-2 text-[9px] md:text-[10px] font-bold tracking-widest uppercase rounded-full transition-all duration-500 cursor-pointer ${
              themeMode === 'gallery' 
                ? 'bg-[#152e20] text-[#cfebd9] border border-[#3e6850]/40 shadow-sm' 
                : 'text-[#849a8d] hover:text-[#eae3d5]'
            }`}
          >
            Dark Gallery
          </button>
        </div>

        {/* 
          BOTTOM RIGHT: SOPHISTICATED DESIGN ANNOTATIONS & BRUSH OPTIONS
        */}
        <div 
          id="calligraphy-controls-right"
          className="absolute bottom-6 right-6 md:bottom-12 md:right-12 flex flex-col items-end gap-4 select-none"
        >
          {/* Subtle Brush weight slider */}
          <div className={`flex flex-col items-end gap-1 px-4 py-3 rounded-2xl backdrop-blur-md transition-all duration-1000 border ${
            themeMode === 'paper'
              ? 'bg-white/20 border-black/5 text-[#1d1c22]'
              : 'bg-black/40 border-white/10 text-[#eae3d5]'
          }`}>
            <span className={`text-[8.5px] tracking-widest font-display font-bold uppercase ${
              themeMode === 'paper' ? 'text-emerald-950/70' : 'text-emerald-300'
            }`}>
              Brush Width / 筆幅
            </span>
            <div className="flex items-center gap-3 mt-1">
              <input
                id="input-brush-weight"
                type="range"
                min="0.006"
                max="0.075"
                step="0.001"
                value={brushWeight}
                onChange={(e) => setBrushWeight(parseFloat(e.target.value))}
                className="w-24 md:w-32 accent-[#5f8f73] h-1.5 bg-neutral-300/40 dark:bg-neutral-800 rounded-lg cursor-ew-resize"
              />
              <span className="text-[10px] font-mono font-bold w-6 text-right">
                {Math.round(brushWeight * 1000)}
              </span>
            </div>
          </div>
          
          {/* Quick Action controls */}
          <div className="flex items-center gap-2">
            <button
              id="btn-autoflow-toggle"
              onClick={() => setIsMeditationFlow(!isMeditationFlow)}
              className={`px-4 py-2 rounded-full cursor-pointer transition-all duration-300 backdrop-blur-md border text-[9px] tracking-widest uppercase font-semibold flex items-center gap-2 shadow-sm ${
                isMeditationFlow 
                  ? 'bg-[#152e20]/90 text-[#cfebd9] border-[#3e6850]/40' 
                  : (themeMode === 'paper' ? 'bg-[#1a1c1a]/5 border-black/5 text-[#1d1c22]/70 hover:bg-white/40' : 'bg-black/30 border-white/10 text-[#849a8d] hover:text-white')
              }`}
            >
              {isMeditationFlow ? <Pause size={11} /> : <Play size={11} />}
              <span>Auto-Flow</span>
            </button>

            <button
              id="btn-wash-paper"
              onClick={handlePaperWash}
              className={`px-4 py-2 rounded-full cursor-pointer transition-all duration-300 backdrop-blur-md border text-[9px] tracking-widest uppercase font-semibold flex items-center gap-2 shadow-sm ${
                themeMode === 'paper' 
                  ? 'bg-white border-black/10 text-[#1d1c22] hover:bg-[#eae3d5]' 
                  : 'bg-black/35 border-white/10 text-[#849a8d] hover:text-[#eae3d5] hover:border-[#3e6850]/40'
              }`}
            >
              <RefreshCw size={11} className="animate-spin-hover" />
              <span>Wash Paper</span>
            </button>
          </div>

          {/* Sophisticated Dark Theme Custom Annotation details */}
          <div className="text-right mt-1.5 pointer-events-none">
            <p className={`text-[10.5px] font-medium leading-tight italic transition-colors duration-1000 ${
              themeMode === 'paper' ? 'text-[#1d1c22]/80' : 'text-[#cfebd9]/70'
            }`}>
              Interaction: 02.4
            </p>
            <p className="text-[9px] tracking-widest text-[#5f8f73] uppercase mt-1 font-bold">
              Fluid Dynamics Active
            </p>
          </div>
        </div>

        {/* 
          BOTTOM LEFT: ACTIVE TOOL STATUS
        */}
        <div 
          id="active-watercolor-details"
          className={`absolute bottom-6 left-6 hidden lg:flex flex-col items-start gap-1 p-4 rounded-2xl backdrop-blur-md transition-all duration-1000 border ${
            themeMode === 'paper'
              ? 'bg-white/20 border-black/5'
              : 'bg-black/40 border-white/10'
          } select-none pointer-events-none`}
        >
          <span className="text-[8px] tracking-[0.2em] uppercase text-[#5f8f73] font-bold">
            Active Pigment Source
          </span>
          <span className={`text-sm font-serif font-bold flex items-center gap-1.5 mt-0.5 transition-colors duration-1000 ${
            themeMode === 'paper' ? 'text-[#1d1c22]' : 'text-amber-100'
          }`}>
            {INK_WELLS[selectedColorIdx].name} ({INK_WELLS[selectedColorIdx].jpName})
          </span>
          <p className={`text-[10px] max-w-[200px] mt-1 font-sans font-light leading-relaxed opacity-75 transition-colors duration-1000 ${
            themeMode === 'paper' ? 'text-neutral-800' : 'text-neutral-400'
          }`}>
            {INK_WELLS[selectedColorIdx].description}
          </p>
        </div>

        {/* 
          CENTER BOTTOM: GLASSMORPHISM PALETTE BAR
          Extracted directly from the Sophisticated Dark design layout.
        */}
        <div 
          id="glassmorphic-inkwell-dock"
          className={`absolute bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-6 md:gap-8 backdrop-blur-xl px-8 py-5 md:px-10 md:py-6 rounded-[2.5rem] transition-all duration-1000 shadow-2xl z-10 border ${
            themeMode === 'paper' 
              ? 'bg-white/40 border-white/40' 
              : 'bg-[#0f1713]/60 border-[#3e6850]/20'
          }`}
        >
          {INK_WELLS.map((ink, idx) => {
            const isSelected = selectedColorIdx === idx;
            // Palette titles extracted: BLACK, INDIGO, VERMILION, JADE, SMOKE
            const capsLabel = ink.name.split(' ').pop()?.toUpperCase() || '';
            
            return (
              <button
                id={`inkwell-${idx}`}
                key={ink.name}
                onClick={() => setSelectedColorIdx(idx)}
                className={`group relative flex flex-col items-center cursor-pointer focus:outline-none transition-all duration-300 ${
                  isSelected ? 'scale-110' : 'hover:scale-105'
                }`}
              >
                {/* Thick ring color wells */}
                <div 
                  className={`w-11 h-11 md:w-12 md:h-12 rounded-full transition-all duration-500 shadow-lg ${
                    isSelected 
                      ? 'ring-4 ring-[#5f8f73]/20 scale-102' 
                      : ''
                  }`}
                  style={{
                    backgroundColor: ink.lightValue,
                    border: isSelected 
                      ? `4px solid ${themeMode === 'paper' ? '#2d4a3e' : '#e2b76c'}` 
                      : '4px solid #ffffff'
                  }}
                >
                  {/* Gloss shine reflection dot */}
                  <div className="absolute top-1 left-2 w-2 h-1 bg-white/30 rounded-full rotate-[-15deg] pointer-events-none" />
                </div>

                {/* Capitalized labels conforming with the requested theme */}
                <span className={`text-[8px] md:text-[9.5px] mt-2 font-bold tracking-wider transition-colors duration-500 ${
                  isSelected 
                    ? (themeMode === 'paper' ? 'text-[#2d4a3e]' : 'text-amber-100') 
                    : (themeMode === 'paper' ? 'text-[#1d1c22]/65' : 'text-[#849a8d]')
                }`}>
                  {capsLabel}
                </span>
                
                {/* Visual selected underline indicator */}
                {isSelected && (
                  <div className="absolute -bottom-1 w-5 h-[1.5px] bg-[#5f8f73] rounded-full" />
                )}
              </button>
            );
          })}
        </div>

        {/* 
          MOBILE CONTROL TRIGGER BUTTONS 
          Visible on smartphones instead of the rich hover boxes
        */}
        <div className="absolute bottom-28 right-4 flex flex-col items-center gap-2 md:hidden">
          <button
            id="mobile-btn-wash"
            onClick={handlePaperWash}
            className="p-3 bg-black/40 border border-white/10 rounded-full text-[#849a8d]"
            title="Clear washi"
          >
            <RefreshCw size={14} />
          </button>
          
          <button
            id="mobile-btn-meditative"
            onClick={() => setIsMeditationFlow(!isMeditationFlow)}
            className={`p-3 border rounded-full text-xs shadow-md ${
              isMeditationFlow ? 'bg-emerald-950/40 text-emerald-200 border-emerald-800/40' : 'bg-black/40 border-white/10 text-[#849a8d]'
            }`}
          >
            {isMeditationFlow ? <Pause size={14} /> : <Play size={14} />}
          </button>
        </div>

        {/* Calligraphy Info triggers */}
        <button
          id="btn-calligraphy-info"
          onClick={() => setActiveInfoTab(!activeInfoTab)}
          className="absolute top-6 left-32 md:top-12 md:left-36 p-1.5 text-[#849a8d] hover:text-[#eae3d5] transition-colors rounded-full backdrop-blur-md bg-black/10 hover:bg-black/35 border border-white/5 cursor-pointer z-10"
          title="Artwork philosophy"
        >
          <Info size={14} />
        </button>

        {/* 
          INFO MODAL: TRADITIONAL PHILOSOPHY EXPLANATION
        */}
        {activeInfoTab && (
          <div 
            id="philosophical-modal"
            className="absolute inset-x-8 top-24 max-w-md mx-auto p-6 rounded-2xl backdrop-blur-xl bg-[#09100c]/95 border border-emerald-800/30 shadow-2xl z-20 text-[#f4f0e7] font-sans text-xs md:text-sm flex flex-col gap-4 stroke-fade-in"
          >
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <span className="font-serif font-bold text-lg tracking-wider text-amber-100 flex items-center gap-2">
                <span>墨流し</span> • Suminagashi Masterpiece
              </span>
              <button 
                id="btn-close-modal"
                onClick={() => setActiveInfoTab(false)} 
                className="text-[#849a8d] hover:text-white font-extrabold cursor-pointer"
              >
                ✕
              </button>
            </div>
            
            <p className="leading-relaxed text-neutral-300 font-light">
              This digital exhibition marries the 16th-century Japanese art of marbling, 
              <strong> Suminagashi (&ldquo;floating ink&rdquo;)</strong>, with interactive physics simulations modeled on 
              GPU-accelerated WebGL fragment shaders.
            </p>
            
            <div className="grid grid-cols-2 gap-3.5 bg-emerald-950/20 p-3 rounded-lg border border-emerald-800/20">
              <div className="flex flex-col gap-1">
                <span className="text-amber-100/80 font-bold text-[10px] tracking-widest font-display">THEORY OF WATER</span>
                <span className="text-[10px] text-neutral-400 leading-normal font-light">
                  Laplace diffusion algorithms model capillary action across washi paper pulp pores.
                </span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-amber-100/80 font-bold text-[10px] tracking-widest font-display">COFFEE-RING LEAF</span>
                <span className="text-[10px] text-neutral-400 leading-normal font-light">
                  In Dark-Gallery mode, mineral deposits crystallize at boundary edges, forming glowing gold leaf rings.
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-2 border-t border-white/5 pt-3 select-none">
              <span className="text-[10px] tracking-widest uppercase text-emerald-400 font-semibold font-display">Interactive Gestures</span>
              <ul className="list-disc pl-4 text-[11px] text-neutral-400 flex flex-col gap-1 font-light leading-normal">
                <li><strong>Gently glide</strong> the cursor/finger to create soft fluid displacement currents.</li>
                <li><strong>Press/Tap</strong> to bleed high-density color spots with dynamic dry-brush skips.</li>
                <li><strong>Toggle Gallery (幽玄)</strong> to view glowing colors on mossy charcoal-green velvet paper.</li>
              </ul>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
