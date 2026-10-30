import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createCrown, crownPortraitPoints, type Crown } from './crown';
import { portraitFrame, portraitViewport } from './portrait';
import { mouthMorphs, mouthPoseAt, type AvatarPlayback } from '../../../../shared/lip-sync';
import type { ConversationState } from '../../../../shared/protocol';
import type { SpeechGesture } from '../../../../shared/gestures';

// Gesture clips are authored in apps/web/avatar-source/kelly.blend and played additively over the rest pose.
type Gesture = 'wake' | 'nod' | 'yawn' | 'shrug' | 'think' | 'glance_left' | 'glance_right';
// Every clip starts at the neutral pose except wake, which starts asleep and ends neutral (frame 84 at 30 fps).
const neutralFrame: Record<string, number> = { wake: 84 };
// While these run, the clip owns the eyelids and the automatic blink pauses.
const eyeGestures: Gesture[] = ['wake', 'yawn'];
// Slow looks to one side while awake and not listening to the user, every few seconds.
const glances: Gesture[] = ['glance_left', 'glance_right'];
const glanceEvery = () => 7+Math.random()*7;
// Eye height in world units of the 1.9-tall bust. The camera sits here so her gaze meets the viewer's.
const eyeLevel = .5;
// Lash line along the upper eyelids: a cool neon tone, bright enough to read on the black lids.
const lidGlowColor = 0x9fe6ff, lidGlowStrength = 2;
// Visual presets, switchable with ?look=<name> in the URL (and kellyLook(name) in development).
// neon: the black obsidian mirror. halo: a satin bust lit from within, white-blue at the head fading to deep blue
// at the shoulders. violet: velvety deep-purple skin in soft lilac light, with a lilac rim from behind.
// Gradient heights are in world units of the 1.9-tall bust (head top .95, eyes .5, shoulders -.6).
type Look = { color: number; metalness: number; roughness: number; clearcoat: number; clearcoatRoughness: number; iridescence: number;
  envMapIntensity: number; exposure: number; lights: number; eyes: number;
  // lightTint replaces the lights' own colours (null keeps them); edge pulls grazing surfaces toward the low colour.
  lightTint: number | null; edge: number;
  // ACES suits the neon look but shifts saturated blue toward purple; Neutral keeps colours as authored.
  toneMapping: THREE.ToneMapping;
  gradient: { low: number; high: number; from: number; to: number; glow: number; tint: number; eyeCut: number };
  // Rim fire: glow where the surface turns away from the camera (power sharpens it to the silhouette), coloured by a
  // slowly drifting 3D noise between two colours; scale sets the size of the flames, flicker how fast they move.
  // variation 0 gives a smooth, even rim; 1 breaks it into noise-driven strands.
  rim: { strength: number; power: number; colorA: number; colorB: number; scale: number; flicker: number; variation: number };
  // Velvet: the physical material's sheen, a soft glow on surfaces seen edge-on.
  sheen: number; sheenColor: number;
  // crown adds the violet extras (disc, opened skull with a pulsing brain, orbiting spheres); lidColor tints the lash line.
  crown: boolean; lidColor: number };
const noRim = { strength: 0, power: 1, colorA: 0, colorB: 0, scale: 1, flicker: 0, variation: 0 };
const looks: Record<string, Look> = {
  neon: { color: 0x141c36, metalness: .94, roughness: .18, clearcoat: 1, clearcoatRoughness: .09, iridescence: .65, envMapIntensity: 3.4,
    exposure: 1.25, lights: 1, eyes: 0xffffff, lightTint: null, edge: 0, toneMapping: THREE.ACESFilmicToneMapping, gradient: { low: 0, high: 0, from: 0, to: 1, glow: 0, tint: 0, eyeCut: 0 }, rim: noRim, sheen: 0, sheenColor: 0, crown: false, lidColor: lidGlowColor },
  halo: { color: 0xffffff, metalness: 0, roughness: .45, clearcoat: .25, clearcoatRoughness: .35, iridescence: 0, envMapIntensity: 0,
    exposure: 1.1, lights: .4, eyes: 0x2a5cff, lightTint: 0xdce8ff, edge: 1, toneMapping: THREE.NeutralToneMapping, gradient: { low: 0x0a1c9e, high: 0xeef5ff, from: -.3, to: .3, glow: 1, tint: .8, eyeCut: .85 }, rim: noRim, sheen: 0, sheenColor: 0, crown: false, lidColor: lidGlowColor },
  violet: { color: 0x22123a, metalness: 0, roughness: .75, clearcoat: 0, clearcoatRoughness: .5, iridescence: 0, envMapIntensity: 0,
    exposure: 1.1, lights: .55, eyes: 0xffffff, lightTint: 0xc3a6ff, edge: 0, toneMapping: THREE.NeutralToneMapping,
    gradient: { low: 0, high: 0, from: 0, to: 1, glow: 0, tint: 0, eyeCut: 0 },
    rim: { strength: .9, power: 3.2, colorA: 0xa070f0, colorB: 0xa070f0, scale: 1, flicker: 0, variation: 0 }, sheen: .8, sheenColor: 0x8a5ce8, crown: true, lidColor: 0xffffff },
};
// Studio lights in the reflection environment: [x, y, width, height, colour] in equirectangular fractions.
const studioLights: readonly (readonly [number, number, number, number, string])[] = [
  [.83, .3, .1, .16, '#eef6ff'],     // key softbox: in front, above, to her right
  [.67, .4, .06, .12, '#7f96d8'],    // dim fill softbox on her left
  [.5, .05, .5, .025, '#c9d8ff'],    // overhead light bar
  [.06, .36, .012, .42, '#16e4ff'],  // cyan rim strip, behind on her right
  [.42, .36, .012, .42, '#ff2fae'],  // magenta rim strip, behind on her left
];
// Mouth interior: pale satin teeth, deep rose tongue and gums, each with a faint glow so they read inside the dark mouth.
const mouthColors = { teeth: 0xd9deee, gums: 0x6e2443, tongue: 0x9a3463 };
const mouthGlow = { teeth: .14, gums: .1, tongue: .16 };
// Seconds awake with nobody talking or acting before Kelly yawns.
const firstIdleYawn = 20;
// Gestures read as natural when they start just before the words they accompany.
const gestureLead = .2;
// Portrait framing lines, in world units of the 1.9-tall bust: above the head with room for raised-head gestures, and the base of the neck.
const headClearance = 1.04, neckLine = -.55;
// The bust is solid down to the shoulders and gone a little below them (scene units).
const bustSolid = -.12, bustClear = -1.02;
// Roughly how long the camera takes to glide to a new framing when the page text changes height.
const framingSeconds = .6;
// Playback speed and strength per gesture: slower and smaller than authored reads calmer on screen.
const gestureTuning: Partial<Record<Gesture, { speed: number; strength: number }>> = {
  nod: { speed: .7, strength: .75 }, shrug: { speed: .8, strength: .85 }, think: { speed: .75, strength: .9 },
};
// Seconds for a held pose to ease back to neutral, and to ease back in when requested again.
const releaseSeconds = 1.2, resumeSeconds = .6;

