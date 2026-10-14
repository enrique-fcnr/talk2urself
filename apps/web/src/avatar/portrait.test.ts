import test from 'node:test';
import assert from 'node:assert/strict';
import { portraitFrame, portraitViewport, type PortraitPoint } from './portrait.ts';
import { PerspectiveCamera, Vector3 } from 'three';
import { crownPortraitPoints } from './crown.ts';

const tan = Math.tan(35 * Math.PI / 360), eyeLevel = .5;
const face: PortraitPoint[] = [{ x: 0, y: 1.04, z: 0 }, { x: 0, y: -.55, z: 0 }];
test('texto, portal e esferas não se sobrepõem e cabem em telas estreitas e baixas', () => {
  for (const [width, height, headroom, visibleBottom] of [[1100, 614, 230, 544], [900, 600, 300, 530], [565, 440, 225, 405], [464, 340, 260, 305]]) {
    for (const points of [face, [...face, ...crownPortraitPoints]]) {
      const frame = portraitFrame({ width, height, headroom, visibleBottom, tan, eyeLevel, designDistance: 3.1, points });
      for (const point of points) {
        // Independent projection of each bound through the resulting camera.
        const y = height / 2 - (point.y - eyeLevel) * height / (2 * (frame.distance - point.z) * tan) - frame.viewShift;
        const x = point.x * height / (2 * (frame.distance - point.z) * tan);
        assert.ok(y >= headroom - .001, 'visual must stay below the complete text block');
        assert.ok(y <= visibleBottom + .001, 'face and neck must stay above the visible bottom');
        assert.ok(Math.abs(x) <= width / 2 + .001, 'portal must fit horizontally');
      }
    }
  }
});

test('o enquadramento original é preservado quando já existe espaço suficiente', () => {
  const frame = portraitFrame({ width: 1100, height: 800, headroom: 0, visibleBottom: 730, tan, eyeLevel, designDistance: 3.3, points: face });
  assert.equal(frame.distance, 3.3);
});

test('a cena pode crescer depois que o texto inicial desaparece', () => {
  const layout = { width: 1000, height: 640, visibleBottom: 570, tan, eyeLevel, designDistance: 3.1, points: [...face, ...crownPortraitPoints] };
  const initial = portraitFrame({ ...layout, headroom: 260 });
  const conversation = portraitFrame({ ...layout, headroom: 30 });
  assert.ok(initial.distance > conversation.distance);
});

test('na conversa a base do busto fica presa à borda inferior, sem centralização vertical', () => {
  for (const [width,height,visibleBottom] of [[1100,614,544],[565,440,405]]) {
    const base={x:0,y:-.95,z:0};
    for (const points of [[face[0],base],[face[0],base,...crownPortraitPoints]]) {
      const frame=portraitFrame({width,height,visibleBottom,headroom:20,tan,eyeLevel,designDistance:3.1,points,bottomAnchored:true});
      const projectedBase=height/2-(base.y-eyeLevel)*height/(2*frame.distance*tan)-frame.viewShift;
      assert.ok(Math.abs(projectedBase-visibleBottom)<.001,'bust base must meet the visible bottom');
      for(const point of points) {
        const y=height/2-(point.y-eyeLevel)*height/(2*(frame.distance-point.z)*tan)-frame.viewShift;
        assert.ok(y>=20-.001,'the full head and portal remain below the header');
      }
    }
  }
});

test('o foco no busto amplia a Kelly no desktop mantendo a cabeça visível e a base fixa', () => {
  const points=[face[0],{x:0,y:-.95,z:0}];
  const previous=portraitFrame({width:1100,height:640,visibleBottom:570,headroom:20,tan,eyeLevel,designDistance:3.1,points:[...points,...crownPortraitPoints],bottomAnchored:true});
  const expanded=portraitFrame({width:1100,height:760,visibleBottom:690,headroom:20,tan,eyeLevel,designDistance:3.1,points,bottomAnchored:true});
  assert.ok((760/expanded.distance)/(640/previous.distance)>1.3,'desktop avatar should be visibly larger');
  const project=(y:number)=>760/2-(y-eyeLevel)*760/(2*expanded.distance*tan)-expanded.viewShift;
  assert.ok(project(1.04)>=20-.001,'head remains entirely below the header');
  assert.ok(Math.abs(project(-.95)-690)<.001,'bust stays anchored at the bottom');
});

