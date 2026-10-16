import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PortraitPoint } from './portrait';

// Include the portal's transparent shadow bounds and the orbit envelope. Keep
// the same clearance in both themes so switching themes cannot cross the text.
export const crownPortraitPoints: readonly PortraitPoint[] = [
  { x: 0, y: 2.2, z: -1.25 }, { x: 1.7, y: .5, z: -1.25 },
  { x: 0, y: 1.55, z: -1.1 }, { x: 1.05, y: .5, z: -1.1 },
  { x: .7, y: 1.5, z: .7 },
];

// Extras of the violet look: a lilac disc behind the head, a slot cut around the skull showing a glowing brain
// that pulses like a heartbeat, and dark spheres orbiting the head. Positions are world units of the 1.9-tall bust
// at rest (head top .95, skull centre about .53, front of the face toward +z).
export type Crown = {
  // The slot's lower and upper faces. Used together (clipIntersection), they remove only the band between them;
  // they follow the head as it moves.
  planes: [THREE.Plane, THREE.Plane];
  update(seconds: number): void;
  setVisible(visible: boolean): void;
  // Saved memories light the brain up; a new one also sends a brighter pulse through it.
  setMemories(count: number): void;
  // One bright beat through the brain (Kelly waking up).
  pulse(): void;
  // The user's voice while recording (loudness 0 to ~.3): the brain and the disc light up with it.
  setVoice(level: number): void;
  // The brain has risen out into the memories view: the slot is left empty until it comes back.
  setBrainOut(out: boolean): void;
  // Now and then a ring of light runs out from the slot, inviting a tap on the brain.
  setInvite(on: boolean): void;
  // The skull cap above the slot lifts straight up while the brain comes out: lift is its current offset in world space.
  // The page draws it as an exact copy of the head shifted by lift and cut by the slot's upper face.
  cap: { lift: THREE.Vector3 };
  // A dark night-sky circle behind the disc, for light pages; the scene itself stays as on the dark theme.
  setPortal(on: boolean): void;
  // Grow the portal (1 = framing the disc); on phones it is enlarged into a night backdrop that runs past the edges.
  setPortalScale(scale: number): void;
  // The highest visible point of the decoration (the portal's rim, or the disc without it), in scene units.
  visualTop(target: THREE.Vector3): THREE.Vector3;
  // Whether a ray from the camera touches the brain (with a little slack, so the slot is easy to tap), and where its centre is.
  hitBrain(ray: THREE.Raycaster): boolean;
  brainCentre(target: THREE.Vector3): THREE.Vector3;
  dispose(): void;
};

// The slot: its lower edge passes through point; height is its width across the skull; tilt via the normal.
const cut = { point: new THREE.Vector3(0, .6, 0), normal: new THREE.Vector3(0, -1, .18).normalize(), height: .14 };
// Sized to stay inside the skull, so it shows only through the slot.
// Memories at which the brain reaches full brightness. The curve is logarithmic, so the first ones show the most.
export const fullBrainMemories = 100;
export const brainLevel = (count: number) => Math.min(1, Math.log1p(Math.max(0, count)) / Math.log1p(fullBrainMemories));
// x matches the skull's centre line, which sits slightly right of the scene's axis in the model.
export const brain = { centre: new THREE.Vector3(.025, .66, -.06), radii: new THREE.Vector3(.27, .21, .3) };
const orbit = { centre: new THREE.Vector3(0, .8, -.04), radius: .62, tilt: new THREE.Euler(.16, 0, -.12) };
const spheres = [
  { size: .07, speed: .45, phase: 0 }, { size: .05, speed: .45, phase: 1.3 }, { size: .062, speed: .45, phase: 2.5 },
  { size: .045, speed: .45, phase: 3.7 }, { size: .066, speed: .45, phase: 5 },
];

// Cortex: an ellipsoid with a groove between the hemispheres and a flatter base. The folds are drawn per pixel in
// the shader from the `fold` attribute (each vertex's direction on the unit sphere), so they stay sharp up close.
// They come from domain-warped simplex noise: its zero lines meander like sulci instead of closing into cells.
const foldGlsl = `
  // 3D simplex noise (Ashima Arts / Stefan Gustavson, MIT).
  vec4 sxPermute(vec4 x){ return mod(((x*34.)+1.)*x,289.); }
  float snoise(vec3 v){
    const vec2 C=vec2(1./6.,1./3.); const vec4 D=vec4(0.,.5,1.,2.);
    vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
    vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
    vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+2.*C.xxx; vec3 x3=x0-1.+3.*C.xxx;
    i=mod(i,289.);
    vec4 p=sxPermute(sxPermute(sxPermute(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
    float n_=1./7.; vec3 ns=n_*D.wyz-D.xzx;
    vec4 j=p-49.*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.*x_);
    vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.-abs(x)-abs(y);
    vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
    vec4 s0=floor(b0)*2.+1.; vec4 s1=floor(b1)*2.+1.; vec4 sh=-step(h,vec4(0.));
    vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
    vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
    vec4 norm=inversesqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
    p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
    vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.); m=m*m;
    return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
  }
  // Plump gyri separated by narrow sulci, with a few smaller wrinkles on top.
  float cortexHeight(vec3 d) {
    vec3 p=d*1.9;
    vec3 warp=vec3(snoise(p),snoise(p+vec3(5.2,1.3,2.8)),snoise(p+vec3(9.7,4.1,7.3)))*.45;
    float gyri=smoothstep(0.,.5,abs(snoise((p+warp)*1.9)));
    return gyri*(.85+.15*snoise(p*7.));
  }
  float cortexFissure(vec3 d) { return exp(-d.x*d.x/.003)*(d.y>-.3 ? 1. : .3); }`;
