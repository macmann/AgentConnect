// Standalone browser bundle: fixed code, escaped text nodes, no model HTML.
export const widgetBundle = String.raw`(() => {
  const script = document.currentScript;
  const deployment = script && script.dataset.deployment;
  if (!deployment || !/^[0-9a-f-]{36}$/.test(deployment)) return;
  const api = new URL(script.src).origin;
  const path = '/public/widgets/' + deployment;
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({mode:'open'});
  const style = document.createElement('style');
  style.textContent = ':host{all:initial;font-family:system-ui,sans-serif;position:fixed;bottom:20px;right:20px;z-index:2147483000;color:#172820}button,input{font:inherit}button{cursor:pointer;border:0;border-radius:8px;padding:10px;background:#256c55;color:white}button:disabled{opacity:.5}section{box-sizing:border-box;display:flex;flex-direction:column;background:white;border:1px solid #d9e2dc;border-radius:14px;box-shadow:0 8px 35px #0002;overflow:hidden;max-width:calc(100vw - 32px);max-height:calc(100dvh - 90px)}header{display:flex;justify-content:space-between;align-items:center;padding:12px;border-bottom:1px solid #ddd}h2{font-size:16px;margin:0}.messages{flex:1;overflow:auto;padding:12px;min-height:100px}.messages p{white-space:pre-wrap;overflow-wrap:anywhere;background:#edf4ef;border-radius:8px;padding:10px}.messages p.user{background:#e4eee8}form{display:flex;gap:6px;padding:10px}input{min-width:0;flex:1;border:1px solid #bbcabe;border-radius:6px;padding:10px}.notice{font-size:12px;padding:0 12px}a{color:#256c55}.dark{background:#172820;color:#f6faf7}.dark .messages p{background:#2c4035}.dark input{background:#253d30;color:white}';
  root.append(style);
  const el = (tag,text) => {const n=document.createElement(tag); if(text)n.textContent=text; return n;};
  const launcher = el('button','Chat'); launcher.setAttribute('aria-expanded','false');root.append(launcher);
  let conversation, token, mode='ai',status='none', busy=false, abort, poll, live, liveRetry;
  async function request(suffix,body) {
    const r = await fetch(api+path+suffix,{method:body?'POST':'GET',credentials:'omit',headers:{...(body?{'content-type':'application/json'}:{}),...(token?{authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d;
  }
  request('').then(config => {
    const s=config.widget;launcher.textContent=s.launcher;
    if(s.position==='left'){host.style.left='20px';host.style.right='auto';}
    host.lang=s.language;
    const panel=el('section');panel.hidden=true;panel.style.display='none';panel.style.width=s.width+'px';panel.style.height=s.height+'px';if(s.theme==='dark')panel.className='dark';
    const header=el('header'),title=el('h2',config.name),close=el('button','Close chat');header.append(title,close);
    const messages=el('div');messages.className='messages';messages.setAttribute('role','log');messages.setAttribute('aria-live','polite');
    const add=(text,role)=>{const p=el('p',text);p.className=role||'';messages.append(p);messages.scrollTop=messages.scrollHeight;return p;};
    add(s.greeting||config.welcomeMessage);
    const notice=el('p','Messages are saved by this workspace.');notice.className='notice';notice.setAttribute('role','status');
    const form=el('form'),input=el('input'),send=el('button','Send');input.placeholder='Your message';input.setAttribute('aria-label','Message');input.maxLength=12000;send.type='submit';form.append(input,send);
    const handoff=el('button','Request human support'),keepAI=el('button','Keep trying with AI');handoff.disabled=true;handoff.hidden=true;keepAI.hidden=true;keepAI.type='button';keepAI.onclick=async()=>{try{await request('/conversations/'+conversation+'/handoff',{action:'dismiss'});await refresh();notice.textContent='You can keep chatting with the agent.';}catch(e){notice.textContent=e.message;}};
    async function refresh(){if(!conversation)return;try{const data=await request('/conversations/'+conversation+'/handoff');status=data.status;mode=data.conversationMode||'ai';input.disabled=mode==='returning_to_ai';send.disabled=busy||input.disabled;handoff.hidden=!data.access.canRequest||status==='pending'||status==='active';handoff.disabled=busy;handoff.textContent=data.access.offer?'Connect me':'Request human support';keepAI.hidden=!data.access.offer||status==='pending'||status==='active';if(data.access.offer)notice.textContent='Would you like to connect with a support specialist?';for(const event of data.events){if(event.kind==='operator_message'&&!seen.has(event.id)){seen.add(event.id);add(event.content);}}if(status==='resolved'){if(mode==='returning_to_ai'){notice.textContent='Support resolved. AI chat is paused until support restores it.';}else{notice.textContent='Support resolved. You can talk to the agent again. The AI has the approved resolution and can continue helping.';clearInterval(poll);poll=undefined;}}else if(status==='active')notice.textContent='An operator has joined. Messages go to the support team.';else if(data.access.businessHours&&!data.access.businessHours.open)notice.textContent=data.access.businessHours.message+' Timezone: '+data.access.businessHours.timezone;}catch(e){notice.textContent=e.message;}}
    async function startLive(){if(!conversation||live||panel.hidden)return;live=new AbortController();const signal=live.signal;try{const r=await fetch(api+path+'/conversations/'+conversation+'/handoff/stream',{credentials:'omit',signal,headers:{authorization:'Bearer '+token}});if(!r.ok||!r.body)throw new Error('Live unavailable');const reader=r.body.getReader(),decoder=new TextDecoder();let text='';while(!signal.aborted){const part=await reader.read();if(part.done)break;text+=decoder.decode(part.value,{stream:true});let i;while((i=text.indexOf('\n\n'))>=0){const frame=text.slice(0,i);text=text.slice(i+2);if(frame.startsWith('event: refresh'))await refresh();}}}catch{}finally{live=undefined;if(!signal.aborted&&!panel.hidden)liveRetry=setTimeout(startLive,2000);}}
    const seen=new Set();
    handoff.onclick=async()=>{if(busy)return;try{await request('/conversations/'+conversation+'/handoff',{action:'request'});status='pending';handoff.disabled=true;notice.textContent='Waiting for human support. You can leave a message.';poll=setInterval(refresh,5000);}catch(e){notice.textContent=e.message;}};
    form.onsubmit=async e=>{e.preventDefault();const text=input.value.trim();if(!text||busy||mode==='returning_to_ai')return;busy=true;send.disabled=true;handoff.disabled=true;input.value='';add(text,'user');abort=new AbortController();let answer;
      try{if(status==='pending'||status==='active'){await request('/conversations/'+conversation+'/handoff',{action:'message',content:text});notice.textContent='Message saved for support.';return;}
        answer=add('Thinking…');const r=await fetch(api+path+'/chat',{method:'POST',credentials:'omit',signal:abort.signal,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify({message:text,...(conversation?{conversationId:conversation}:{})})});
        if(!r.ok){const d=await r.json();throw new Error(d.error||'Chat failed');}if(!r.body)throw new Error('Streaming unavailable');
        const reader=r.body.getReader(),decoder=new TextDecoder();let buffer='',content='',terminal=false;
        try{for(;;){const part=await reader.read();if(part.done)break;buffer+=decoder.decode(part.value,{stream:true});let index;while((index=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,index);buffer=buffer.slice(index+2);const type=frame.split('\n').find(l=>l.startsWith('event:'))?.slice(6).trim(),raw=frame.split('\n').find(l=>l.startsWith('data:'))?.slice(5).trim();if(!type||!raw)continue;const data=JSON.parse(raw);if(type==='meta'){conversation=data.conversationId;token=data.guestToken||token;}if(type==='token'){content+=data.text;answer.textContent=content;}if(type==='ui'){content=data.message||'Structured response available in hosted chat.';answer.textContent=content;const a=el('a','Open full chat');a.href=script.dataset.chatUrl||'#';a.target='_blank';a.rel='noopener noreferrer';if(script.dataset.chatUrl)messages.append(a);}if(type==='error'){terminal=true;throw new Error(data.message||'Agent failed');}if(type==='done')terminal=true;}}if(!terminal)throw new Error('Response stream ended unexpectedly');}finally{reader.releaseLock();}
      }catch(e){if(answer&&!answer.textContent.trim())answer.remove();notice.textContent=abort?.signal.aborted?'Response cancelled.':e.message;}finally{busy=false;send.disabled=false;handoff.disabled=!conversation||status==='pending'||status==='active';await refresh();void startLive();}}
    const toggle=open=>{panel.style.display=open?'flex':'none';panel.hidden=!open;launcher.hidden=open;launcher.setAttribute('aria-expanded',String(open));if(open)input.focus();else{abort?.abort();live?.abort();clearTimeout(liveRetry);clearInterval(poll);poll=undefined;}};
    launcher.onclick=()=>{toggle(true);void startLive();if(status==='pending'||status==='active'){refresh();poll=setInterval(refresh,5000);}};close.onclick=()=>toggle(false);
    panel.append(header,messages,notice,handoff,keepAI,form);root.append(panel);
  }).catch(e=>{launcher.textContent='Chat unavailable';launcher.disabled=true;launcher.title=e.message;});
})();`;
