import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
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
// Mouth interior: pale satin teeth, deep rose tongue and gums, each with a faint glow so they read inside the dark mouth.
const mouthColors = { teeth: 0xd9deee, gums: 0x6e2443, tongue: 0x9a3463 };
const mouthGlow = { teeth: .14, gums: .1, tongue: .16 };
// Seconds awake with nobody talking or acting before Kelly yawns.
const firstIdleYawn = 20;
// Gestures read as natural when they start just before the words they accompany.
const gestureLead = .2;
// Portrait framing lines, in world units of the 1.9-tall bust: above the head with room for raised-head gestures, and the base of the neck.
const headClearance = 1.04, neckLine = -.55;
// Roughly how long the camera takes to glide to a new framing when the page text changes height.
const framingSeconds = .6;
// Playback speed and strength per gesture: slower and smaller than authored reads calmer on screen.
const gestureTuning: Partial<Record<Gesture, { speed: number; strength: number }>> = {
  nod: { speed: .7, strength: .75 }, shrug: { speed: .8, strength: .85 }, think: { speed: .75, strength: .9 },
};
// Seconds for a held pose to ease back to neutral, and to ease back in when requested again.
const releaseSeconds = 1.2, resumeSeconds = .6;

type ViewOptions = {
  getPlayback: () => AvatarPlayback | null;
  getState: () => ConversationState;
  getRecording?: () => boolean;
  // Pixels from the top of the view that page content covers; the head stays below them.
  getHeadroom?: () => number;
  loadModel?: (signal: AbortSignal) => Promise<ArrayBuffer>;
  onReady?: () => void;
  onError: () => void;
  interactive?: boolean;
  portrait?: boolean;
};
export function mountKelly(host: HTMLElement, options: ViewOptions) {
  const controller = new AbortController();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.25;
  renderer.domElement.setAttribute('aria-hidden', 'true'); host.append(renderer.domElement);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 1, .01, 100);
  const controls = options.interactive ? new OrbitControls(camera, renderer.domElement) : undefined;
  if (controls) { controls.enableDamping = true; controls.enablePan = false; controls.minPolarAngle = Math.PI * .27; controls.maxPolarAngle = Math.PI * .69; }
  const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 512;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#02040d'; ctx.fillRect(0, 0, 1024, 512);
  const gradient = ctx.createLinearGradient(0, 0, 1024, 0);
  for (const [offset, color] of [[0,'#030718'], [.12,'#286aff'], [.25,'#03efff'], [.37,'#ff147e'], [.47,'#ffbf42'], [.54,'#ff6830'], [.63,'#ff28c8'], [.76,'#424dff'], [.87,'#08e6ff'], [1,'#030718']] as const) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient; ctx.fillRect(0,0,1024,512);
  // The reference has luminous colour around the brow and a dark lower face.
  // Fade the coloured environment vertically instead of covering the full bust.
  const colourMask = ctx.createLinearGradient(0,0,0,512);
  for (const [offset,color] of [[0,'#040404'],[.13,'#121212'],[.27,'#ffffff'],[.4,'#ffffff'],[.52,'#808080'],[.66,'#060606'],[1,'#020202']] as const) colourMask.addColorStop(offset,color);
  ctx.globalCompositeOperation='multiply'; ctx.fillStyle=colourMask; ctx.fillRect(0,0,1024,512);
  const softbox = ctx.createLinearGradient(0,0,0,512);
  for (const [offset,color] of [[0,'#000000'],[.09,'#141a35'],[.15,'#070b18'],[.3,'#000000'],[1,'#000000']] as const) softbox.addColorStop(offset,color);
  ctx.globalCompositeOperation='screen'; ctx.fillStyle=softbox; ctx.fillRect(0,0,1024,512);
  const environmentSource = new THREE.CanvasTexture(canvas); environmentSource.mapping=THREE.EquirectangularReflectionMapping; environmentSource.colorSpace=THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer), environment=pmrem.fromEquirectangular(environmentSource);
  environmentSource.dispose(); pmrem.dispose(); scene.environment=environment.texture;
  scene.add(new THREE.HemisphereLight(0x7287cf,0x02030b,.35));
  for (const [color,x,y,z,power] of [[0xb8f5ff,-1.2,1.8,2.5,8],[0xffa6df,1.6,1.1,1.5,3],[0x406cff,0,2,-1,5],[0xe0eeff,-.8,-1,2,3]]) {
    const light=new THREE.PointLight(color,power); light.position.set(x,y,z); scene.add(light);
  }
  const eyeCanvas=document.createElement('canvas'); eyeCanvas.width=eyeCanvas.height=256;
  const eyeCtx=eyeCanvas.getContext('2d')!; eyeCtx.fillStyle='black'; eyeCtx.fillRect(0,0,256,256);
  // Iris centres in Kelly's original atlas (each eye has its own UV island).
  for (const [x,y] of [[.898,.202],[.850,.403]]) {
    const glow=eyeCtx.createRadialGradient(x*256,y*256,12,x*256,y*256,14);
    glow.addColorStop(0,'#fff'); glow.addColorStop(1,'#000'); eyeCtx.fillStyle=glow; eyeCtx.fillRect(x*256-15,y*256-15,30,30);
  }
  // glTF UVs start at the top of the image. The bust has no UVs, so it samples the black corner.
  const eyeMap=new THREE.CanvasTexture(eyeCanvas); eyeMap.colorSpace=THREE.SRGBColorSpace; eyeMap.flipY=false;
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
  const vec3=(color: number, scale=1) => { const c=new THREE.Color(color).multiplyScalar(scale); return `vec3(${c.r.toFixed(4)},${c.g.toFixed(4)},${c.b.toFixed(4)})`; };
  material.onBeforeCompile=shader=>{
    shader.uniforms.lidGlow={ value: new THREE.Color(lidGlowColor).multiplyScalar(lidGlowStrength) };
    shader.uniforms.lidClosed=lidClosed;
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nattribute vec4 lid;\nvarying vec4 vLid;')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nvLid=lid;');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nuniform vec3 lidGlow;\nuniform float lidClosed;\nvarying vec4 vLid;')
      .replace('#include <color_fragment>',`#include <color_fragment>
        float teeth=1.-step(.125,vLid.a), gums=step(.125,vLid.a)*(1.-step(.375,vLid.a)), tongue=step(.375,vLid.a)*(1.-step(.75,vLid.a));
        float mouthPart=teeth+gums+tongue;
        diffuseColor.rgb=mix(diffuseColor.rgb,teeth*${vec3(mouthColors.teeth)}+gums*${vec3(mouthColors.gums)}+tongue*${vec3(mouthColors.tongue)},mouthPart);`)
      .replace('#include <metalnessmap_fragment>','#include <metalnessmap_fragment>\nmetalnessFactor=mix(metalnessFactor,0.,mouthPart);')
      .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=mix(roughnessFactor,teeth*.3+gums*.5+tongue*.42,mouthPart);')
      .replace('#include <emissivemap_fragment>',`#include <emissivemap_fragment>
        totalEmissiveRadiance+=lidGlow*(vLid.r*(.15+.85*lidClosed)+vLid.g*lidClosed);
        // The mouth gets almost no environment light, so a faint glow keeps teeth and tongue readable.
        totalEmissiveRadiance+=teeth*${vec3(mouthColors.teeth,mouthGlow.teeth)}+gums*${vec3(mouthColors.gums,mouthGlow.gums)}+tongue*${vec3(mouthColors.tongue,mouthGlow.tongue)};`)
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
  const stage=new THREE.Group(); scene.add(stage);
  const heads: THREE.Mesh[] = [], geometries: THREE.BufferGeometry[] = [];
  let disposed=false, frame=0, size: THREE.Vector3 | undefined, lastTime=0, mixer: THREE.AnimationMixer | undefined;
  let lastState=options.getState(), listenTimer=3, sinceYawn=0, idleFor=0, idleYawnAfter=firstIdleYawn, tiltRelease=0, glanceIn=glanceEvery(), viewShift=0;
  let cuePlayback: AvatarPlayback | null=null, nextCue=0, previewState: ConversationState | null=null;
  const actions=new Map<string, THREE.AnimationAction>(), lip: Partial<Record<string, number>>={}, clipMorphs: number[][]=[];
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
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
  // Asleep is the wake clip held on its first frame, so waking lets it run on from there with no jump at the click.
  function sleep(seconds: number) {
    const action=actions.get('wake'); if (!action) return;
    blends.delete(action); action.reset().play(); action.paused=true;
    if (seconds>0 && !reduced.matches) { action.setEffectiveWeight(0); ease(action,1,seconds); } else action.setEffectiveWeight(1);
  }
  function wakeUp() {
    const action=actions.get('wake'); if (!action) return;
    // Woken while still settling into sleep: finish the blend quickly instead of snapping to the full pose.
    if (action.getEffectiveWeight()<1) ease(action,1,.4); else blends.delete(action);
    if (reduced.matches) action.stop(); else action.paused=false;
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
  function resize() {
    if (disposed) return;
    const width=host.clientWidth || 1,height=host.clientHeight || 1; camera.aspect=width/height; camera.updateProjectionMatrix(); renderer.setSize(width,height);
    if (!size) return;
    if (options.portrait) { fitPortrait(null); return; }
    const angle=Math.tan(THREE.MathUtils.degToRad(camera.fov)/2), halfHeight=.95,halfWidth=size.x/size.y*halfHeight;
    const distance=Math.max(halfHeight/angle,halfWidth/(angle*camera.aspect))*1.14+size.z/size.y;
    camera.position.set(0,.04,distance);
    if (controls) { controls.minDistance=distance*.65; controls.maxDistance=distance*1.7; controls.update(); }
  }
  // Portrait framing, in world units: the bust is 1.9 tall and centred, so the head top sits at .95.
  // The camera keeps room above it for gestures that raise the head, keeps it below the page text,
  // and only zooms out when the face and neck would not otherwise fit above the bottom of the screen.
  // Critically damped follow: starts and settles gently, so a framing change never jolts the bust.
  const framingVelocity={ z: 0, shift: 0 };
  function smoothDamp(current: number, target: number, key: 'z' | 'shift', dt: number) {
    const omega=2/framingSeconds, x=omega*dt, decay=1/(1+x+.48*x*x+.235*x*x*x);
    const change=current-target, push=(framingVelocity[key]+omega*change)*dt;
    framingVelocity[key]=(framingVelocity[key]-omega*push)*decay;
    return target+(change+push)*decay;
  }
  // dt null snaps to the framing (first layout and window resizes).
  function fitPortrait(dt: number | null) {
    const height=host.clientHeight || 1, tan=Math.tan(THREE.MathUtils.degToRad(camera.fov)/2);
    const designDistance=Math.max(.88/tan,.68/(tan*camera.aspect))+size!.z/size!.y*.3;
    const designScale=height/(2*designDistance*tan), rect=host.getBoundingClientRect();
    const headroom=Math.max(0,options.getHeadroom?.() ?? 0), visibleBottom=height-Math.max(0,rect.bottom-innerHeight);
    const scale=Math.min(designScale,(visibleBottom-headroom)/(headClearance-neckLine));
    const distance=height/(2*scale*tan), half=distance*tan;
    // Pixels from the canvas top to the head's clearance line: the design's position unless that is under the text or off the edge.
    const top=Math.max(headroom,(.04+half-headClearance)*scale);
    // Render from eye level so her gaze meets the viewer's, then shift the image to where a camera
    // at the framing height would have placed the bust. A higher or lower camera would make her look past you.
    const framingY=headClearance-half+top/scale, width=host.clientWidth || 1;
    camera.position.y=eyeLevel;
    const shift=(eyeLevel-framingY)*scale;
    if (dt===null) { camera.position.z=distance; viewShift=shift; framingVelocity.z=framingVelocity.shift=0; }
    else { camera.position.z=smoothDamp(camera.position.z,distance,'z',dt); viewShift=smoothDamp(viewShift,shift,'shift',dt); }
    camera.setViewOffset(width,height,0,viewShift,width,height);
  }
  const observer=new ResizeObserver(resize); observer.observe(host); resize();
  function draw(time: number) {
    if (disposed || document.hidden) return;
    const dt=Math.min((time-lastTime)/1000,.05); lastTime=time;
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
    // Ease toward the framing so the bust glides when a message appears below the title.
    if (options.portrait && size) fitPortrait(dt);
    controls?.update(); renderer.render(scene,camera); frame=requestAnimationFrame(draw);
  }
  function visibility() { cancelAnimationFrame(frame); if (!document.hidden && !disposed) { lastTime=performance.now(); frame=requestAnimationFrame(draw); } }
  document.addEventListener('visibilitychange',visibility);
  const load=options.loadModel ?? (async (signal: AbortSignal) => { const response=await fetch('/avatars/kelly.glb',{signal}); if(!response.ok) throw Error('Model unavailable'); return response.arrayBuffer(); });
  void load(controller.signal).then(bytes=>new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes,'')).then(gltf=>{
    if(disposed)return;
    const avatar=gltf.scene;
    avatar.traverse(object=>{if(!(object instanceof THREE.Mesh))return;
      for(const original of Array.isArray(object.material) ? object.material : [object.material]) original.dispose();
      // Gestures move the skin beyond the rest-pose bounds.
      object.material=material; object.frustumCulled=false; heads.push(object); geometries.push(object.geometry);
      // The lid and mouth marks arrive as vertex colour; keep them under their own name so they never tint the surface.
      const colors=object.geometry.getAttribute('color'), lid=new Float32Array(object.geometry.getAttribute('position').count*4).fill(1);
      if (colors) for (let i=0;i<lid.length/4;i++) lid.set([colors.getX(i),colors.getY(i),colors.getZ(i),colors.itemSize>3 ? colors.getW(i) : 1],i*4);
      object.geometry.setAttribute('lid',new THREE.BufferAttribute(lid,4)); object.geometry.deleteAttribute('color');
    });
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
    if (import.meta.env.DEV) Object.assign(window,{kellyGesture:play,kellyState:(state: ConversationState | null)=>{ previewState=state; },
      // Active expressions and running clips, for checking that a gesture returned to neutral.
      kellyDebug:()=>({ viewShift, cameraZ:camera.position.z, headPitch:THREE.MathUtils.radToDeg(new THREE.Euler().setFromQuaternion(avatar.getObjectByName('head')!.getWorldQuaternion(new THREE.Quaternion())).x),
        clips:[...actions].filter(([,action])=>action.isScheduled()).map(([name,action])=>`${name}:${action.getEffectiveWeight().toFixed(2)}`),
        expressions:Object.entries(heads[0].morphTargetDictionary ?? {}).map(([name,i])=>[name,heads[0].morphTargetInfluences![i]] as const).filter(([,value])=>value>.01) })});
    const bust=new THREE.Group(); bust.add(avatar);
    const bounds=new THREE.Box3().setFromObject(bust,true); size=bounds.getSize(new THREE.Vector3());
    bust.position.copy(bounds.getCenter(new THREE.Vector3())).negate(); stage.add(bust); stage.scale.setScalar(1.9/size.y);
    resize(); options.onReady?.(); lastTime=performance.now(); if(!document.hidden)frame=requestAnimationFrame(draw);
  }).catch(()=>{if(!disposed)options.onError();});
  return () => {
    disposed=true; controller.abort(); cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('visibilitychange',visibility);
    removeEventListener('pointerdown',userActive); removeEventListener('keydown',userActive);
    mixer?.stopAllAction(); controls?.dispose(); for(const geometry of geometries)geometry.dispose(); material.dispose(); eyeMap.dispose(); environment.dispose();
    renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
  };
}