// Whether a point on the page (client pixels) falls on the violet look's brain; if so, the brain's centre on the page.
export type BrainProbe = (clientX: number, clientY: number) => { x: number; y: number } | null;
type ViewOptions = {
  getPlayback: () => AvatarPlayback | null;
  getState: () => ConversationState;
  getRecording?: () => boolean;
  // The user's voice loudness while recording; the violet brain reacts to it.
  getMicLevel?: () => number;
  // The brain is out in the memories view; and whether to invite a tap on it.
  getBrainOut?: () => boolean;
  getInvite?: () => boolean;
  // Page theme: on a light page the violet scene sits in a dark portal so its glow keeps its contrast.
  getTheme?: () => 'light' | 'dark';
  // Pixels from the top of the view that page content covers; the head stays below them.
  getHeadroom?: () => number;
  // Pixels from the bottom of the view that page content covers; Kelly is centred between the two.
  getFootroom?: () => number;
  // Pixels to move Kelly right of the view's centre (a layout with copy on the left); she glides when it changes.
  getShiftX?: () => number;
  getBottomAnchored?: () => boolean;
  loadModel?: (signal: AbortSignal) => Promise<ArrayBuffer>;
  onReady?: () => void;
  // Receives the brain hit test once the avatar has loaded.
  onBrainProbe?: (probe: BrainProbe) => void;
  // Receives a function returning the brain's centre on the page (null when the look has no brain).
  onBrainLocator?: (locate: () => { x: number; y: number } | null) => void;
  // Called when the saved-memory count goes up while the page is open.
  onNewMemory?: () => void;
  // Receives a function returning the page y of the top of what is drawn (the portal or disc, else the head).
  onSubjectTop?: (locate: () => number | null) => void;
  onError: () => void;
  interactive?: boolean;
  portrait?: boolean;
};
export function mountKelly(host: HTMLElement, options: ViewOptions) {
  const controller = new AbortController();
  // Computers render above the screen's pixel density, up to 2.5x: supersampling smooths edges and the mirror-like
  // highlights. Phones render near their own dense screen (up to 2.5x, never below 2x there) so the face stays sharp;
  // multisampling is left out on them, since at that density it barely shows and costs the most. If frames run slow,
  // the resolution steps down to that floor, and below it the clone is drawn at half the frame rate instead.
  // Phones render at 2x their screen, with multisampling for clean edges (on the tile-based graphics chips of phones it
  // costs little). ?quality=lite drops two of the four lights and the velvet sheen, to compare; ?perf shows the frame rate.
  const query=new URLSearchParams(location.search);
  const phone=matchMedia('(pointer: coarse)').matches || Math.min(innerWidth,innerHeight)<700, lite=phone && query.get('quality')==='lite';
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  let pixelRatio=phone ? Math.min(2,Math.max(1,devicePixelRatio)) : Math.min(2.5,Math.max(1,devicePixelRatio)*1.75), frameMs=16, sinceRatioChange=0;
  const lowestRatio=phone ? Math.min(1.5,Math.max(1,devicePixelRatio)) : Math.max(1,Math.min(devicePixelRatio,2)*.75);
  // The display's own frame interval (16.7 ms at 60 Hz; 33 ms when a phone saves battery): slowness is measured
  // against it, so a screen capped at 30 fps is not mistaken for a slow machine.
  let cadenceMs=16.7; const intervals: number[]=[];
  const meter=query.has('perf') ? Object.assign(document.createElement('div'),{ style: 'position:fixed;left:8px;top:8px;z-index:99999;padding:4px 8px;border-radius:6px;background:#000a;color:#0f0;font:12px monospace;pointer-events:none' }) : null;
  if (meter) document.body.append(meter);
  let meterFrames=0, meterSince=0;
  renderer.setPixelRatio(pixelRatio); renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.25;
  renderer.localClippingEnabled = true; renderer.domElement.setAttribute('aria-hidden', 'true'); host.append(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 1, .01, 100);
  const controls = options.interactive ? new OrbitControls(camera, renderer.domElement) : undefined;
  if (controls) { controls.enableDamping = true; controls.enablePan = false; controls.minPolarAngle = Math.PI * .27; controls.maxPolarAngle = Math.PI * .69; }
  // Reflection environment. On a mirror-like surface, sharpness is read from the reflections, so besides the neon
  // gradient that gives Kelly her colour, the studio has hard-edged lights (softboxes, rim strips, an overhead bar)
  // that become crisp highlights. Equirectangular layout: x = direction around her (0.75 is in front of her face,
  // 0.25 behind, 0.5 her left side, 0/1 her right), y = up (top) to down (bottom).
  const W = 2048, Hgt = 1024, canvas = document.createElement('canvas'); canvas.width = W; canvas.height = Hgt;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#02040d'; ctx.fillRect(0, 0, W, Hgt);
  const gradient = ctx.createLinearGradient(0, 0, W, 0);
  for (const [offset, color] of [[0,'#030718'], [.12,'#286aff'], [.25,'#03efff'], [.37,'#ff147e'], [.47,'#ffbf42'], [.54,'#ff6830'], [.63,'#ff28c8'], [.76,'#424dff'], [.87,'#08e6ff'], [1,'#030718']] as const) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient; ctx.fillRect(0,0,W,Hgt);
  // The reference has luminous colour around the brow and a dark lower face.
  // Fade the coloured environment vertically instead of covering the full bust.
  const colourMask = ctx.createLinearGradient(0,0,0,Hgt);
  for (const [offset,color] of [[0,'#040404'],[.13,'#121212'],[.27,'#ffffff'],[.4,'#ffffff'],[.52,'#808080'],[.66,'#060606'],[1,'#020202']] as const) colourMask.addColorStop(offset,color);
  ctx.globalCompositeOperation='multiply'; ctx.fillStyle=colourMask; ctx.fillRect(0,0,W,Hgt);
  ctx.globalCompositeOperation='screen';
  // Hard-edged studio lights with a thin feathered rim, like real softboxes.
  const panel = (x: number, y: number, w: number, h: number, color: string, feather = 3) => {
    ctx.shadowColor = color; ctx.shadowBlur = feather; ctx.fillStyle = color;
    ctx.beginPath(); ctx.roundRect((x - w / 2) * W, (y - h / 2) * Hgt, w * W, h * Hgt, Math.min(w * W, h * Hgt) * .18); ctx.fill();
  };
  for (const [x, y, w, h, color] of studioLights) panel(x, y, w, h, color);
  ctx.shadowBlur = 0; ctx.globalCompositeOperation = 'source-over';
  const environmentSource = new THREE.CanvasTexture(canvas); environmentSource.mapping=THREE.EquirectangularReflectionMapping; environmentSource.colorSpace=THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer), environment=pmrem.fromEquirectangular(environmentSource);
  environmentSource.dispose(); pmrem.dispose(); scene.environment=environment.texture;
  const hemisphere=new THREE.HemisphereLight(0x7287cf,0x02030b,.35); scene.add(hemisphere);
  const lights: { light: THREE.Light; power: number; color: number }[]=[];
  const lightSet=[[0xb8f5ff,-1.2,1.8,2.5,8],[0xffa6df,1.6,1.1,1.5,3],[0x406cff,0,2,-1,5],[0xe0eeff,-.8,-1,2,3]];
  for (const [color,x,y,z,power] of lite ? [lightSet[0],lightSet[2]].map(([c,x,y,z,p])=>[c,x,y,z,p*1.25]) : lightSet) {
    const light=new THREE.PointLight(color,power); light.position.set(x,y,z); scene.add(light); lights.push({ light, power, color });
  }
  // 1024 px so the glowing eyes keep a crisp edge up close (same 12-14 px radii as the old 256 px map, scaled).
  const eyeSize=1024, eyeScale=eyeSize/256, eyeCanvas=document.createElement('canvas'); eyeCanvas.width=eyeCanvas.height=eyeSize;
  const eyeCtx=eyeCanvas.getContext('2d')!; eyeCtx.fillStyle='black'; eyeCtx.fillRect(0,0,eyeSize,eyeSize);
  // Iris centres in Kelly's original atlas (each eye has its own UV island).
  for (const [x,y] of [[.898,.202],[.850,.403]]) {
    const glow=eyeCtx.createRadialGradient(x*eyeSize,y*eyeSize,12*eyeScale,x*eyeSize,y*eyeSize,14*eyeScale);
    glow.addColorStop(0,'#fff'); glow.addColorStop(1,'#000'); eyeCtx.fillStyle=glow; eyeCtx.fillRect((x*256-15)*eyeScale,(y*256-15)*eyeScale,30*eyeScale,30*eyeScale);
  }
  // glTF UVs start at the top of the image. The bust has no UVs, so it samples the black corner.
  const eyeMap=new THREE.CanvasTexture(eyeCanvas); eyeMap.colorSpace=THREE.SRGBColorSpace; eyeMap.flipY=false; eyeMap.anisotropy=renderer.capabilities.getMaxAnisotropy();
  const material=new THREE.MeshPhysicalMaterial({color:0x141c36,metalness:.94,roughness:.18,clearcoat:1,clearcoatRoughness:.09,
    iridescence:.65,iridescenceIOR:1.35,iridescenceThicknessRange:[120,430],envMapIntensity:3.4,emissive:0xffffff,emissiveIntensity:2.5,emissiveMap:eyeMap});
  // A closed black lid is a glossy dome, exactly like a black eyeball, so closed eyes passed for open ones.
  // The model marks three lid regions per vertex (`lid`): r = upper lid margin, g = lower lid margin, b = upper lid
  // surface. As the eyes close, the lid surface turns matte (no eyeball-like reflection) and both margins light up
  // as a lash line; open eyes keep only a faint trace of it.
  // The alpha of the same per-vertex marks names the mouth interior: 0 teeth, .25 gums, .5 tongue, 1 everything else.
  // In black obsidian the tongue and teeth vanished inside the mouth, so speech showed only the jaw; they get their
  // own matte, softly lit look so the tongue and teeth can be seen following the words.
  const lidClosed={ value: 0 };
  const lidGlow={ value: new THREE.Color() }, cutLow={ value: new THREE.Vector4() }, cutHigh={ value: new THREE.Vector4() }, cutGlow={ value: 0 };
  // Skull cap above the slot, lifted away while the brain comes out (see crown.cap).
  // capShift moves a whole draw in world space (capInverse brings it back to the mesh's own space); used by the cap copy.
  const capShift={ value: new THREE.Vector3() }, capInverse={ value: new THREE.Matrix4() };
  let crown: Crown | undefined, currentLook='neon';
  // Look uniforms: a vertical colour gradient over the bust (world height), used as surface colour and as glow.
  const lookGradient={ low: { value: new THREE.Color() }, high: { value: new THREE.Color() }, from: { value: 0 }, to: { value: 1 },
    glow: { value: 0 }, tint: { value: 0 }, eyeCut: { value: 0 }, edge: { value: 0 } };
  const rimFire={ strength: { value: 0 }, power: { value: 1 }, colorA: { value: new THREE.Color() }, colorB: { value: new THREE.Color() },
    scale: { value: 1 }, flicker: { value: 0 }, variation: { value: 0 }, time: { value: 0 } };
  const vec3=(color: number, scale=1) => { const c=new THREE.Color(color).multiplyScalar(scale); return `vec3(${c.r.toFixed(4)},${c.g.toFixed(4)},${c.b.toFixed(4)})`; };
  material.onBeforeCompile=shader=>{
    Object.assign(shader.uniforms,{ lidGlow, cutLow, cutHigh, cutGlow, cutColor: { value: new THREE.Color(0xd9b8ff) }, capShift, capInverse });
    shader.uniforms.lidClosed=lidClosed;
    shader.uniforms.gradLow=lookGradient.low; shader.uniforms.gradHigh=lookGradient.high; shader.uniforms.gradFrom=lookGradient.from; shader.uniforms.gradTo=lookGradient.to;
    shader.uniforms.gradGlow=lookGradient.glow; shader.uniforms.gradTint=lookGradient.tint; shader.uniforms.eyeCut=lookGradient.eyeCut; shader.uniforms.gradEdge=lookGradient.edge;
    Object.assign(shader.uniforms,{ rimStrength: rimFire.strength, rimPower: rimFire.power, rimA: rimFire.colorA, rimB: rimFire.colorB,
      rimScale: rimFire.scale, rimFlicker: rimFire.flicker, rimVariation: rimFire.variation, rimTime: rimFire.time });
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute vec4 lid;\nvarying vec4 vLid;\nvarying float vWorldY;\nvarying vec3 vWorld;\nuniform vec3 capShift; uniform mat4 capInverse;')
      // The cap copy is drawn shifted as a rigid whole, so it keeps exactly the shape it has on the head.
      .replace('#include <project_vertex>','transformed+=(capInverse*vec4(capShift,0.)).xyz;\n#include <project_vertex>')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nvLid=lid;')
      .replace('#include <project_vertex>','#include <project_vertex>\nvWorld=(modelMatrix*vec4(transformed,1.)).xyz; vWorldY=vWorld.y;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
        uniform vec3 lidGlow; uniform float lidClosed; varying vec4 vLid; varying float vWorldY;
        uniform vec3 gradLow, gradHigh; uniform float gradFrom, gradTo, gradGlow, gradTint, eyeCut, gradEdge;
        uniform vec4 cutLow, cutHigh; uniform float cutGlow; uniform vec3 cutColor;
        varying vec3 vWorld; uniform float rimStrength, rimPower, rimScale, rimFlicker, rimVariation, rimTime; uniform vec3 rimA, rimB;
        float rimHash(vec3 p){ p=fract(p*.3183099+.1); p*=17.; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
        float rimNoise(vec3 x){ vec3 i=floor(x), f=fract(x); f=f*f*(3.-2.*f);
          return mix(mix(mix(rimHash(i),rimHash(i+vec3(1,0,0)),f.x),mix(rimHash(i+vec3(0,1,0)),rimHash(i+vec3(1,1,0)),f.x),f.y),
                     mix(mix(rimHash(i+vec3(0,0,1)),rimHash(i+vec3(1,0,1)),f.x),mix(rimHash(i+vec3(0,1,1)),rimHash(i+vec3(1,1,1)),f.x),f.y),f.z); }`)
      .replace('#include <color_fragment>',`#include <color_fragment>
        float teeth=1.-step(.125,vLid.a), gums=step(.125,vLid.a)*(1.-step(.375,vLid.a)), tongue=step(.375,vLid.a)*(1.-step(.75,vLid.a));
        float mouthPart=teeth+gums+tongue;
        diffuseColor.rgb=mix(diffuseColor.rgb,teeth*${vec3(mouthColors.teeth)}+gums*${vec3(mouthColors.gums)}+tongue*${vec3(mouthColors.tongue)},mouthPart);
        // Look gradient by height; the eyes are cut out of it so they still read on a bright head.
        float eyeMask=texture2D(emissiveMap,vEmissiveMapUv).r*eyeCut;
        vec3 gradColor=mix(gradLow,gradHigh,smoothstep(gradFrom,gradTo,vWorldY));
        diffuseColor.rgb=mix(diffuseColor.rgb,gradColor,gradTint*(1.-mouthPart))*(1.-eyeMask);`)
      .replace('#include <metalnessmap_fragment>','#include <metalnessmap_fragment>\nmetalnessFactor=mix(metalnessFactor,0.,mouthPart);')
      .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=mix(roughnessFactor,teeth*.3+gums*.5+tongue*.42,mouthPart);')
      .replace('#include <emissivemap_fragment>',`#include <emissivemap_fragment>
        totalEmissiveRadiance+=lidGlow*(vLid.r*(.15+.85*lidClosed)+vLid.g*lidClosed);
        // Slot in the skull: both of its edges glow lilac, like the headband in the reference.
        // Distance to the nearest slot edge: below the slot only the lower face counts, above it only the upper one.
        float cutDist=max(dot(cutLow.xyz,vWorld)+cutLow.w,dot(cutHigh.xyz,vWorld)+cutHigh.w);
        totalEmissiveRadiance+=cutColor*cutGlow*(1.-smoothstep(0.,.05,cutDist));
        // The mouth gets almost no environment light, so a faint glow keeps teeth and tongue readable.
        totalEmissiveRadiance+=teeth*${vec3(mouthColors.teeth,mouthGlow.teeth)}+gums*${vec3(mouthColors.gums,mouthGlow.gums)}+tongue*${vec3(mouthColors.tongue,mouthGlow.tongue)};
        // Surfaces turning away from the camera slide toward the low colour, which gives the glowing head its volume.
        float grazing=pow(1.-clamp(dot(normal,normalize(vViewPosition)),0.,1.),2.)*gradEdge;
        totalEmissiveRadiance+=mix(gradColor,gradLow,grazing)*gradGlow*(1.-mouthPart)*(1.-eyeMask);
        // Rim fire: two octaves of drifting noise pick blue or orange and make the flames brighten and fade.
        vec3 flameAt=vWorld*rimScale*vec3(1.,.3,1.)+vec3(0.,-rimTime*rimFlicker*2.,rimTime*rimFlicker);
        float flame=mix(.6,rimNoise(flameAt)*.65+rimNoise(flameAt*2.3)*.35,rimVariation);
        float rim=pow(1.-clamp(dot(normal,normalize(vViewPosition)),0.,1.),rimPower)*rimStrength;
        vec3 fire=mix(rimA,rimB,smoothstep(.44,.56,flame));
        // The hottest strands burn toward white, like the core of a flame.
        totalEmissiveRadiance+=(fire+vec3(.9,.8,.7)*pow(flame,4.)*.6)*rim*(.3+1.4*flame*flame)*(1.-mouthPart);`)
      .replace('#include <lights_physical_fragment>',`#include <lights_physical_fragment>
        float lidMatte=vLid.b*lidClosed;
        material.roughness=mix(material.roughness,.7,lidMatte);
        material.specularColor*=1.-.8*lidMatte;
        #ifdef USE_CLEARCOAT
          material.clearcoat*=(1.-lidMatte)*(1.-.7*mouthPart);
        #endif
        #ifdef USE_IRIDESCENCE
          material.iridescence*=(1.-lidMatte)*(1.-mouthPart);
        #endif`);
  };
  function applyLook(name: string) {
    const look=looks[name] ?? looks.violet; currentLook=looks[name] ? name : 'violet';
    lidGlow.value.set(look.lidColor).multiplyScalar(lidGlowStrength);
    // Violet opens the skull: clip above the cut, draw both sides so the inside of the head shows, light the cut band.
    crown?.setVisible(look.crown); cutGlow.value=look.crown && crown ? 1.4 : 0;
    material.clippingPlanes=look.crown && crown ? crown.planes : null; material.clipIntersection=true; material.side=look.crown ? THREE.DoubleSide : THREE.FrontSide;
    material.color.set(look.color); material.emissive.set(look.eyes);
    Object.assign(material,{ metalness: look.metalness, roughness: look.roughness, clearcoat: look.clearcoat,
      clearcoatRoughness: look.clearcoatRoughness, iridescence: look.iridescence, envMapIntensity: look.envMapIntensity });
    renderer.toneMapping=look.toneMapping; renderer.toneMappingExposure=look.exposure; material.needsUpdate=true;
    // The neon environment still tints a pale surface through the clearcoat even at zero intensity; drop it entirely.
    scene.environment=look.envMapIntensity>0 ? environment.texture : null; hemisphere.intensity=.35*look.lights;
    for (const { light, power, color } of lights) { light.intensity=power*look.lights; light.color.set(look.lightTint ?? color); }
    lookGradient.edge.value=look.edge;
    rimFire.strength.value=look.rim.strength*(lite && look.sheen ? 1.3 : 1); rimFire.power.value=look.rim.power; rimFire.colorA.value.set(look.rim.colorA);
    rimFire.colorB.value.set(look.rim.colorB); rimFire.scale.value=look.rim.scale; rimFire.flicker.value=look.rim.flicker; rimFire.variation.value=look.rim.variation;
    material.sheen=lite ? 0 : look.sheen; material.sheenColor.set(look.sheenColor); material.sheenRoughness=.55;
    lookGradient.low.value.set(look.gradient.low); lookGradient.high.value.set(look.gradient.high);
    lookGradient.from.value=look.gradient.from; lookGradient.to.value=look.gradient.to;
    lookGradient.glow.value=look.gradient.glow; lookGradient.tint.value=look.gradient.tint; lookGradient.eyeCut.value=look.gradient.eyeCut;
  }
  // ?look=neon on the page URL picks another preset; the default is the violet look with the open skull.
  applyLook(new URLSearchParams(location.search).get('look') ?? 'violet');
  const stage=new THREE.Group(); scene.add(stage);
  const heads: THREE.Mesh[] = [], geometries: THREE.BufferGeometry[] = [];
  // While the skull cap is lifted the head and its cap copy are cut by different planes; each draw selects its own,
  // and the slot glow follows (with both planes equal, the glow sits on that single cut edge).
  const caps: THREE.SkinnedMesh[] = [], pendingCaps: [THREE.Mesh, THREE.SkinnedMesh][] = [];
  const headCut=[new THREE.Plane(),new THREE.Plane()], capCut=[new THREE.Plane(),new THREE.Plane()];
  // The cap has its own material (a copy of the skin) so its cut, glow edge and shift never mix with the head's.
  const capMaterial=new THREE.MeshPhysicalMaterial(), capCutLow={ value: new THREE.Vector4() }, capCutHigh={ value: new THREE.Vector4() };
  const capShiftOn={ value: new THREE.Vector3() }, capInverseOn={ value: new THREE.Matrix4() };
  capMaterial.onBeforeCompile=(shader,renderer)=>{ material.onBeforeCompile(shader,renderer);
    Object.assign(shader.uniforms,{ cutLow: capCutLow, cutHigh: capCutHigh, capShift: capShiftOn, capInverse: capInverseOn }); };
  capMaterial.customProgramCacheKey=()=>'kelly-cap';
  let capSynced='';
  let disposed=false, frame=0, size: THREE.Vector3 | undefined, lastTime=0, mixer: THREE.AnimationMixer | undefined, topBleed=0;
  let lastState: ConversationState='idle', listenTimer=3, sinceYawn=0, idleFor=0, idleYawnAfter=firstIdleYawn, tiltRelease=0, glanceIn=glanceEvery(), viewShift=0, viewShiftX=0;
  let cuePlayback: AvatarPlayback | null=null, nextCue=0, previewState: ConversationState | null=null;
  const actions=new Map<string, THREE.AnimationAction>(), lip: Partial<Record<string, number>>={}, clipMorphs: number[][]=[];
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const phoneView=matchMedia('(max-width: 700px)');
  const desktopView=matchMedia('(min-width: 1001px)');
  // Adds on top of what the gesture clips wrote this frame.
  function morph(name: string,value: number) { for (const mesh of heads) { const i=mesh.morphTargetDictionary?.[name]; if (i!==undefined && mesh.morphTargetInfluences) mesh.morphTargetInfluences[i]=THREE.MathUtils.clamp(mesh.morphTargetInfluences[i]+value,0,1); } }
  // Eased weight changes that start from the current weight, so a pose can leave and come back from where it is.
  const blends=new Map<THREE.AnimationAction, { from: number; to: number; elapsed: number; seconds: number }>();
  const ease=(action: THREE.AnimationAction, to: number, seconds: number) => blends.set(action,{ from: action.getEffectiveWeight(), to, elapsed: 0, seconds });
  function play(name: Gesture) {
    const action=actions.get(name), strength=gestureTuning[name]?.strength ?? 1;
    if (reduced.matches || !action) return;
    if (blends.has(action)) { ease(action,strength,resumeSeconds); return; }
    // Restarting a running or held clip would snap it back to its first pose.
    if (action.isRunning() || (action.isScheduled() && action.paused)) return;
    action.reset().setEffectiveWeight(strength).play();
  }
  function release(name: Gesture) { const action=actions.get(name); if (action?.isScheduled()) ease(action,0,releaseSeconds); }
  function blend(dt: number) {
    for (const [action,fade] of blends) {
      fade.elapsed+=dt;
      const progress=Math.min(fade.elapsed/fade.seconds,1);
      action.setEffectiveWeight(THREE.MathUtils.lerp(fade.from,fade.to,THREE.MathUtils.smoothstep(progress,0,1)));
      if (progress<1) continue;
      blends.delete(action);
      if (fade.to===0) action.stop();
    }
  }
  const running=(name: string) => !!actions.get(name)?.isRunning();
  // Glances are background motion: they never block a gesture or count as activity.
  const gesturing=() => [...actions.keys()].some(name => name!=='breathe' && name!=='posture' && !glances.includes(name as Gesture) && running(name));
  function cue(gesture: SpeechGesture) { if (gesture==='tilt') { play('think'); tiltRelease=1.6; } else play(gesture); }
  // Clicks and key presses count as the user being active.
  function userActive() { idleFor=0; idleYawnAfter=firstIdleYawn; }
  addEventListener('pointerdown',userActive); addEventListener('keydown',userActive);
  // Rest is the wake clip held on its first frame. Leaving it blends directly
  // to the forward-facing posture, without playing the full wake sequence.
  function sleep(seconds: number) {
    const action=actions.get('wake'); if (!action) return;
    blends.delete(action); action.reset().play(); action.paused=true;
    if (seconds>0 && !reduced.matches) { action.setEffectiveWeight(0); ease(action,1,seconds); } else action.setEffectiveWeight(1);
  }
  function wakeUp() {
    // The brain lights up as she opens her eyes.
    if (looks[currentLook]?.crown) crown?.pulse();
    const action=actions.get('wake'); if (!action) return;
    // Keep the bowed pose frozen and gently remove its weight. The existing
    // posture underneath raises the head to face the viewer, with no overshoot.
    action.paused=true;
    if (reduced.matches) { blends.delete(action); action.stop(); }
    else ease(action,0,releaseSeconds);
  }
  function direct(state: ConversationState, dt: number, playback: AvatarPlayback | null, playing: boolean) {
    if (state!==lastState) {
      if (lastState==='idle') wakeUp();
      if (state==='idle') sleep(1.5);
      if (state==='thinking') play('think'); else if (lastState==='thinking') release('think');
      lastState=state; listenTimer=2+Math.random()*3;
    }
    // Speech gestures fire slightly before the marked words, at the same fraction of the audio.
    if (playback!==cuePlayback) { cuePlayback=playback; nextCue=0; }
    const duration=playback?.audio.duration ?? NaN;
    while (playing && playback && Number.isFinite(duration) && nextCue<playback.gestures.length && playback.audio.currentTime>=playback.gestures[nextCue].at*duration-gestureLead) cue(playback.gestures[nextCue++].gesture);
    if (tiltRelease>0 && (tiltRelease-=dt)<=0 && state!=='thinking') release('think');
    blend(dt);
    const recording=!!options.getRecording?.();
    // Now and then, look slowly to one side; never while asleep, thinking or listening to the user.
    if ((state==='listening' && !recording) || state==='speaking') {
      if ((glanceIn-=dt)<=0) { glanceIn=glanceEvery(); if (!gesturing() && !glances.some(running)) play(glances[Math.random()<.5 ? 0 : 1]); }
    } else glanceIn=glanceEvery();
    // Awake while nobody talks: yawn after 20 s, then at longer, irregular intervals until someone acts.
    if (state!=='listening' || recording || playing) { idleFor=0; idleYawnAfter=firstIdleYawn; }
    else if (gesturing()) idleFor=0;
    else if ((idleFor+=dt)>=idleYawnAfter) { idleFor=0; idleYawnAfter=30+Math.random()*15; sinceYawn=0; play('yawn'); }
    if (state!=='listening' || !recording) return;
    // While the user talks: nod every few seconds, and a rare yawn after a long monologue.
    listenTimer-=dt; sinceYawn+=dt;
    if (listenTimer>0) return;
    listenTimer=3.5+Math.random()*3.5;
    if (gesturing()) return;
    if (sinceYawn>45 && Math.random()<.2) { sinceYawn=0; play('yawn'); } else play('nod');
  }
  // The host's last size and page position: when only its height changes (the start screen hands over to the
  // conversation), Kelly keeps her size and place on the page for that frame and then glides to the new framing.
  let lastHost: { width: number; height: number; top: number } | undefined;
  function resize() {
    if (disposed) return;
    const width=host.clientWidth || 1,height=host.clientHeight || 1,top=host.getBoundingClientRect().top+scrollY;
    const glide=!!size && !!options.portrait && !!lastHost && lastHost.width===width && lastHost.height!==height && !reduced.matches;
    if (glide) {
      camera.position.z*=height/lastHost!.height;
      viewShift+=top-lastHost!.top+(height-lastHost!.height)/2;
    }
    lastHost={ width,height,top };
    topBleed=options.portrait && desktopView.matches ? Math.ceil(height*.4) : 0;
    camera.aspect=width/height; camera.updateProjectionMatrix();
    const viewport=portraitViewport(height,viewShift,topBleed);
    renderer.setSize(width,viewport.renderHeight);
    Object.assign(renderer.domElement.style,{position:'absolute',top:`${-topBleed}px`,width:'100%',height:`${viewport.renderHeight}px`});
    if (size) {
      if (options.portrait) fitPortrait(glide ? 0 : null);
      else {
        const angle=Math.tan(THREE.MathUtils.degToRad(camera.fov)/2), halfHeight=.95,halfWidth=size.x/size.y*halfHeight;
        const distance=Math.max(halfHeight/angle,halfWidth/(angle*camera.aspect))*1.14+size.z/size.y;
        camera.position.set(0,.04,distance);
        if (controls) { controls.minDistance=distance*.65; controls.maxDistance=distance*1.7; controls.update(); }
      }
    }
    // Changing the drawing-buffer size clears it. ResizeObserver runs before
    // paint, so redraw here rather than exposing a transparent frame until RAF.
    renderer.render(scene,camera);
  }
  // Portrait framing, in world units: the bust is 1.9 tall and centred, so the head top sits at .95.
  // The camera keeps room above it for gestures that raise the head, keeps it below the page text,
  // and only zooms out when the face and neck would not otherwise fit above the bottom of the screen.
  // Critically damped follow: starts and settles gently, so a framing change never jolts the bust.
  const framingVelocity={ z: 0, shift: 0, x: 0 };
  function smoothDamp(current: number, target: number, key: 'z' | 'shift' | 'x', dt: number) {
    const omega=2/framingSeconds, x=omega*dt, decay=1/(1+x+.48*x*x+.235*x*x*x);
    const change=current-target, push=(framingVelocity[key]+omega*change)*dt;
    framingVelocity[key]=(framingVelocity[key]-omega*push)*decay;
    return target+(change+push)*decay;
  }
  // dt null snaps to the framing (first layout and window resizes).
  function fitPortrait(dt: number | null) {
    const height=host.clientHeight || 1, tan=Math.tan(THREE.MathUtils.degToRad(camera.fov)/2);
    const designDistance=(Math.max(.88/tan,.68/(tan*camera.aspect))+size!.z/size!.y*.3)*.9;
    const rect=host.getBoundingClientRect();
    const headroom=Math.max(0,options.getHeadroom?.() ?? 0), visibleBottom=height-Math.max(0,rect.bottom-innerHeight);
    const width=host.clientWidth || 1;
    const bottomAnchored=!!options.getBottomAnchored?.();
    // Once the intro leaves on desktop, frame the face and bust as the subject.
    // The decorative halo may extend outside the frame instead of shrinking Kelly.
    const focusAvatar=bottomAnchored && desktopView.matches;
    // Above the button, leave a band for the chest: Kelly sits higher and her torso shows before it fades out.
    const covered=Math.max(0,options.getFootroom?.() ?? 0), chest=covered ? Math.min(40,height*.05) : 0, footroom=bottomAnchored ? 0 : covered+chest;
    const { distance, viewShift: shift }=portraitFrame({ width,height,headroom,visibleBottom,tan,designDistance,eyeLevel,footroom,
      bottomAnchored, bottomCrop:focusAvatar ? Math.min(96,height*.14) : 0,
      points:[{ x:0,y:headClearance,z:0 },{ x:0,y:bottomAnchored ? -.95 : neckLine,z:0 },...(looks[currentLook]?.crown && !focusAvatar ? crownPortraitPoints : [])] });
    camera.position.y=eyeLevel;
    const shiftX=options.getShiftX?.() ?? 0;
    if (dt===null) { camera.position.z=distance; viewShift=shift; viewShiftX=shiftX; framingVelocity.z=framingVelocity.shift=framingVelocity.x=0; }
    else { camera.position.z=smoothDamp(camera.position.z,distance,'z',dt); viewShift=smoothDamp(viewShift,shift,'shift',dt); viewShiftX=smoothDamp(viewShiftX,shiftX,'x',dt); }
    const viewport=portraitViewport(height,viewShift,topBleed);
    camera.setViewOffset(width,height,-viewShiftX,viewport.offsetY,width,viewport.renderHeight);
    // Where her shoulders are, in pixels up from the canvas bottom: the stylesheet keeps her solid down to the
    // shoulder line and fully faded a little below it, whatever the screen size.
    for (const [name,y] of [['--bust-solid',bustSolid],['--bust-clear',bustClear]] as const) {
      const px=`${Math.round((bustPoint.set(0,y,0).project(camera).y+1)/2*viewport.renderHeight)}px`;
      if (host.style.getPropertyValue(name)!==px) host.style.setProperty(name,px);
    }
  }
  const bustPoint=new THREE.Vector3();
  const observer=new ResizeObserver(resize); observer.observe(host); resize();
  function draw(time: number) {
    if (disposed || document.hidden) return;
    const elapsed=time-lastTime, dt=Math.min(elapsed/1000,.05); lastTime=time;
    if (meter) { meterFrames++; meterSince+=elapsed; if (meterSince>500) { meter.textContent=`${Math.round(meterFrames*1000/meterSince)} fps · tela ${Math.round(1000/cadenceMs)} Hz · ${pixelRatio.toFixed(2)}x${lite ? ' · leve' : ''}`; meterFrames=0; meterSince=0; } }
    // Adaptive resolution: average the frame time and drop the supersampling a step when frames run slow.
    frameMs=frameMs*.95+Math.min(elapsed,100)*.05; sinceRatioChange+=dt;
    // The cadence is the display's refresh: a low percentile of the last 60 intervals (single frames jitter), snapped to
    // the nearest common rate (120, 60 or 30 Hz), known within about a second.
    if (elapsed>4 && elapsed<200) {
      intervals.push(elapsed); if (intervals.length>60) intervals.shift();
      const low=[...intervals].sort((a,b)=>a-b)[Math.floor(intervals.length*.2)];
      cadenceMs=[1000/120,1000/60,1000/30].reduce((best,rate)=>Math.abs(rate-low)<Math.abs(best-low) ? rate : best);
    }
    if (intervals.length>=30 && frameMs>cadenceMs*1.5 && sinceRatioChange>1.5 && pixelRatio>lowestRatio) {
      pixelRatio=Math.max(lowestRatio,pixelRatio-.25); renderer.setPixelRatio(pixelRatio); sinceRatioChange=0; frameMs=cadenceMs;
    }
    const playback=options.getPlayback();
    const playing=!!playback && !playback.audio.paused && !playback.audio.ended;
    const pose=playback ? mouthPoseAt(playback.cues,playback.audio.currentTime,playing) : {};
    const state=previewState ?? options.getState();
    // The mixer only writes expressions when they change, so restore its last output before adding lip-sync and blinks.
    heads.forEach((mesh,i)=>{ const values=mesh.morphTargetInfluences; if (values) for (let j=0;j<values.length;j++) values[j]=clipMorphs[i]?.[j] ?? 0; });
    direct(state,dt,playback,playing); mixer?.update(dt);
    heads.forEach((mesh,i)=>{ clipMorphs[i]=[...mesh.morphTargetInfluences ?? []]; });
    for (const name of mouthMorphs) {
      lip[name]=playing ? THREE.MathUtils.lerp(lip[name] ?? 0,pose[name] ?? 0,1-Math.exp(-dt*35)) : 0;
      morph(name,lip[name]!);
    }
    const idle=state==='idle',seconds=time/1000,blinkPhase=seconds%4.7;
    const blink=idle ? 1 : reduced.matches || eyeGestures.some(running) ? 0 : blinkPhase<.25 ? Math.sin(blinkPhase/.25*Math.PI) : 0;
    morph('EyeBlink_L',blink); morph('EyeBlink_R',blink);
    // How closed the eyes are after clips, blinks and sleep, for the lid shading.
    const lids=heads[0]?.morphTargetDictionary, closedBy=(name: string) => heads[0]?.morphTargetInfluences?.[lids?.[name] ?? -1] ?? 0;
    lidClosed.value=(closedBy('EyeBlink_L')+closedBy('EyeBlink_R'))/2;
    // A barely visible sway keeps her alive while she faces the viewer.
    stage.rotation.y=reduced.matches ? 0 : Math.sin(seconds*.3)*.02;
    material.envMapRotation.y=reduced.matches ? 0 : Math.sin(seconds*.16)*.12;
    rimFire.time.value=reduced.matches ? 0 : seconds;
    if (crown) { crown.setPortal(options.getTheme?.()==='light'); crown.setPortalScale(phoneView.matches ? 1.22 : 1); }
    if (crown && looks[currentLook]?.crown) {
      crown.setVoice(options.getMicLevel?.() ?? 0); crown.setBrainOut(!!options.getBrainOut?.()); crown.setInvite(!!options.getInvite?.());
      scene.updateMatrixWorld(); crown.update(reduced.matches ? 0 : seconds);
      for (const [uniform,plane] of [[cutLow,crown.planes[0]],[cutHigh,crown.planes[1]]] as const) uniform.value.set(plane.normal.x,plane.normal.y,plane.normal.z,plane.constant);
      // Cap open: the head keeps only what is below the slot, and a copy shifted up keeps only what was above it.
      const open=crown.cap.lift.lengthSq()>0;
      for (const cap of caps) cap.visible=open;
      if (open) {
        headCut[0].copy(crown.planes[0]); headCut[1].copy(crown.planes[0]); material.clippingPlanes=headCut;
        // The cap copy is the part above the slot's upper face before lifting, moved up as one piece.
        capCut[0].copy(crown.planes[1]); capCut[0].constant-=capCut[0].normal.dot(crown.cap.lift); capCut[1].copy(capCut[0]);
        if (capSynced!==currentLook) { const onBefore=capMaterial.onBeforeCompile, key=capMaterial.customProgramCacheKey; capMaterial.copy(material); capMaterial.onBeforeCompile=onBefore; capMaterial.customProgramCacheKey=key; capMaterial.needsUpdate=true; capSynced=currentLook; }
        capMaterial.clippingPlanes=capCut; capMaterial.clipIntersection=true;
        for (const [uniform,plane] of [[cutLow,headCut[0]],[cutHigh,headCut[1]],[capCutLow,capCut[0]],[capCutHigh,capCut[1]]] as const) uniform.value.set(plane.normal.x,plane.normal.y,plane.normal.z,plane.constant);
        capShiftOn.value.copy(crown.cap.lift); if (caps[0]) capInverseOn.value.copy(caps[0].matrixWorld).invert();
      } else material.clippingPlanes=crown.planes;
    }
    // Ease toward the framing so the bust glides when a message appears below the title.
    if (options.portrait && size) fitPortrait(dt);
    controls?.update(); renderer.render(scene,camera); frame=requestAnimationFrame(draw);
  }
  function visibility() { cancelAnimationFrame(frame); if (!document.hidden && !disposed) { lastTime=performance.now(); frame=requestAnimationFrame(draw); } }
  document.addEventListener('visibilitychange',visibility);
  // Memory count for the brain's glow: read when the memory channel connects and again each time it reports a
  // committed memory. Failures keep the last glow; the channel reconnects if the server restarts.
  let memoryCount: number | null = null, memorySocket: WebSocket | undefined, memoryRetry: ReturnType<typeof setTimeout> | undefined;
  async function readMemoryCount() {
    try {
      const data: unknown = await (await fetch('/api/memory/count',{ cache: 'no-store', signal: controller.signal })).json();
      const count=(data as { enabled?: boolean; count?: unknown })?.count;
      if ((data as { enabled?: boolean })?.enabled && typeof count==='number' && Number.isInteger(count)) { if (memoryCount!==null && count>memoryCount) options.onNewMemory?.(); memoryCount=count; crown?.setMemories(count); }
    } catch { /* keep the current glow */ }
  }
  function watchMemories() {
    if (disposed) return;
    memorySocket=new WebSocket(`${location.protocol==='https:' ? 'wss:' : 'ws:'}//${location.host}/ws/memories`);
    memorySocket.onmessage=()=>void readMemoryCount();
    memorySocket.onclose=()=>{ if (!disposed) memoryRetry=setTimeout(watchMemories,5000); };
  }
  watchMemories();
  const load=options.loadModel ?? (async (signal: AbortSignal) => { const response=await fetch('/avatars/kelly.glb',{signal}); if(!response.ok) throw Error('Model unavailable'); return response.arrayBuffer(); });
  void load(controller.signal).then(bytes=>new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes,'')).then(gltf=>{
    if(disposed)return;
    const avatar=gltf.scene;
    avatar.traverse(object=>{if(!(object instanceof THREE.Mesh))return;
      for(const original of Array.isArray(object.material) ? object.material : [object.material]) original.dispose();
      // Gestures move the skin beyond the rest-pose bounds.
      object.material=material; object.frustumCulled=false; heads.push(object); geometries.push(object.geometry);
      // The skull cap's copy: same geometry, skeleton and expressions, hidden unless the cap is lifted.
      if (object instanceof THREE.SkinnedMesh) {
        const cap=new THREE.SkinnedMesh(object.geometry,material); cap.bind(object.skeleton,object.bindMatrix);
        cap.position.copy(object.position); cap.quaternion.copy(object.quaternion); cap.scale.copy(object.scale);
        cap.morphTargetInfluences=object.morphTargetInfluences; cap.morphTargetDictionary=object.morphTargetDictionary;
        cap.frustumCulled=false; cap.visible=false; cap.name='cap'; pendingCaps.push([object,cap]);
        cap.material=capMaterial;
      }
      // The lid and mouth marks arrive as vertex colour; keep them under their own name so they never tint the surface.
      const colors=object.geometry.getAttribute('color'), lid=new Float32Array(object.geometry.getAttribute('position').count*4).fill(1);
      if (colors) for (let i=0;i<lid.length/4;i++) lid.set([colors.getX(i),colors.getY(i),colors.getZ(i),colors.itemSize>3 ? colors.getW(i) : 1],i*4);
      object.geometry.setAttribute('lid',new THREE.BufferAttribute(lid,4)); object.geometry.deleteAttribute('color');
    });
    for (const [head,cap] of pendingCaps) { head.parent?.add(cap); caps.push(cap); }
    mixer=new THREE.AnimationMixer(avatar);
    for (const clip of gltf.animations) {
      THREE.AnimationUtils.makeClipAdditive(clip,neutralFrame[clip.name] ?? 0,clip,30);
      const action=mixer.clipAction(clip,undefined,THREE.AdditiveAnimationBlendMode);
      if (clip.name==='breathe') action.setLoop(THREE.LoopRepeat,Infinity);
      else { action.setLoop(THREE.LoopOnce,1); action.clampWhenFinished=clip.name==='think' || clip.name==='posture'; action.timeScale=gestureTuning[clip.name as Gesture]?.speed ?? 1; }
      actions.set(clip.name,action);
    }
    // The sculpted neutral tilts the face up; posture levels it and holds underneath every gesture, even with reduced motion.
    actions.get('posture')?.play();
    if (lastState==='idle') sleep(0);
    if (!reduced.matches) actions.get('breathe')?.play();
    // Dev-only console hook for previewing gestures without a paid voice round trip.
    // kellyState('listening') previews a conversation state; kellyState(null) returns to the real one.
    if (import.meta.env.DEV) Object.assign(window,{kellyGesture:play,kellyState:(state: ConversationState | null)=>{ previewState=state; },kellyLook:applyLook,kellyMemories:(count: number)=>crown?.setMemories(count),kellyInternals:{ material, lights, hemisphere, renderer, scene, camera },
      // Active expressions and running clips, for checking that a gesture returned to neutral.
      kellyDebug:()=>({ pixelRatio, frameMs:+frameMs.toFixed(1), viewShift, cameraZ:camera.position.z, headPitch:THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(avatar.getObjectByName('head')!.getWorldQuaternion(new THREE.Quaternion())).x),
        clips:[...actions].filter(([,action])=>action.isScheduled()).map(([name,action])=>`${name}:${action.getEffectiveWeight().toFixed(2)}`),
        expressions:Object.entries(heads[0].morphTargetDictionary ?? {}).map(([name,i])=>[name,heads[0].morphTargetInfluences![i]] as const).filter(([,value])=>value>.01) })});
    const bust=new THREE.Group(); bust.add(avatar);
    const bounds=new THREE.Box3().setFromObject(bust,true);
    // The torso continues below where the bust used to end (marked by FramingBottom); scale and framing keep using the
    // original bust, so the head, the crown and every framing constant stay where they were.
    const floor=avatar.getObjectByName('FramingBottom');
    if (floor) { bust.updateMatrixWorld(true); bounds.min.y=floor.getWorldPosition(new THREE.Vector3()).y; }
    size=bounds.getSize(new THREE.Vector3());
    bust.position.copy(bounds.getCenter(new THREE.Vector3())).negate(); stage.add(bust); stage.scale.setScalar(1.9/size.y);
    crown=createCrown(stage,avatar.getObjectByName('head')!); applyLook(currentLook);
    if (memoryCount!==null) crown.setMemories(memoryCount);
    const ray=new THREE.Raycaster(), centre=new THREE.Vector3();
    const brainOnPage=(rect: DOMRect)=>{ crown!.brainCentre(centre).project(camera); return { x:rect.left+(centre.x+1)/2*rect.width, y:rect.top+(1-centre.y)/2*rect.height }; };
    options.onBrainProbe?.((clientX,clientY)=>{
      if (!crown || !looks[currentLook]?.crown) return null;
      const rect=renderer.domElement.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      ray.setFromCamera(new THREE.Vector2((clientX-rect.left)/rect.width*2-1,-((clientY-rect.top)/rect.height)*2+1),camera);
      if (!crown.hitBrain(ray)) return null;
      return brainOnPage(rect);
    });
    const top=new THREE.Vector3();
    options.onSubjectTop?.(()=>{
      const rect=renderer.domElement.getBoundingClientRect();
      if (!rect.height) return null;
      if (crown && looks[currentLook]?.crown) crown.visualTop(top); else top.set(0,headClearance,0);
      top.project(camera);
      return rect.top+(1-top.y)/2*rect.height;
    });
    options.onBrainLocator?.(()=>crown && looks[currentLook]?.crown ? brainOnPage(renderer.domElement.getBoundingClientRect()) : null);
    resize(); options.onReady?.(); lastTime=performance.now(); if(!document.hidden)frame=requestAnimationFrame(draw);
  }).catch(()=>{if(!disposed)options.onError();});
  return () => {
    disposed=true; meter?.remove(); controller.abort(); clearTimeout(memoryRetry); memorySocket?.close(); cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('visibilitychange',visibility);
    removeEventListener('pointerdown',userActive); removeEventListener('keydown',userActive);
    mixer?.stopAllAction(); controls?.dispose(); for(const geometry of geometries)geometry.dispose(); material.dispose(); crown?.dispose(); eyeMap.dispose(); environment.dispose();
    renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
  };
}
