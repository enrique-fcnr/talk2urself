import { useEffect, useRef, useState, type RefObject } from 'react';
import { mountKelly } from './kelly';
import type { AvatarPlayback } from '../../../../shared/lip-sync';
import type { ConversationState } from '../../../../shared/protocol';
// Spacing between the page text and the top of Kelly's head, in pixels.
const textGap=16;
export default function Avatar3D({ playbackRef, state, recording, clearOf, theme }: { playbackRef: RefObject<AvatarPlayback | null>; state: ConversationState; recording: boolean; clearOf: RefObject<HTMLElement | null>; theme: 'light' | 'dark' }) {
  const host=useRef<HTMLDivElement>(null),stateRef=useRef(state),recordingRef=useRef(recording),themeRef=useRef(theme);
  const [ready,setReady]=useState(false),[failed,setFailed]=useState(false);
  stateRef.current=state; recordingRef.current=recording; themeRef.current=theme;
  useEffect(()=>{
    if(!host.current)return;
    try { return mountKelly(host.current,{getPlayback:()=>playbackRef.current,getState:()=>stateRef.current,getRecording:()=>recordingRef.current,getTheme:()=>themeRef.current,
      getHeadroom:()=>clearOf.current && host.current ? clearOf.current.getBoundingClientRect().bottom-host.current.getBoundingClientRect().top+textGap : 0,portrait:true,onReady:()=>setReady(true),onError:()=>setFailed(true)}); }
    catch { setFailed(true); }
  },[playbackRef]);
  // Kelly fades in once loaded; the still image only stands in when 3D is unavailable.
  return <><div ref={host} className={`avatar-3d${ready && !failed ? ' ready' : ''}`} aria-hidden="true" />{failed ? <img src={`/avatars/${state==='idle' ? 'sleeping' : 'awake'}.png`} className="avatar-image visible" alt="" aria-hidden="true" /> : null}</>;
}
