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
// Hologram: no solid surface. Thin horizontal slices run through the shape like a scanner, the rim glows,
// the main creases are traced as lines, a scan band climbs slowly and the whole thing beats like a heart.
export function createHoloBrain(geometry: THREE.BufferGeometry, { color = 0xc9a8ff, slices = 34 } = {}): HoloBrain {
  const uniforms = { uTime: { value: 0 }, uLevel: { value: 1 }, uFlash: { value: 0 }, uFade: { value: 1 }, uColor: { value: new THREE.Color(color) }, uSlices: { value: slices } };
  const beat = `float beat(float t){ return pow(max(0.,sin(t*2.4)),12.)+.55*pow(max(0.,sin(t*2.4-.55)),12.); }`;
  const shell = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    vertexShader: `varying vec3 vLocal; varying vec3 vNormal; varying vec3 vView;
      void main(){ vLocal=position; vec4 mv=modelViewMatrix*vec4(position,1.); vView=-mv.xyz; vNormal=normalize(normalMatrix*normal); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform float uTime, uLevel, uFlash, uFade, uSlices; uniform vec3 uColor; varying vec3 vLocal; varying vec3 vNormal; varying vec3 vView; ${beat}
      void main(){
        float facing=abs(dot(normalize(vNormal),normalize(vView))), rim=pow(1.-facing,2.6);
        float y=vLocal.y*uSlices*.5, w=fwidth(y)*1.2, slice=1.-smoothstep(0.,w,abs(fract(y+.5)-.5));
        float scan=exp(-pow((vLocal.y-(fract(uTime*.12)*2.6-1.3))*7.,2.));
        float pulse=beat(uTime), energy=.45+.55*uLevel+.35*pulse+1.2*uFlash;
        float light=(rim*.55+slice*(.16+.5*scan)+scan*.08+.012)*energy;
        gl_FragColor=vec4(uColor*light*uFade,1.);
      }`,
  }));
  // The creases worth tracing: edges where the surface folds by more than ~28°.
  const edgeGeometry = new THREE.EdgesGeometry(geometry, 28);
  const edgeMaterial = new THREE.LineBasicMaterial({ color, transparent: true, opacity: .16, depthWrite: false, blending: THREE.AdditiveBlending });
  const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  // A sparse lattice of nodes on the surface.
  const position = geometry.attributes.position as THREE.BufferAttribute, nodes: number[] = [];
  for (let i = 0; i < position.count; i += 7) nodes.push(position.getX(i), position.getY(i), position.getZ(i));
  const nodeGeometry = new THREE.BufferGeometry(); nodeGeometry.setAttribute('position', new THREE.Float32BufferAttribute(nodes, 3));
  const nodeMaterial = new THREE.PointsMaterial({ color: 0xe9dcff, size: 2, sizeAttenuation: false, transparent: true, opacity: .45, depthWrite: false, blending: THREE.AdditiveBlending });
  const group = new THREE.Group(); group.add(shell, edges, new THREE.Points(nodeGeometry, nodeMaterial));
  let fade = 1, level = 1, flash = 0;
  const apply = (seconds: number) => {
    const pulse = Math.pow(Math.max(0, Math.sin(seconds * 2.4)), 12);
    edgeMaterial.opacity = (.1 + .12 * level + .1 * pulse + .4 * flash) * fade;
    nodeMaterial.opacity = (.25 + .3 * level + .5 * flash) * fade;
  };
  return {
    group,
    set(values) {
      if (values.level !== undefined) uniforms.uLevel.value = level = values.level;
      if (values.flash !== undefined) uniforms.uFlash.value = flash = values.flash;
      if (values.fade !== undefined) uniforms.uFade.value = fade = values.fade;
    },
    update(seconds) { uniforms.uTime.value = seconds; apply(seconds); },
    dispose() { (shell.material as THREE.Material).dispose(); edgeGeometry.dispose(); edgeMaterial.dispose(); nodeGeometry.dispose(); nodeMaterial.dispose(); },
  };
}
