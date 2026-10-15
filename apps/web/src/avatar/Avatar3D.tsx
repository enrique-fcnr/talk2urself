import { useEffect, useRef, useState, type RefObject } from 'react';
import { mountKelly, type BrainProbe } from './kelly';
import type { AvatarPlayback } from '../../../../shared/lip-sync';
import type { ConversationState } from '../../../../shared/protocol';
// Spacing between the page text and the top of Kelly's head, in pixels.
const textGap=16;
export default function Avatar3D({ playbackRef, state, recording, clearOf, theme, brainProbe, clearBelow, holdLayout = false, aside = false }: { playbackRef: RefObject<AvatarPlayback | null>; state: ConversationState; recording: boolean; clearOf: RefObject<HTMLElement | null>; theme: 'light' | 'dark'; brainProbe?: RefObject<BrainProbe | null>; clearBelow?: RefObject<HTMLElement | null>; holdLayout?: boolean;
  // Desktop start screen: the copy sits on the left, so Kelly takes the full height on the right.
  aside?: boolean }) {
  const host=useRef<HTMLDivElement>(null),stateRef=useRef(state),recordingRef=useRef(recording),themeRef=useRef(theme);
  // Space taken by the start screen's copy above and button below, held from the moment they start to leave: Kelly keeps the same
  // size and place when she wakes, and only the text and the button go away.
  const reserved=useRef({ above:0,below:0 }),holdRef=useRef(holdLayout),asideRef=useRef(aside); holdRef.current=holdLayout; asideRef.current=aside;
  const [ready,setReady]=useState(false),[failed,setFailed]=useState(false);
  stateRef.current=state; recordingRef.current=recording; themeRef.current=theme;
  useEffect(()=>{
    if(!host.current)return;
    try { return mountKelly(host.current,{getPlayback:()=>playbackRef.current,getState:()=>stateRef.current,getRecording:()=>recordingRef.current,getTheme:()=>themeRef.current,
      getHeadroom:()=>{ const above=clearOf.current, frame=host.current; if (above && frame && !holdRef.current) reserved.current.above=asideRef.current ? textGap*2 : above.getBoundingClientRect().bottom-frame.getBoundingClientRect().top+textGap; return reserved.current.above; },
      getFootroom:()=>{ const below=clearBelow?.current, frame=host.current; if (below && frame && !holdRef.current) reserved.current.below=asideRef.current ? Math.min(140,innerHeight*.14) : Math.min(frame.getBoundingClientRect().bottom,innerHeight)-below.getBoundingClientRect().top+textGap; return reserved.current.below; },
      // Kelly's column: 72% across the page frame (at most 1280px wide, centred, with the stylesheet's --frame-inset).
      getShiftX:()=>{ if (!asideRef.current) return 0; const inset=Math.max(innerWidth*.032,(innerWidth-1280)/2); return inset+(innerWidth-2*inset)*.72-innerWidth/2; },
      portrait:true,onReady:()=>setReady(true),onBrainProbe:(probe)=>{ if (brainProbe) brainProbe.current=probe; },onError:()=>setFailed(true)}); }
    catch { setFailed(true); }
  },[playbackRef]);
  // Kelly fades in once loaded; the still image only stands in when 3D is unavailable.
  return <><div ref={host} className={`avatar-3d${ready && !failed ? ' ready' : ''}`} aria-hidden="true" />{failed ? <img src={`/avatars/${state==='idle' ? 'sleeping' : 'awake'}.png`} className="avatar-image visible" alt="" aria-hidden="true" /> : null}</>;
}
