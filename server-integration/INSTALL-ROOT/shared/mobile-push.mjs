/** Madreseyar Student Android FCM delivery (opt-in server extension).
 * Device records are private server-side metadata in MADRESEYAR_DATA_DIR.
 * No Firebase credential is ever included in the code or client APK.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const base = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.MADRESEYAR_DATA_DIR ? path.resolve(process.env.MADRESEYAR_DATA_DIR) : path.resolve(base, '../data');
const file = path.join(dataDir, 'push-devices.json');
const fcmFlag = process.env.MADRESEYAR_FCM_ENABLED === '1';
const expiresAfter = 30 * 24 * 60 * 60 * 1000;
let lock = Promise.resolve();
let provider = null;
let providerPromise = null;
export function isPushEnabled() { return fcmFlag && !!process.env.GOOGLE_APPLICATION_CREDENTIALS; }

async function messaging() {
  if(!isPushEnabled()) return null;
  if(provider) return provider;
  if(!providerPromise) providerPromise=(async()=>{
    const {getApps, initializeApp, applicationDefault}=await import('firebase-admin/app');
    const {getMessaging}=await import('firebase-admin/messaging');
    const app=getApps().length?getApps()[0]:initializeApp({credential:applicationDefault()});
    return getMessaging(app);
  })().catch(e=>{providerPromise=null;console.warn('FCM initialization failed:',e.message);return null;});
  provider=await providerPromise;
  return provider;
}
async function read() {
  try {const parsed=JSON.parse(await fs.readFile(file,'utf8'));return Array.isArray(parsed)?parsed:[];}
  catch(e) {if(e.code==='ENOENT') return [];throw e;}
}
async function store(rows) {
  await fs.mkdir(dataDir,{recursive:true,mode:0o700});
  const temp=file+'.'+process.pid+'.tmp';
  await fs.writeFile(temp,JSON.stringify(rows),{mode:0o600});
  await fs.rename(temp,file);
}
async function mutate(fn) {
  const job=lock.then(async()=>{const entries=await read();const result=fn(entries);await store(entries);return result;});
  lock=job.catch(()=>{});return job;
}
export function validateDeviceId(value) {return /^[A-Za-z0-9_-]{10,80}$/.test(value||'');}
export function validateFcmToken(value) {return /^[A-Za-z0-9:_.-]{20,4096}$/.test(value||'');}
export async function registerPushDevice(studentId,deviceId,token,sessionHash) {
  if(!studentId||!validateDeviceId(deviceId)||!validateFcmToken(token)||!/^[a-f0-9]{64}$/i.test(sessionHash||'')) throw Object.assign(new Error('شناسه اعلان دستگاه معتبر نیست.'),{status:400});
  await mutate(rows=>{
    // Same device never belongs to two different students; enforce account switching.
    for(let i=rows.length-1;i>=0;i--) if(rows[i].deviceId===deviceId || rows[i].token===token) rows.splice(i,1);
    rows.push({studentId:String(studentId),deviceId,token,sessionHash,updatedAt:Date.now()});
    const mine=rows.filter(x=>x.studentId===String(studentId)).sort((a,b)=>b.updatedAt-a.updatedAt);
    if(mine.length>5){const keep=new Set(mine.slice(0,5).map(x=>x.deviceId));for(let i=rows.length-1;i>=0;i--)if(rows[i].studentId===String(studentId)&&!keep.has(rows[i].deviceId))rows.splice(i,1);}
  });
  return {ok:true,enabled:!!(await messaging())};
}
export async function unregisterPushDevice(studentId,deviceId) {
  if(!validateDeviceId(deviceId)) throw Object.assign(new Error('شناسه دستگاه معتبر نیست.'),{status:400});
  await mutate(rows=>{for(let i=rows.length-1;i>=0;i--)if(rows[i].studentId===String(studentId)&&rows[i].deviceId===deviceId)rows.splice(i,1);});
  return {ok:true};
}
export async function sendPushToStudents(studentIds,{title='مدرسه‌یار',body='اعلان جدید دارید',screen='notifications',eventId=''},activeSessions) {
  if(!isPushEnabled())return {enabled:false,sent:0};
  const service=await messaging();if(!service)return {enabled:false,sent:0};
  const ids=new Set(studentIds.map(String));
  if(!ids.size)return {enabled:true,sent:0};
  const rows=(await read()).filter(x=>ids.has(x.studentId)&&Date.now()-x.updatedAt<expiresAfter&&activeSessions instanceof Set&&activeSessions.has(x.sessionHash));
  const tokens=[...new Set(rows.map(x=>x.token))];
  if(!tokens.length)return {enabled:true,sent:0};
  let count=0,errors=0;
  const payload={title:String(title).slice(0,100),body:String(body).slice(0,180),screen:['chat','tasks','exams','notifications','home'].includes(screen)?screen:'notifications',eventId:String(eventId||'').slice(0,120)};
  // Never expose student name, grade, message body or a link on the lock screen.
  for(let start=0;start<tokens.length;start+=500){
    const batch=tokens.slice(start,start+500);
    const result=await service.sendEachForMulticast({tokens:batch,data:payload,android:{priority:'high'}});
    count+=result.successCount;
    const invalid=new Set();result.responses.forEach((r,i)=>{
      if(r.success)return;
      errors++;
      if(['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(r.error?.code))invalid.add(batch[i]);
    });
    if(invalid.size)await mutate(records=>{for(let i=records.length-1;i>=0;i--)if(invalid.has(records[i].token))records.splice(i,1);});
  }
  if(errors)console.warn('FCM delivery: '+errors+' device(s) could not be notified.');
  return {enabled:true,sent:count,failed:errors};
}
