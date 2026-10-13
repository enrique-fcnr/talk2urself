import test from 'node:test';
import assert from 'node:assert/strict';
import { readTimedSpeech } from './speech-timing.ts';
import { createVoiceProvider } from './voice.ts';
import { mouthPoseAt, parsePhonemeCues } from '../../../shared/lip-sync.ts';
import { parseServerEvent } from '../../../shared/protocol.ts';
const pcm=Buffer.alloc(48000);
function sse(events: unknown[], fragment=4096) {
  const data=new TextEncoder().encode(events.map(event=>'data: '+JSON.stringify(event)+'\r\n\r\n').join(''));
  return new Response(new ReadableStream({start(controller){for(let i=0;i<data.length;i+=fragment)controller.enqueue(data.slice(i,i+fragment));controller.close();}}));
}
const chunk={type:'chunk',data:pcm.toString('base64')};
const timestamps={type:'phoneme_timestamps',phoneme_timestamps:{phonemes:['a','ʃ','p'],start:[.02,.3,.6],end:[.2,.45,.8]}};
const done={type:'done',done:true};
test('Cartesia em português não pede fonemas incompatíveis; SSE fragmentado preserva tempos disponíveis e WAV',async()=>{
  let calls=0;
  const voice=createVoiceProvider({openaiKey:'test',cartesiaKey:'test',voiceId:'test',model:'test'},async(url,init)=>{
    calls++;assert.equal(String(url),'https://api.cartesia.ai/tts/sse');
    const body=JSON.parse(String(init?.body));assert.equal(body.add_phoneme_timestamps,false);assert.equal(body.add_timestamps,true);assert.equal(body.language,'pt-BR');assert.equal(body.voice,'test');
    assert.deepEqual(body.output_format,{container:'raw',encoding:'pcm_s16le',sample_rate:24000});
    return sse([timestamps,chunk,done],7);
  });
  const result=await voice.speakTimed!('Fala fictícia.',AbortSignal.timeout(5000));
  assert.equal(calls,1);assert.equal(result.audio.toString('ascii',0,4),'RIFF');assert.equal(result.audio.readUInt32LE(24),24000);assert.deepEqual(result.audio.subarray(44),pcm);
  assert.deepEqual(result.phonemes,[{phoneme:'a',start:.02,end:.2},{phoneme:'ʃ',start:.3,end:.45},{phoneme:'p',start:.6,end:.8}]);
});
test('áudio sem fonemas anima pela intensidade e fecha a boca nas pausas sem outra geração',async()=>{
  const audio=Buffer.alloc(48000);
  for(let i=0;i<24000;i++) {
    const time=i/24000;
    const level=time>=.12&&time<.28 ? .1 : time>=.6&&time<.8 ? .7 : 0;
    audio.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*220/24000)*level*32767),i*2);
  }
  let calls=0;
  const voice=createVoiceProvider({openaiKey:'test',cartesiaKey:'test',voiceId:'test',model:'test'},async()=>{
    calls++;return sse([{type:'chunk',data:audio.toString('base64')},done],11);
  });
  const speech=await voice.speakTimed!('Fala fictícia.',AbortSignal.timeout(5000));
  assert.equal(calls,1);assert.deepEqual(speech.audio.subarray(44),audio);
  assert.ok(mouthPoseAt(speech.phonemes,.2,true).JawOpen!>0);
  assert.ok(mouthPoseAt(speech.phonemes,.7,true).JawOpen!>mouthPoseAt(speech.phonemes,.2,true).JawOpen!);
  assert.deepEqual(mouthPoseAt(speech.phonemes,.45,true),{});
  assert.deepEqual(mouthPoseAt(speech.phonemes,.7,false),{});
});
test('tempos ausentes ou inválidos preservam voz válida sem gerar de novo',async()=>{
  for(const timing of [null,{...timestamps,phoneme_timestamps:{phonemes:['a'],start:[0],end:[5]}},{...timestamps,phoneme_timestamps:{phonemes:['a'],start:[],end:[.2]}}]){
    const result=await readTimedSpeech(sse([chunk,...(timing ? [timing] : []),done]),AbortSignal.timeout(2000));
    assert.equal(result.audio.length,48044);assert.deepEqual(result.phonemes,[]);
  }
});
test('stream interrompido, erros, base64 inválido e PCM truncado não viram áudio tocável',async()=>{
  for(const events of [[chunk],[{type:'error',message:'private upstream data'}],[{type:'chunk',data:'%%%invalid'},done],[{type:'chunk',data:Buffer.from([1]).toString('base64')},done]]){
    await assert.rejects(readTimedSpeech(sse(events),AbortSignal.timeout(2000)),error=>error instanceof Error && !error.message.includes('private upstream'));
  }
});
test('cancelamento durante leitura libera o leitor e não entrega voz atrasada',async()=>{
  let cancelled=false;
  const response=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(chunk)+'\n\n'));},cancel(){cancelled=true;}}));
  const active=new AbortController();const work=readTimedSpeech(response,active.signal);setTimeout(()=>active.abort(),10);
  await assert.rejects(work);assert.equal(cancelled,true);
});
test('relógio da reprodução dirige vogais, fechamento de lábios, pausas e replay',()=>{
  const cues=[{phoneme:'a',start:.1,end:.3},{phoneme:'m',start:.6,end:.8}];
  assert.ok(mouthPoseAt(cues,.2,true).AA!>.5);assert.ok(mouthPoseAt(cues,.7,true).pp!>.5);
  assert.deepEqual(mouthPoseAt(cues,.45,true),{});assert.deepEqual(mouthPoseAt(cues,.7,false),{});
  assert.deepEqual(mouthPoseAt(cues,3,true),{});assert.deepEqual(mouthPoseAt(cues,0,true),{});
  assert.deepEqual(mouthPoseAt(cues,.2,true),mouthPoseAt(cues,.2,true));
});
test('contrato rejeita tempos inválidos, conserva ordem e aceita cliente anterior',()=>{
  for(const cues of [[{phoneme:'a',start:1,end:.5}],[{phoneme:'a',start:-1,end:1}],[{phoneme:'a',start:0,end:Infinity}],[{phoneme:'a',start:1,end:2},{phoneme:'b',start:0,end:1}]])assert.equal(parsePhonemeCues(cues),null);
  assert.deepEqual(parseServerEvent('{"type":"audio-output","mime":"audio/wav"}'),{type:'audio-output',mime:'audio/wav'});
  const valid={type:'audio-output',mime:'audio/wav',phonemes:[{phoneme:'a',start:0,end:1}]};assert.deepEqual(parseServerEvent(JSON.stringify(valid)),valid);
  assert.equal(parseServerEvent(JSON.stringify({...valid,phonemes:[{phoneme:'a',start:1,end:0}]})),null);
});
test('tempos de palavra em português viram bocas lidas da grafia dentro de cada palavra',async()=>{
  // Shape of a real Cartesia pt-BR response (one `timestamps` event per word), scaled to the 1 s test audio.
  const words=[['Olá,',.05,.3],['vamos',.42,.62],['pensar',.62,.9]].map(([word,start,end])=>({type:'timestamps',word_timestamps:{words:[word],start:[start],end:[end]}}));
  const result=await readTimedSpeech(sse([chunk,...words,done]),AbortSignal.timeout(2000));
  assert.ok(result.phonemes.length>10 && result.phonemes.every(cue=>!cue.phoneme.startsWith('audio')));
  assert.ok(mouthPoseAt(result.phonemes,.635,true).pp!>.5,'p de "pensar" fecha os lábios');
  assert.ok(mouthPoseAt(result.phonemes,.43,true).ff!>.5,'v de "vamos" encosta o lábio nos dentes');
  assert.ok(mouthPoseAt(result.phonemes,.27,true).AA!>.5,'á final de "Olá" abre a boca');
  assert.deepEqual(mouthPoseAt(result.phonemes,.36,true),{},'pausa entre palavras fecha a boca');
});
test('tempos de palavra inválidos voltam para a intensidade do áudio',async()=>{
  const bad={type:'timestamps',word_timestamps:{words:['olá'],start:[.5],end:[.2]}};
  const result=await readTimedSpeech(sse([chunk,bad,done]),AbortSignal.timeout(2000));
  assert.ok(result.phonemes.every(cue=>cue.phoneme.startsWith('audio')));
});
test('lábios apertam no p, arredondam no u e antecipam a vogal seguinte',()=>{
  const cues=[{phoneme:'p',start:0,end:.1},{phoneme:'a',start:.1,end:.3},{phoneme:'n',start:.4,end:.48},{phoneme:'u',start:.48,end:.7}];
  const p=mouthPoseAt(cues,.05,true);assert.ok(p.pp!>.5 && p.LipsUpperClose!>.3 && p.LipsLowerClose!>.3);
  assert.ok(mouthPoseAt(cues,.6,true).LipsPucker!>.4,'u faz bico');
  assert.ok(mouthPoseAt(cues,.43,true).LipsPucker!>.2,'o t/n antes do u já arredonda os lábios');
  assert.equal(mouthPoseAt(cues,.2,true).LipsPucker,undefined,'a não arredonda');
});
