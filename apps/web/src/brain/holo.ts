import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// The brain shape: a human brain (cerebrum and cerebellum, the stem removed) simplified to a few thousand triangles, centred,
// its longest side (front to back) 2 units, the front toward +z. Source: "Human brain, Cerebrum & Brainstem" by
// pranktoy on Sketchfab, CC BY 4.0, remeshed and smoothed.
const url = '/avatars/brain.glb';
let shape: Promise<THREE.BufferGeometry> | undefined;
export function loadBrainShape(): Promise<THREE.BufferGeometry> {
  shape ??= new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url).then((gltf) => {
    let geometry: THREE.BufferGeometry | undefined;
    gltf.scene.traverse((object) => { if (!geometry && (object as THREE.Mesh).isMesh) geometry = (object as THREE.Mesh).geometry; });
    if (!geometry) throw new Error('Brain shape missing.');
    return geometry;
  });
  return shape;
}
// Where memories may sit, in the shape's units: inside the cerebrum, clear of the surface.
export const memoryVolume = { centre: new THREE.Vector3(0, .04, .02), radii: new THREE.Vector3(.6, .46, .78) };

export type HoloBrain = {
  group: THREE.Group;
  // Brightness 0..1 (memories learned), a transient flash, and the overall fade.
  set(values: { level?: number; flash?: number; fade?: number }): void;
  update(seconds: number): void;
  dispose(): void;
};
// Curvature per vertex, 0..1: how far the neighbours rise above the surface, high in the creases (sulci).
function creases(geometry: THREE.BufferGeometry): THREE.BufferAttribute {
  const position = geometry.attributes.position, normal = geometry.attributes.normal, index = geometry.index!;
  const neighbours = Array.from({ length: position.count }, () => new Set<number>());
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
    neighbours[a].add(b).add(c); neighbours[b].add(a).add(c); neighbours[c].add(a).add(b);
  }
  let curve = new Float32Array(position.count);
  const v = new THREE.Vector3(), n = new THREE.Vector3(), w = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i); n.fromBufferAttribute(normal, i);
    let sum = 0; for (const j of neighbours[i]) { w.fromBufferAttribute(position, j).sub(v); sum += n.dot(w) / Math.max(w.length(), 1e-5); }
    curve[i] = sum / Math.max(1, neighbours[i].size);
  }
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(curve.length);
    for (let i = 0; i < curve.length; i++) { let sum = curve[i]; for (const j of neighbours[i]) sum += curve[j]; next[i] = sum / (neighbours[i].size + 1); }
    curve = next;
  }
  const sorted = [...curve].sort((a, b) => a - b), low = sorted[Math.floor(sorted.length * .05)], high = sorted[Math.floor(sorted.length * .95)];
  return new THREE.BufferAttribute(curve.map((value) => Math.min(1, Math.max(0, (value - low) / (high - low)))), 1);
}

// X-ray: no solid surface. The rim glows, the creases are traced faintly, and the whole thing breathes slowly;
// the memories inside are the brightest thing in view. Light theme: drawn as violet ink on the pale page instead of light.
export function createHoloBrain(geometry: THREE.BufferGeometry, { light = false, color }: { light?: boolean; color?: number } = {}): HoloBrain {
  color ??= light ? 0x6a45c4 : 0xc9a8ff;
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  if (!geometry.attributes.aCrease) geometry.setAttribute('aCrease', creases(geometry));
  const uniforms = { uTime: { value: 0 }, uLevel: { value: 1 }, uFlash: { value: 0 }, uFade: { value: 1 }, uColor: { value: new THREE.Color(color) } };
  const material = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, blending: light ? THREE.NormalBlending : THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: `attribute float aCrease; varying float vCrease; varying vec3 vNormal; varying vec3 vView;
      void main(){ vCrease=aCrease; vec4 mv=modelViewMatrix*vec4(position,1.); vView=-mv.xyz; vNormal=normalize(normalMatrix*normal); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform float uTime, uLevel, uFlash, uFade; uniform vec3 uColor; varying float vCrease; varying vec3 vNormal; varying vec3 vView;
      void main(){
        float facing=abs(dot(normalize(vNormal),normalize(vView))), rim=pow(1.-facing,3.);
        float crease=smoothstep(.7,.95,vCrease)*facing;
        float breath=.5+.5*sin(uTime*1.4), energy=.6+.4*uLevel+.12*breath+1.1*uFlash;
        float amount=(rim*.45+crease*.12+.01)*energy*uFade;
        gl_FragColor=${light ? 'vec4(uColor,min(1.,amount*.6))' : 'vec4(uColor*amount,1.)'};
      }`,
  });
  const group = new THREE.Group(); group.add(new THREE.Mesh(geometry, material));
  return {
    group,
    set(values) {
      if (values.level !== undefined) uniforms.uLevel.value = values.level;
      if (values.flash !== undefined) uniforms.uFlash.value = values.flash;
      if (values.fade !== undefined) uniforms.uFade.value = values.fade;
    },
    update(seconds) { uniforms.uTime.value = seconds; },
    dispose() { material.dispose(); },
  };
}
