const $=s=>document.querySelector(s);
let email='',widget;
async function api(url,data){const r=await fetch(url,{method:data?'POST':'GET',headers:{'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});const out=await r.json();if(!r.ok)throw Error(out.error?.message||'Request failed.');return out.data;}
async function launch(){
  $('#hosted-auth').classList.add('hidden');document.querySelector('.layout').classList.remove('hidden');
  $('#new-user').replaceWith(Object.assign(document.createElement('button'),{id:'new-user',textContent:'Sign out',className:'quiet'}));
  $('#new-user').addEventListener('click',async()=>{await api('/api/auth/logout',{});location.href='/';});
  await import('/app.mjs');
}
document.querySelector('.layout').classList.add('hidden');
const health=await api('/api/health');
if(new URLSearchParams(location.hash.slice(1)).has('share')||new URLSearchParams(location.hash.slice(1)).has('options'))await launch();
else try{await api('/api/session',{});await launch();}catch{
  const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.onload=()=>{widget=window.turnstile.render('#captcha',{sitekey:health.turnstileSiteKey});};document.head.append(script);
}
$('#auth-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{email=$('#auth-email').value.trim();await api('/api/auth/start',{email,captchaToken:window.turnstile?.getResponse(widget)});$('#code-form').classList.remove('hidden');$('#auth-message').textContent='Check your email for the sign-in code.';}catch(e){$('#auth-message').textContent=e.message;}finally{button.disabled=false;if(widget!==undefined)window.turnstile.reset(widget);}});
$('#code-form').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/auth/confirm',{email,code:$('#auth-code').value.trim()});location.reload();}catch(e){$('#auth-message').textContent=e.message;}});
