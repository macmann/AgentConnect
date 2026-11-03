import type { WidgetSettings } from "@agentconnect/schemas/channels";
import type { Branding } from "@agentconnect/schemas/customer-experience";
import type { QuickAction } from "@agentconnect/schemas/bank-experience";
export type WidgetPresentation = {
  name: string;
  welcomeMessage: string;
  conversationStarters: string[];
  quickActions: QuickAction[];
  branding: Branding;
  widget: WidgetSettings;
};
const json = (v: unknown) =>
  JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
const attribute = (v: string) =>
  v
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
/** The sandbox loads the actual production bundle. Only its data transport is replaced. */
export function widgetPreviewDocument(
  apiBase: string,
  deploymentId: string,
  config: WidgetPresentation,
  open: boolean,
  parentOrigin: string,
) {
  const api = new URL(apiBase).origin;
  const policy = `default-src 'none'; script-src 'unsafe-inline' ${api}; style-src 'unsafe-inline'; img-src ${api} https: data:; connect-src 'none'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${attribute(policy)}"><style>html,body{margin:0;background:transparent}</style></head><body><script>
 const config=${json(config)},api=${json(api)},deployment=${json(deploymentId)},parentOrigin=${json(parentOrigin)};
 const previewStorage=new Map();Object.defineProperty(window,'localStorage',{value:{getItem:key=>previewStorage.get(key)??null,setItem:(key,value)=>previewStorage.set(key,String(value)),removeItem:key=>previewStorage.delete(key)}});
 const prefix='/public/widgets/'+deployment;
 const respond=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
 window.fetch=async(input,options={})=>{
   const url=new URL(typeof input==='string'?input:input.url,api),suffix=url.pathname.slice(prefix.length);
   if(url.origin!==api||!url.pathname.startsWith(prefix))return respond({error:'Preview requests are isolated.'},403);
   if(!suffix)return respond(config);
   if(suffix==='/sessions')return respond({token:'preview-session-only',expiresAt:'2099-01-01T00:00:00Z'});
   if(suffix==='/history')return respond([]);
   if(suffix.endsWith('/handoff'))return respond({status:'none',conversationMode:'ai',access:{canRequest:false,canRequestExplicit:false,offer:false},events:[]});
   if(suffix.endsWith('/handoff/stream'))return new Response(new ReadableStream({start(controller){if(options.signal?.aborted)controller.close();else options.signal?.addEventListener('abort',()=>controller.close(),{once:true});}}),{headers:{'content-type':'text/event-stream'}});
   if(suffix.endsWith('/workflows'))return respond([]);
   if(suffix.endsWith('/feedback')||suffix.includes('/answer-reports/'))return respond(null);
   if(suffix==='/chat'){
     const events=[['meta',{conversationId:'00000000-0000-4000-8000-000000000001',guestToken:'preview-session-only'}],['token',{text:'This is an example reply. Preview messages are not sent to the agent or saved.'}],['done',{}]];
     return new Response(events.map(([name,data])=>'event: '+name+'\\ndata: '+JSON.stringify(data)+'\\n\\n').join(''),{headers:{'content-type':'text/event-stream'}});
   }
   return respond({error:'This action is unavailable in the preview.'},403);
 };
 const announce=type=>parent.postMessage({type},parentOrigin);
 let attempts=0;const timer=setInterval(()=>{
   const root=[...document.querySelectorAll('body > div')].find(node=>node.shadowRoot)?.shadowRoot;
   const launcher=root?.querySelector('button');
   if(launcher&&!launcher.disabled){clearInterval(timer);if(${json(open)}){const focus=HTMLElement.prototype.focus;try{HTMLElement.prototype.focus=()=>{};launcher.click();}finally{HTMLElement.prototype.focus=focus;}}announce('agentconnect-widget-preview-ready');}
   else if(++attempts>200){clearInterval(timer);announce('agentconnect-widget-preview-error');}
 },50);
 window.addEventListener('error',()=>announce('agentconnect-widget-preview-error'),{once:true});
 </script><script src="${attribute(apiBase.replace(/\/$/, "") + "/widget.js")}" data-deployment="${attribute(deploymentId)}"></script></body></html>`;
}