test('o ajuste moderado desce o corte do busto para fora da tela e mantém a cabeça visível', () => {
  const points=[face[0],{x:0,y:-.95,z:0}];
  const common={width:1100,headroom:20,tan,eyeLevel,designDistance:3.1,points,bottomAnchored:true};
  const large=portraitFrame({...common,height:760,visibleBottom:690});
  const moderate=portraitFrame({...common,height:668,visibleBottom:598,bottomCrop:80});
  const ratio=(668/moderate.distance)/(760/large.distance);
  assert.ok(ratio<.95 && ratio>.8,'reduce the excessive zoom without returning to a tiny avatar');
  const project=(y:number)=>668/2-(y-eyeLevel)*668/(2*moderate.distance*tan)-moderate.viewShift;
  assert.ok(Math.abs(project(-.95)-678)<.001,'the cut end is 80 pixels below the visible bottom');
  assert.ok(project(1.04)>=20,'head remains below the header');
});

test('o portal cabe durante toda a transição com a área extra disponível desde o início', () => {
  const width=1100,height=668,topBleed=Math.ceil(height*.4);
  const common={width,height,visibleBottom:598,tan,eyeLevel,designDistance:3.1};
  const initial=portraitFrame({...common,headroom:230,points:[...face,...crownPortraitPoints]});
  const final=portraitFrame({...common,headroom:20,points:[face[0],{x:0,y:-.95,z:0}],bottomAnchored:true,bottomCrop:80});
  const camera=new PerspectiveCamera(35,width/height,.01,100);
  for(let step=0;step<=20;step++) {
    const t=step/20;
    const distance=initial.distance+(final.distance-initial.distance)*t;
    const shift=initial.viewShift+(final.viewShift-initial.viewShift)*t;
    const viewport=portraitViewport(height,shift,topBleed);
    assert.equal(viewport.renderHeight,height+topBleed,'surface stays expanded before, during and after entry');
    camera.position.set(0,eyeLevel,distance); camera.updateMatrixWorld(true);
    camera.setViewOffset(width,height,0,viewport.offsetY,width,viewport.renderHeight);
    const top=new Vector3(0,2.2,-1.25).project(camera);
    assert.ok(top.y<=1 && top.y>=-1,`portal top fits at transition step ${step}`);
  }
});

test('a área extra mostra o topo do portal sem mudar a escala nem a posição do avatar', () => {
  const width=1100,height=668,topBleed=Math.ceil(height*.4);
  const frame=portraitFrame({width,height,visibleBottom:598,headroom:20,tan,eyeLevel,designDistance:3.1,
    points:[face[0],{x:0,y:-.95,z:0}],bottomAnchored:true,bottomCrop:80});
  const camera=new PerspectiveCamera(35,width/height,.01,100);
  camera.position.set(0,eyeLevel,frame.distance); camera.updateMatrixWorld(true);
  camera.setViewOffset(width,height,0,frame.viewShift,width,height);
  const subject=[new Vector3(.1,.5,.2),new Vector3(0,-.95,0)];
  const original=subject.map(point=>{const p=point.clone().project(camera);return {x:(p.x+1)*width/2,y:(1-p.y)*height/2};});
  const portal=new Vector3(0,2.2,-1.25);
  assert.ok(portal.clone().project(camera).y>1,'reproduce the portal cut by the old canvas');
  const viewport=portraitViewport(height,frame.viewShift,topBleed);
  camera.setViewOffset(width,height,0,viewport.offsetY,width,viewport.renderHeight);
  subject.forEach((point,i)=>{
    const p=point.clone().project(camera);
    assert.ok(Math.abs((p.x+1)*width/2-original[i].x)<.000001);
    assert.ok(Math.abs((1-p.y)*viewport.renderHeight/2-topBleed-original[i].y)<.000001);
  });
  const shown=portal.project(camera);
  assert.ok(shown.y<=1 && shown.y>=-1,'the portal top now lies inside the expanded render surface');
});