function brainGeometry() {
  const geometry = mergeVertices(new THREE.IcosahedronGeometry(1, 6).deleteAttribute('normal').deleteAttribute('uv'));
  const position = geometry.attributes.position, fold = new Float32Array(position.count * 3), v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i).normalize();
    fold.set([v.x, v.y, v.z], i * 3);
    const fissure = Math.exp(-(v.x * v.x) / .003) * (v.y > -.3 ? 1 : .3);
    v.multiplyScalar(1 - .16 * fissure);
    if (v.y < 0) v.y *= .7;
    position.setXYZ(i, v.x * brain.radii.x, v.y * brain.radii.y, v.z * brain.radii.z);
  }
  geometry.setAttribute('fold', new THREE.BufferAttribute(fold, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export function createCrown(stage: THREE.Object3D, head: THREE.Object3D): Crown {
  // The bust's group is scaled to make it 1.9 tall; build in the unscaled scene, then hand pieces to the head bone.
  const root = stage.parent ?? stage;
  root.updateMatrixWorld(true);
  const toHead = head.matrixWorld.clone().invert();
  // The cut is stored in the head bone's space, so it rides along with nods, turns and yawns.
  const upperPoint = cut.point.clone().addScaledVector(cut.normal, -cut.height);
  const faces = [{ point: cut.point, normal: cut.normal }, { point: upperPoint, normal: cut.normal.clone().negate() }]
    .map(({ point, normal }) => ({ point: point.clone().applyMatrix4(toHead), normal: normal.clone().transformDirection(toHead) }));
  const planes: [THREE.Plane, THREE.Plane] = [new THREE.Plane(), new THREE.Plane()];
  // The cap lifts along the head's up axis, high enough for the risen brain to pass under it.
  const upLocal = new THREE.Vector3(0, 1, 0).transformDirection(toHead);
  const cap = { lift: new THREE.Vector3() };
  let level = 0, targetLevel = 0, flash = 0, lastSeconds = 0, known: number | null = null, voice = 0, voiceTarget = 0;

  const discColor = new THREE.Color(0xb48be6), discBright = new THREE.Color(0xd9c2ff), discMaterial = new THREE.MeshBasicMaterial({ color: discColor.clone() });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1.05, 128), discMaterial);
  disc.position.set(0, .5, -1.1); root.add(disc);
  // Night portal for light pages: a crisp dark circle a little wider than the disc, a thin lilac rim, a few faint
  // stars in the dark ring, and a soft shadow dropped onto the page. One 2048 px texture keeps the edge sharp.
  const portalSize = 3.4, portalRadius = 1.27, shadowRadius = 1.68, px = 2048 / portalSize;
  const portalCanvas = document.createElement('canvas'); portalCanvas.width = portalCanvas.height = 2048;
  const g = portalCanvas.getContext('2d')!, mid = 1024, r = portalRadius * px;
  const shadow = g.createRadialGradient(mid, mid + 26, r * .85, mid, mid + 26, shadowRadius * px);
  shadow.addColorStop(0, 'rgba(34,18,66,.30)'); shadow.addColorStop(1, 'rgba(34,18,66,0)');
  g.fillStyle = shadow; g.fillRect(0, 0, 2048, 2048);
  const sky = g.createRadialGradient(mid, mid * .94, 0, mid, mid, r);
  for (const [stop, color] of [[0, '#251543'], [.72, '#180e31'], [1, '#0e081e']] as const) sky.addColorStop(stop, color);
  g.fillStyle = sky; g.beginPath(); g.arc(mid, mid, r, 0, Math.PI * 2); g.fill();
  // Stars only in the visible ring between the lilac disc and the rim; fixed seed so they never shuffle.
  let seed = 7; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 90; i++) {
    const angle = random() * Math.PI * 2, distance = (1.09 + random() * .15) * px, size = .7 + random() * 1.9;
    g.fillStyle = `rgba(232,220,255,${.25 + random() * .6})`;
    g.beginPath(); g.arc(mid + Math.cos(angle) * distance, mid + Math.sin(angle) * distance, size, 0, Math.PI * 2); g.fill();
  }
  g.shadowColor = 'rgba(176,128,255,.9)'; g.shadowBlur = 22; g.strokeStyle = 'rgba(206,176,255,.95)'; g.lineWidth = 4;
  g.beginPath(); g.arc(mid, mid, r - 3, 0, Math.PI * 2); g.stroke();
  const portalMap = new THREE.CanvasTexture(portalCanvas); portalMap.colorSpace = THREE.SRGBColorSpace; portalMap.anisotropy = 8;
  const portal = new THREE.Mesh(new THREE.PlaneGeometry(portalSize, portalSize), new THREE.MeshBasicMaterial({ map: portalMap, transparent: true, depthWrite: false }));
  portal.position.set(0, .5, -1.25); portal.visible = false; root.add(portal);
  let portalWanted = false;

  const glow = new THREE.MeshPhysicalMaterial({ color: 0xf1e6ff, emissive: 0xd2a8ff, emissiveIntensity: 2, roughness: .35,
    clearcoat: .6, clearcoatRoughness: .2, sheen: .5, sheenColor: new THREE.Color(0xe2c8ff) });
  // Per pixel: the fold height darkens the sulci, tilts the normal like a bump map, and scales the glow,
  // so the gyri light up and the sulci stay dark between beats.
  glow.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute vec3 fold;\nvarying vec3 vFold;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFold=fold;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\nvarying vec3 vFold;\n${foldGlsl}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 foldDir=normalize(vFold);
        float cortexH=cortexHeight(foldDir), cortexLight=(.32+.68*cortexH)*(1.-.8*cortexFissure(foldDir));
        diffuseColor.rgb*=cortexLight;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        vec3 dpdx=dFdx(-vViewPosition), dpdy=dFdy(-vViewPosition);
        vec3 r1=cross(dpdy,normal), r2=cross(normal,dpdx); float det=dot(dpdx,r1);
        vec3 grad=sign(det)*(dFdx(cortexH)*r1+dFdy(cortexH)*r2)*.035;
        normal=normalize(abs(det)*normal-grad);`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= cortexLight;');
  };
  const cortex = new THREE.Mesh(brainGeometry(), glow);
  cortex.position.copy(brain.centre); root.add(cortex); cortex.updateMatrixWorld(true); head.attach(cortex);
  // Rest pose in the head's space, for lifting the brain out of the slot and settling it back.
  const cortexRest = cortex.position.clone(), cortexScale = cortex.scale.clone(), lift = new THREE.Vector3();
  glow.transparent = true;
  let rise = 0;

  // Invitation ring: flat, level with the slot, growing outward from the skull and fading.
  const waveMaterial = new THREE.MeshBasicMaterial({ color: 0xd2b4ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const wave = new THREE.Mesh(new THREE.RingGeometry(1, 1.035, 128), waveMaterial);
  wave.rotation.set(-Math.PI / 2 + Math.atan2(cut.normal.z, -cut.normal.y), 0, 0);
  wave.position.copy(cut.point).addScaledVector(cut.normal, -cut.height / 2); wave.visible = false;
  root.add(wave); wave.updateMatrixWorld(true); head.attach(wave);
  const waveBase = wave.scale.clone();
  let inviting = false, waveClock = 2.5, brainOut = false, shown = true;
  const hitSphere = new THREE.Sphere(), hitScale = new THREE.Vector3(), hitRadius = Math.max(brain.radii.x, brain.radii.y, brain.radii.z) * 1.15;

  const ring = new THREE.Group(); ring.position.copy(orbit.centre); ring.rotation.copy(orbit.tilt);
  root.add(ring); ring.updateMatrixWorld(true); head.attach(ring);
  const skin = new THREE.MeshPhysicalMaterial({ color: 0x2b1747, roughness: .55, sheen: .8, sheenColor: new THREE.Color(0x8a5ce8) });
  const ball = new THREE.SphereGeometry(1, 40, 20);
  const moons = spheres.map(({ size }) => { const moon = new THREE.Mesh(ball, skin); moon.scale.setScalar(size); ring.add(moon); return moon; });

  return {
    planes,
    cap,
    update(seconds) {
      const dt = Math.min(Math.max(seconds - lastSeconds, 0), .1); lastSeconds = seconds;
      // Glide to the new brightness over a couple of seconds; the flash fades out faster.
      level += (targetLevel - level) * (1 - Math.exp(-dt * 1.2)); flash = Math.max(0, flash - dt / 1.6);
      faces.forEach(({ point, normal }, i) => planes[i].setFromNormalAndCoplanarPoint(normal.clone().transformDirection(head.matrixWorld), point.clone().applyMatrix4(head.matrixWorld)));
      // Two quick beats, then rest: a heartbeat rather than a sine.
      const beat = (t: number) => Math.pow(Math.max(0, Math.sin(t)), 12);
      // Always pulsing, even with no memories yet: a dim base and beat that both grow with what she has learned.
      const pulse = beat(seconds * 2.4) + .55 * beat(seconds * 2.4 - .55);
      // Follow the voice quickly up and a little slower down, so syllables read as a flicker, not a strobe.
      voice += (voiceTarget - voice) * (1 - Math.exp(-dt * (voiceTarget > voice ? 18 : 7)));
      // Out to the memories view: the brain lifts clear of the skull, swells and brightens, then dissolves into light where
      // the hologram takes over (0.6 s). Coming back, it reappears there and settles into the slot again.
      // One 0.8 s move each way on an ease-in-out curve; the brain starts a beat after the cap and fades only at the end.
      rise = Math.min(1, Math.max(0, rise + (brainOut ? dt / .8 : -dt / .8)));
      const brainT = Math.min(1, Math.max(0, (rise - .15) / .85));
      const eased = brainT < .5 ? 4 * brainT ** 3 : 1 - (-2 * brainT + 2) ** 3 / 2, bell = Math.sin(Math.PI * brainT) * .5;
      // The cap leads: it opens over the first 60% of the move and closes over the last 60% on the way back.
      const capT = Math.min(1, rise / .6), capEase = capT < .5 ? 4 * capT ** 3 : 1 - (-2 * capT + 2) ** 3 / 2;
      cap.lift.copy(upLocal).transformDirection(head.matrixWorld).multiplyScalar(.5 * capEase);
      head.localToWorld(lift.copy(cortexRest)); lift.y += .34 * eased; head.worldToLocal(lift);
      cortex.position.copy(lift); cortex.scale.copy(cortexScale).multiplyScalar(1 + .35 * eased);
      const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
      glow.opacity = brainOut ? 1 - smooth(.75, 1, rise) : smooth(1, .78, rise);
      cortex.visible = shown && glow.opacity > .01;
      glow.emissiveIntensity = .55 + 2.2 * level + (.8 + 1.4 * level) * pulse + 3.5 * flash * flash + 5 * voice + 4 * bell;
      discMaterial.color.copy(discColor).lerp(discBright, Math.min(1, voice * 1.4));
      // Every 5.5 s while inviting: a 1.6 s ring from the skull outward, bright at first, gone as it widens.
      waveClock += dt;
      const t = waveClock / 1.6;
      if (t >= 1 && inviting && waveClock >= 5.5) waveClock = 0;
      wave.visible = shown && !brainOut && t < 1;
      if (wave.visible) { wave.scale.copy(waveBase).multiplyScalar(.36 + .5 * t); waveMaterial.opacity = .85 * (1 - t) * (1 - t); }
      spheres.forEach(({ speed, phase }, i) => {
        const angle = phase + seconds * speed;
        moons[i].position.set(Math.cos(angle) * orbit.radius, Math.sin(angle * 2 + phase) * .04, Math.sin(angle) * orbit.radius);
      });
    },
    setVisible(visible) { shown = visible; disc.visible = ring.visible = visible; cortex.visible = visible; portal.visible = visible && portalWanted; },
    setPortal(on) { portalWanted = on; portal.visible = on && disc.visible; },
    setPortalScale(scale) { portal.scale.setScalar(scale); },
    visualTop(target) {
      return portal.visible ? target.set(0, portal.position.y + portalRadius * portal.scale.y, portal.position.z) : target.set(0, disc.position.y + 1.05, disc.position.z);
    },
    hitBrain(ray) {
      if (!cortex.visible) return false;
      cortex.getWorldPosition(hitSphere.center); hitSphere.radius = hitRadius * cortex.getWorldScale(hitScale).x;
      return ray.ray.intersectsSphere(hitSphere);
    },
    brainCentre(target) { return cortex.getWorldPosition(target); },
    pulse() { flash = 1; },
    setBrainOut(out) { brainOut = out; },
    setInvite(on) { inviting = on; },
    setVoice(value) { voiceTarget = Math.min(1, Math.max(0, value) * 6); },
    setMemories(count) {
      if (known !== null && count > known) flash = 1;
      known = count; targetLevel = brainLevel(count);
    },
    dispose() {
      disc.geometry.dispose(); (disc.material as THREE.Material).dispose(); wave.geometry.dispose(); waveMaterial.dispose(); portal.geometry.dispose(); (portal.material as THREE.Material).dispose(); portalMap.dispose(); cortex.geometry.dispose(); glow.dispose(); ball.dispose(); skin.dispose();
    },
  };
}
