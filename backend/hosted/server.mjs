import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadEnv,root,requireEnv} from '../env.mjs';
import {AppError,uuid} from '../../supabase/functions/_shared/domain.mjs';
import {buildCommand} from '../../supabase/functions/_shared/commands.mjs';
import {itineraryPdf} from '../itinerary-pdf.mjs';
import {HostedSupabase} from './supabase.mjs';

export function validateHosting(env){
  requireEnv(env,['APP_ORIGIN','SUPABASE_URL','SUPABASE_ANON_KEY','TURNSTILE_SITE_KEY']);
  const u=new URL(env.APP_ORIGIN);if(u.protocol!=='https:'||u.origin!==env.APP_ORIGIN)throw Error('APP_ORIGIN must be an HTTPS origin without a path or trailing slash.');
  if(new URL(env.SUPABASE_URL).protocol!=='https:')throw Error('Hosted Supabase requires HTTPS.');
  return u.origin;
}
async function body(req){let n=0,b=[];for await(const c of req){n+=c.length;if(n>20000)throw new AppError('PAYLOAD_TOO_LARGE','Request too large.',413);b.push(c);}try{return JSON.parse(Buffer.concat(b).toString());}catch{throw new AppError('INVALID_JSON','Invalid request.');}}
const cookie=(name,value,maxAge)=>`${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
export async function startHostedApp({env,port=Number(process.env.PORT)||10000,fetchImpl=fetch}={}){
  env??=await loadEnv();const origin=validateHosting(env),db=new HostedSupabase(env,fetchImpl);
  const server=http.createServer(async(req,res)=>{
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Strict-Transport-Security':'max-age=31536000','Content-Security-Policy':"default-src 'self'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; connect-src 'self' https://challenges.cloudflare.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
    const reply=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify({data,error:null}));};
    try{
      const url=new URL(req.url,origin);
      if(req.method!=='GET'&&req.headers.origin!==origin)throw new AppError('ORIGIN_NOT_ALLOWED','Cross-origin request rejected.',403);
      if(req.method==='GET'&&['/','/app.mjs','/style.css','/hosted-auth.mjs'].includes(url.pathname)){
        const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
        let content=await fs.readFile(path.join(root,name==='hosted-auth.mjs'?'backend/hosted':'backend/local/ui',name),'utf8');
        if(name==='index.html')content=content.replace('<body>','<body><section id="hosted-auth" class="panel"><h2>Sign in to Voyage</h2><p>We’ll email a sign-in code. Your travel plans stay with your account.</p><form id="auth-form"><label>Email<input id="auth-email" type="email" required autocomplete="email"></label><div id="captcha"></div><button type="submit">Email sign-in code</button></form><form id="code-form" class="hidden"><label>Code from email<input id="auth-code" required autocomplete="one-time-code" maxlength="12"></label><button type="submit">Confirm code</button></form><p id="auth-message" role="status"></p></section>').replace('<script type="module" src="/app.mjs"></script>','<script type="module" src="/hosted-auth.mjs"></script>').replace('Runs on your computer · Embedded Postgres · Local sessions simulate sign-in. Supabase Auth is not being tested here.','Your plans are saved securely in Supabase. Email sharing is disabled; PDF downloads are available.').replace('LOCAL WORKBENCH','TRAVEL PLANNER').replace('Test the journey.','Plan your journey.').replace('Saved local trips','Saved trips');
        res.writeHead(200,{'Content-Type':name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript',...headers});res.end(content);return;
      }
      if(url.pathname==='/api/health'){reply({hosted:true,auth:'supabase',database:'Supabase Postgres',liveAvailable:true,fixtureAvailable:false,turnstileSiteKey:env.TURNSTILE_SITE_KEY});return;}
      if(url.pathname.startsWith('/api/email/'))throw new AppError('FEATURE_REMOVED','Email sharing is disabled. Download PDF instead.',410);
      const cookies=Object.fromEntries(String(req.headers.cookie??'').split(';').map(x=>x.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));
      const setSession=session=>{res.setHeader('Set-Cookie',[cookie('__Host-voyage_access',session.access_token,session.expires_in??3600),cookie('__Host-voyage_refresh',session.refresh_token,2592000)]);};
      if(req.method==='POST'&&url.pathname==='/api/auth/start'){
        const input=await body(req);if(typeof input.email!=='string'||input.email.length>254||!/^\S+@\S+\.\S+$/.test(input.email))throw new AppError('VALIDATION_ERROR','Enter a valid email.');
        if(typeof input.captchaToken!=='string'||!input.captchaToken)throw new AppError('CAPTCHA_FAILED','Complete the CAPTCHA.',400);
        await db.call('/auth/v1/otp',{auth:true,body:{email:input.email,create_user:true,gotrue_meta_security:{captcha_token:input.captchaToken}}});reply({sent:true});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/auth/confirm'){
        const input=await body(req);const session=await db.call('/auth/v1/verify',{auth:true,body:{email:input.email,token:input.code,type:'email'}});setSession(session);reply({signedIn:true});return;
      }
      if(req.method==='POST'&&url.pathname==='/api/auth/logout'){
        if(cookies['__Host-voyage_access'])await db.call('/auth/v1/logout',{token:cookies['__Host-voyage_access'],method:'POST',auth:true}).catch(()=>{});
        res.setHeader('Set-Cookie',[cookie('__Host-voyage_access','',0),cookie('__Host-voyage_refresh','',0)]);reply({signedOut:true});return;
      }
      let token=cookies['__Host-voyage_access'],user;
      if(token)user=await db.call('/auth/v1/user',{token,auth:true}).catch(()=>null);
      if(!user&&cookies['__Host-voyage_refresh']){const session=await db.call('/auth/v1/token?grant_type=refresh_token',{auth:true,body:{refresh_token:cookies['__Host-voyage_refresh']}});setSession(session);token=session.access_token;user=session.user;}
      const shared=url.pathname==='/api/command'&&req.method==='POST'?await body(req):null;
      if(shared&&['resolve-options-share','resolve-share'].includes(shared.action)){const c=await buildCommand(shared);reply(await db.rpc(c.name,c.args,token));return;}
      if(!user?.id||!user.email_confirmed_at)throw new AppError('UNAUTHORIZED','Sign in with your email code.',401);
      if(req.method==='POST'&&url.pathname==='/api/session'){reply({userId:user.id,authMode:'supabase'});return;}
      if(req.method==='GET'&&url.pathname==='/api/state'){const id=url.searchParams.get('tripId');if(id)uuid(id);reply({...await db.state(token,id),userId:user.id});return;}
      if(req.method==='GET'&&url.pathname==='/api/plan.pdf'){
        const id=uuid(url.searchParams.get('planId'));const row=(await db.rows('itinerary_versions',`id=eq.${id}&select=*`,token))[0];if(!row)throw new AppError('NOT_FOUND','Plan not found.',404);
        const trip=(await db.rows('trips',`id=eq.${row.trip_id}&select=*`,token))[0];row.is_current=trip?.current_revision===row.brief_revision&&trip?.selected_option_id===row.selected_option_id;
        const sources=await db.rows('research_sources',`job_id=eq.${row.job_id}&select=*`,token);const pdf=await itineraryPdf(row,sources);if(pdf.length>5*1024*1024)throw new AppError('PDF_TOO_LARGE','PDF exceeds 5 MB.',413);
        res.writeHead(200,{...headers,'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="voyage-itinerary.pdf"'});res.end(pdf);return;
      }
      if(shared){if(['save-contact-email','get-contact-email'].includes(shared.action))throw new AppError('FEATURE_REMOVED','Email sharing is disabled.',410);const c=await buildCommand(shared);const result=await db.rpc(c.name,c.args,token);reply(c.issuedToken?{id:result,token:c.issuedToken}:result);return;}
      throw new AppError('NOT_FOUND','Not found.',404);
    }catch(e){const safe=e instanceof AppError?e:new AppError('SERVER_ERROR','Request failed. Try again later.',500);res.writeHead(safe.status,{'Content-Type':'application/json',...headers});res.end(JSON.stringify({data:null,error:{code:safe.code,message:safe.message}}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
  return{server,close:()=>new Promise(r=>server.close(r))};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){await startHostedApp();console.log('Voyage hosted HTTP server ready.');}
