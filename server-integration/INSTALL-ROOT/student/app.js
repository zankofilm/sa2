
// v47.00 — نمایش تاریخ‌های رابط کاربری به تقویم شمسی
(function installPersianDateDisplay(){
  if(window.__msyPersianDateDisplay)return;
  window.__msyPersianDateDisplay=true;
  const fmt=new Intl.DateTimeFormat("fa-IR-u-ca-persian",{dateStyle:"medium",timeStyle:"short"});
  const fmtDate=new Intl.DateTimeFormat("fa-IR-u-ca-persian",{dateStyle:"medium"});
  function convert(text){
    if(!text || typeof text!=="string") return text;
    return text.replace(/\b(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,(all,date,time)=>{
      const d=new Date(time ? `${date}T${time}:00` : `${date}T00:00:00`);
      if(Number.isNaN(d.getTime())) return all;
      try{return time ? fmt.format(d) : fmtDate.format(d);}catch{return all;}
    });
  }
  function walk(root){
    const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    const nodes=[]; let n; while(n=w.nextNode()) nodes.push(n);
    for(const node of nodes){const next=convert(node.nodeValue);if(next!==node.nodeValue)node.nodeValue=next;}
  }
  const start=()=>walk(document.body);
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});else start();
  new MutationObserver(ms=>{for(const m of ms){for(const n of m.addedNodes){if(n.nodeType===1)walk(n);}}}).observe(document.documentElement,{childList:true,subtree:true});
})();

(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const SERVER_KEY = "msy.v13.server";
  const FIXED_SERVER = "https://scooljavanrood.ir/app";
  const TOKEN_KEY = "msy.v13.token";
  const THEME_KEY = "msy.v13.theme";
  const DB_NAME = "madreseyar-student-v13";
  // نسخه اندروید ۴۵.۴: سرور مدرسه ثابت است و از تنظیمات قدیمی استفاده نمی‌شود.
  localStorage.setItem(SERVER_KEY, FIXED_SERVER);
  if (!localStorage.getItem(THEME_KEY) && localStorage.getItem("msy.v12.theme")) localStorage.setItem(THEME_KEY, localStorage.getItem("msy.v12.theme"));
  const DB_VERSION = 1;
  const EXAM_STORE = "exams";
  const DRAFT_STORE = "drafts";
  const QUEUE_STORE = "queue";
  const CACHE_STORE = "cache";
  const PROFILE_CACHE_ID = "student-profile-v41";
  const fa = n => new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 1 }).format(Number(n || 0));
  const dateFa = value => { try { return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); } catch { return String(value || ""); } };
  const esc = value => String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
  const uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
  const normalizeDigits = value => String(value || "").replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/\D/g, "");

  function detectHostedServer(){
    if(!location.protocol.startsWith("http"))return "";
    const pathname=location.pathname||"/";
    const marker="/student/";
    const idx=pathname.indexOf(marker);
    const basePath=idx>=0?pathname.slice(0,idx):"";
    return `${location.origin}${basePath}`.replace(/\/+$/,"");
  }
  const hostedOrigin = detectHostedServer();
  // رابط برنامه از فایل‌های داخلی APK ارائه می‌شود؛ اتصال شبکه فقط هنگام اقدام صریح کاربر برای احراز هویت، دریافت آزمون، ارسال پاسخ‌ها، دریافت نتیجه/تحلیل، ثبت اعتراض و به‌روزرسانی پروفایل مجاز است.
  let server = (hostedOrigin && !/\.invalid(?::\d+)?$/i.test(new URL(hostedOrigin).hostname)) ? hostedOrigin : FIXED_SERVER;
  if (!location.protocol.startsWith("http") || /\.invalid$/i.test(location.hostname)) server = FIXED_SERVER;
  localStorage.setItem(SERVER_KEY, server);
  let token = localStorage.getItem(TOKEN_KEY) || "";
  let dashboard = null;
  let currentPage = "home";
  const STUDENT_NAV_KEY_V4528 = "msyStudentPage";
  let examSession = null;
  let examTimer = null;
  let syncing = false;
  let selectedExamSubject = "";
  let selectedResultSubject = "";
  let networkPermitDepth = 0;
  let networkReason = "";
  async function withNetwork(reason, fn) {
    networkPermitDepth += 1; const previous = networkReason; networkReason = reason || "manual";
    try { return await fn(); } finally { networkPermitDepth = Math.max(0, networkPermitDepth - 1); networkReason = previous; }
  }
  function networkAllowed() { return networkPermitDepth > 0; }
  function localOnlyError() { const e = new Error("این بخش در حالت محلی است و بدون اقدام شما به اینترنت وصل نمی‌شود."); e.code = "OFFLINE_POLICY"; return e; }

  function cleanServer(value) {
    let url = String(value || "").trim().replace(/\/+$/, "");
    if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`;
    return url;
  }
  function toast(text, type = "") {
    const el = document.createElement("div"); el.className = `toast ${type}`; el.textContent = text; $("toastHost").appendChild(el); setTimeout(() => el.remove(), 3300);
  }
  function setSync(text) { if ($("syncLabel")) $("syncLabel").textContent = text; }
  function openModal(html) { $("modalSheet").innerHTML = html; $("modal").classList.remove("hidden"); $("modal").querySelectorAll("[data-close]").forEach(b => b.onclick = closeModal); }
  function closeModal() { $("modal").classList.add("hidden"); $("modalSheet").innerHTML = ""; }
  $("modal").addEventListener("click", e => { if (e.target === $("modal")) closeModal(); });

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of [EXAM_STORE, DRAFT_STORE, QUEUE_STORE, CACHE_STORE]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
  }
  async function storePut(store, value) { const db = await openDb(); return new Promise((resolve, reject) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put(value); tx.oncomplete = () => { db.close(); resolve(value); }; tx.onerror = () => reject(tx.error); }); }
  async function storeGet(store, id) { const db = await openDb(); return new Promise((resolve, reject) => { const tx = db.transaction(store, "readonly"); const req = tx.objectStore(store).get(id); req.onsuccess = () => { db.close(); resolve(req.result); }; req.onerror = () => reject(req.error); }); }
  async function storeAll(store) { const db = await openDb(); return new Promise((resolve, reject) => { const tx = db.transaction(store, "readonly"); const req = tx.objectStore(store).getAll(); req.onsuccess = () => { db.close(); resolve(req.result || []); }; req.onerror = () => reject(req.error); }); }
  async function storeDelete(store, id) { const db = await openDb(); return new Promise((resolve, reject) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).delete(id); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }); }
  async function storeClear(store) { const db = await openDb(); return new Promise((resolve, reject) => { const tx = db.transaction(store, "readwrite"); tx.objectStore(store).clear(); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }); }

  function examStateId(examId) { return `exam_state_${examId}`; }
  async function getLocalExamState(examId) { return (await storeGet(CACHE_STORE, examStateId(examId)))?.data || null; }
  async function markExamSubmittedLocal(examId, info = {}) {
    const submittedAt = Number(info.submittedAt || Date.now());
    const receipt = info.receipt || info;
    const state = { status:"submitted", examId, submittedAt, receiptId:receipt.receiptId || info.receiptId || "", receiptHash:receipt.receiptHash || info.receiptHash || "", sheetCode:receipt.sheetCode || info.sheetCode || "", result:receipt.result || info.result || null, serverConfirmed:info.serverConfirmed !== false, savedAt:Date.now() };
    await storePut(CACHE_STORE,{id:examStateId(examId),data:state,savedAt:Date.now()});
    if (state.receiptId || state.receiptHash || state.sheetCode || state.result) await storePut(CACHE_STORE,{id:`receipt_${examId}`,data:{...receipt,receiptId:state.receiptId||receipt.receiptId,receiptHash:state.receiptHash||receipt.receiptHash,submittedAt:state.submittedAt,sheetCode:state.sheetCode||receipt.sheetCode,result:state.result||receipt.result},savedAt:Date.now()});
    await storeDelete(DRAFT_STORE,examId);
    await storeDelete(EXAM_STORE,examId);
    const live = findExam(examId); if (live) { live.studentStatus="submitted"; live.submissionInfo={...(live.submissionInfo||{}),status:"submitted",submittedAt:state.submittedAt,receiptId:state.receiptId||live.submissionInfo?.receiptId||""}; }
    return state;
  }
  async function reconcileSubmittedExams(data) {
    if (!data?.exams) return;
    const submittedIds = new Set(data.exams.filter(e=>e.studentStatus==="submitted").map(e=>e.id));
    for (const exam of data.exams) {
      if (exam.studentStatus !== "submitted") continue;
      const local = await getLocalExamState(exam.id);
      const info = exam.submissionInfo || {};
      const finalResult = info.gradingStatus === "final" && ["mcq","mixed"].includes(info.kind)
        ? { status:"final", score:Number(info.score||0), total:Number(info.total||0), percent:Number(info.total||0)?Math.round(Number(info.score||0)/Number(info.total||1)*1000)/10:0 }
        : (local?.result || null);
      await markExamSubmittedLocal(exam.id,{...local,...info,result:finalResult,receiptId:info.receiptId||local?.receiptId||"",submittedAt:info.submittedAt||local?.submittedAt||Date.now(),serverConfirmed:true});
    }
    if (submittedIds.size) {
      const queue = await storeAll(QUEUE_STORE);
      for (const item of queue) if (submittedIds.has(item.examId)) await storeDelete(QUEUE_STORE,item.id);
    }
  }

  async function api(path, options = {}, allowOffline = false) {
    if (!networkAllowed()) { if (allowOffline) return null; throw localOnlyError(); }
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const response = await fetch(`${server}${path}`, { ...options, headers, cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) { logout(false); throw new Error(data.error || "ورود شما منقضی شده است."); }
      if (response.status === 428) { const err = new Error(data.error || "تغییر رمز اولیه لازم است."); err.status=428; err.data=data; throw err; }
      if (!response.ok) { const err = new Error(data.error || `خطای سرور (${response.status})`); err.status = response.status; err.data = data; throw err; }
      return data;
    } catch (error) {
      if (allowOffline && (error.name === "TypeError" || /fetch/i.test(error.message))) return null;
      throw error;
    }
  }

  async function testConnection() {
    server = FIXED_SERVER;
    localStorage.setItem(SERVER_KEY, server);
    const state = $("connectionState");
    if (state) { state.className = "connection"; state.innerHTML = '<span class="dot"></span><span>در حال اتصال خودکار به سرور مدرسه…</span>'; }
    let timer = null;
    try {
      const controller = new AbortController(); timer = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(`${FIXED_SERVER}/api/ping`, { signal: controller.signal, cache: "no-store", mode: "cors" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (state) { state.className = "connection online"; state.innerHTML = '<span class="dot"></span><span>ارتباط با سرور مدرسه برقرار است</span>'; }
      return true;
    } catch (error) {
      if (state) { state.className = "connection offline"; state.innerHTML = '<span class="dot"></span><span>ارتباط با سرور برقرار نشد؛ اینترنت گوشی را بررسی کنید</span>'; }
      return false;
    } finally { if (timer) clearTimeout(timer); }
  }

  function readBirthDate() {
    const dayInput = $("birthDayInput");
    const monthInput = $("birthMonthInput");
    const yearInput = $("birthYearInput");
    const day = normalizeDigits(dayInput.value).slice(0, 2);
    const month = normalizeDigits(monthInput.value).slice(0, 2);
    const year = normalizeDigits(yearInput.value).slice(0, 4);
    dayInput.value = day; monthInput.value = month; yearInput.value = year;
    const validDay = /^\d{1,2}$/.test(day) && Number(day) >= 1 && Number(day) <= 31;
    const validMonth = /^\d{1,2}$/.test(month) && Number(month) >= 1 && Number(month) <= 12;
    const validYear = /^\d{4}$/.test(year) && Number(year) >= 1300 && Number(year) <= 1500;
    dayInput.classList.toggle("invalid", !validDay);
    monthInput.classList.toggle("invalid", !validMonth);
    yearInput.classList.toggle("invalid", !validYear);
    if (!validDay || !validMonth || !validYear) return "";
    dayInput.value = day.padStart(2, "0");
    monthInput.value = month.padStart(2, "0");
    return `${year}${month.padStart(2, "0")}${day.padStart(2, "0")}`;
  }

  function bindBirthDateInputs() {
    const items = [
      { el: $("birthDayInput"), max: 2 },
      { el: $("birthMonthInput"), max: 2 },
      { el: $("birthYearInput"), max: 4 }
    ];
    items.forEach((item, index) => {
      item.el.addEventListener("input", () => {
        item.el.value = normalizeDigits(item.el.value).slice(0, item.max);
        item.el.classList.remove("invalid");
        if (item.el.value.length === item.max && items[index + 1]) items[index + 1].el.focus();
      });
      item.el.addEventListener("keydown", event => {
        if (event.key === "Backspace" && !item.el.value && items[index - 1]) items[index - 1].el.focus();
        if (event.key === "Enter") login();
      });
    });
  }

  async function forceStudentPasswordChange(){
    return new Promise(resolve=>{openModal(`<div class="section-title"><h3>ساخت رمز شخصی</h3></div><p class="muted">ورود اولیه با تاریخ تولد فقط یک‌بار مجاز است. اکنون یک رمز شخصی حداقل ۸ نویسه‌ای بسازید.</p><label class="field"><span>رمز جدید</span><input id="studentNewPassword" type="password" autocomplete="new-password"></label><label class="field"><span>تکرار رمز جدید</span><input id="studentRepeatPassword" type="password" autocomplete="new-password"></label><p id="studentPasswordMessage" class="form-message"></p><button id="studentPasswordSave" class="btn primary">ثبت رمز و ادامه</button>`);const save=$("studentPasswordSave");save.onclick=async()=>{const a=$("studentNewPassword").value,b=$("studentRepeatPassword").value,msg=$("studentPasswordMessage");msg.textContent="";if(a!==b){msg.textContent="تکرار رمز با رمز جدید یکسان نیست.";return;}save.disabled=true;try{await api("/api/student/change-password",{method:"POST",body:JSON.stringify({newPassword:a})});closeModal();resolve(true);}catch(error){msg.textContent=error.message||"تغییر رمز ناموفق بود.";save.disabled=false;}};});
  }
  async function login() {
    $("authMessage").textContent = "";server=FIXED_SERVER;localStorage.setItem(SERVER_KEY,server);
    const nationalId=normalizeDigits($("nationalIdInput").value),password=String($("studentPasswordInput")?.value||""),birthDate=password?"":readBirthDate();
    if(!/^\d{10}$/.test(nationalId)){$("authMessage").textContent="کد ملی باید دقیقاً ۱۰ رقم باشد.";$("nationalIdInput").focus();return;}
    if(!password&&!birthDate){$("authMessage").textContent="رمز عبور را وارد کنید؛ اگر اولین ورود است تاریخ تولد را کامل وارد کنید.";return;}
    $("loginBtn").disabled=true;$("loginBtn").textContent="در حال احراز هویت…";const state=$("connectionState");if(state){state.className="connection";state.innerHTML='<span class="dot"></span><span>اتصال موقت برای احراز هویت…</span>';}
    try{await withNetwork("auth",async()=>{const data=await api("/api/student/login",{method:"POST",body:JSON.stringify({nationalId,password,birthDate})});token=data.token;localStorage.setItem(TOKEN_KEY,token);if(data.mustChangePassword)await forceStudentPasswordChange();const firstDashboard=await api("/api/student/dashboard");dashboard=firstDashboard;await storePut(CACHE_STORE,{id:"dashboard",data:firstDashboard,savedAt:Date.now()});});if(state){state.className="connection offline-first";state.innerHTML='<span class="dot"></span><span>احراز هویت انجام شد؛ حالت محلی فعال است</span>';}showApp();}
    catch(e){$("authMessage").textContent=e.message||"ارتباط با سرور مدرسه برقرار نشد.";if(state){state.className="connection offline";state.innerHTML='<span class="dot"></span><span>احراز هویت انجام نشد</span>';}}
    finally{$("loginBtn").disabled=false;$("loginBtn").textContent="ورود به حساب دانش‌آموز";}
  }

  async function logout(callServer = false) {
    // Android push: revoke only this installation before discarding local credentials.
    // Offline logout cannot reach the server; registrations expire after 30 days.
    const nativeDeviceId=localStorage.getItem("msy.nativePush.deviceId");
    if(token&&nativeDeviceId&&navigator.onLine){
      try{fetch(FIXED_SERVER+"/api/student/mobile-push/unregister",{
        method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
        body:JSON.stringify({deviceId:nativeDeviceId}),keepalive:true
      }).catch(()=>{});}catch(_){/* do not prevent logout */}
    }
    token = ""; dashboard = null; localStorage.removeItem(TOKEN_KEY); clearInterval(examTimer); examSession = null;
    $("appView").classList.add("hidden"); $("authView").classList.remove("hidden");
  }

  async function syncDashboard(silent = false) {
    if (syncing) return; syncing = true; if (!silent) setSync(networkAllowed()?"در حال دریافت…":"حالت محلی");
    try {
      let data = null;
      if (networkAllowed()) data = await api("/api/student/dashboard", {}, true);
      if (data) { dashboard = data; await reconcileSubmittedExams(data); await storePut(CACHE_STORE, { id:"dashboard", data, savedAt:Date.now() }); setSync("ذخیره شد"); }
      else { const cached = await storeGet(CACHE_STORE, "dashboard"); if (cached) dashboard = cached.data; setSync("حالت محلی"); }
    } catch (e) { const cached = await storeGet(CACHE_STORE, "dashboard"); if (cached) dashboard = cached.data; setSync("حالت محلی"); if (!silent && e.code!=="OFFLINE_POLICY") toast(e.message, "danger"); }
    finally { syncing = false; }
  }

  async function refreshResultsCacheV4517() {
    if (!token || !networkAllowed()) return null;
    try {
      const data = await api("/api/student/results", {}, true);
      if (data) {
        await storePut(CACHE_STORE,{id:"results",data,savedAt:Date.now()});
        if (dashboard) dashboard.report = data.report || dashboard.report || [];
        return data;
      }
    } catch {}
    return null;
  }

  async function syncQueue(onlyExamId = "") {
    if (!token || !networkAllowed()) return 0;
    const allQueue = await storeAll(QUEUE_STORE);
    const queue = onlyExamId ? allQueue.filter(item=>item.examId===onlyExamId) : allQueue;
    if (!queue.length) return 0;
    setSync(`${fa(queue.length)} ارسال در صف`); let sent=0; const finalized=[];
    for (const item of queue.sort((a,b)=>a.createdAt-b.createdAt)) {
      try {
        const endpoint = item.kind === "mcq" ? `/api/student/exams/${encodeURIComponent(item.examId)}/submit` : item.kind === "mixed" ? `/api/student/exams/${encodeURIComponent(item.examId)}/submit-mixed` : `/api/student/exams/${encodeURIComponent(item.examId)}/submit-descriptive`;
        item.payload ||= {};
        item.payload.deliveryDiagnostics = {
          clientQueuedAt:Number(item.createdAt||0),
          clientFinalizedAt:Number(item.finalizedAt||item.payload.finalizedAt||0),
          clientRetryCount:Number(item.retryCount||0),
          clientLastTriedAt:Number(item.lastTriedAt||0)
        };
        const result = await api(endpoint,{method:"POST",body:JSON.stringify(item.payload)});
        await storeDelete(QUEUE_STORE,item.id);
        await markExamSubmittedLocal(item.examId,{...result,receipt:result,serverConfirmed:true});
        if (result?.gradingStatus === "final" && result?.result) finalized.push({examId:item.examId,title:item.title||"آزمون",...result.result});
        sent++;
      } catch(e) {
        if(e.status===409 && /قبلاً\s*تحویل|قبلا\s*تحویل|ثبت\s*شده/.test(String(e.message||""))){
          // سازگاری با صف‌های قدیمی قبل از v63 که submissionKey نداشتند.
          await storeDelete(QUEUE_STORE,item.id);
          await markExamSubmittedLocal(item.examId,{submittedAt:Date.now(),serverConfirmed:true,receiptId:"ثبت‌شده در سرور"});
          sent++;
        } else {
          item.lastError=String(e.message||"ارسال ناموفق");item.lastErrorStatus=Number(e.status||0);item.lastTriedAt=Date.now();item.retryCount=Number(item.retryCount||0)+1;
          await storePut(QUEUE_STORE,item);
          break;
        }
      }
    }
    try {
      const fresh = await api("/api/student/dashboard");
      dashboard = fresh; await reconcileSubmittedExams(fresh); await storePut(CACHE_STORE,{id:"dashboard",data:fresh,savedAt:Date.now()});
    } catch {}
    await refreshResultsCacheV4517();
    const remaining=await storeAll(QUEUE_STORE); setSync(remaining.length?`${fa(remaining.length)} ارسال در انتظار`:"حالت محلی");
    if(finalized.length){
      const last=finalized[finalized.length-1];
      toast(`آزمون تصحیح شد؛ نمره ${fa(last.score)} از ${fa(last.total)} در کارنامه ثبت شد.`,"ok");
    } else if(sent) toast(`${fa(sent)} آزمون با موفقیت تحویل مدرسه شد.`,"ok");
    return sent;
  }

  async function sendAllPendingExamAnswersV456(){
    const queue=await storeAll(QUEUE_STORE);
    if(!queue.length){toast("پاسخ در انتظاری وجود ندارد.","ok");return;}
    setSync("اتصال برای ارسال پاسخ‌ها…");
    try{await withNetwork("exam-submit",()=>syncQueue());}
    catch(e){toast("ارسال انجام نشد؛ پاسخ‌ها روی گوشی محفوظ هستند.","danger");}
    if(currentPage==="exams") await renderExams();
  }

  async function retryExamSubmission(examId){
    const queue=(await storeAll(QUEUE_STORE)).filter(item=>item.examId===examId);
    if(!queue.length){toast("این آزمون در صف ارسال نیست.","ok");await renderExams();return;}
    setSync("در حال ارسال مجدد…");
    try{await withNetwork("exam-submit",()=>syncQueue(examId));}
    catch(e){toast("ارسال مجدد انجام نشد؛ پاسخ روی گوشی محفوظ است.","danger");}
    await renderExams();
  }
  async function showSavedExamReceipt(examId){
    const exam=findExam(examId)||{id:examId,title:"آزمون"};
    const cached=(await storeGet(CACHE_STORE,`receipt_${examId}`))?.data;
    const state=await getLocalExamState(examId);
    const info=exam.submissionInfo||{};
    const serverResult = info.gradingStatus==="final" && ["mcq","mixed"].includes(info.kind) ? {status:"final",score:Number(info.score||0),total:Number(info.total||0)} : null;
    const receipt=cached||{receiptId:state?.receiptId||info.receiptId||"ثبت‌شده در سرور",receiptHash:state?.receiptHash||"",submittedAt:state?.submittedAt||info.submittedAt||0,sheetCode:state?.sheetCode||"",result:state?.result||serverResult,gradingStatus:info.gradingStatus||""};
    if(!receipt.result && serverResult) receipt.result=serverResult;
    showReceipt(exam,{...receipt,queued:false});
  }

  async function syncExamCenterV456(){
    if(!token)return; setSync("اتصال برای دریافت آزمون…");
    try{
      await withNetwork("exam-download",async()=>{
        const fresh=await api("/api/student/dashboard"); dashboard=fresh; await reconcileSubmittedExams(fresh); await storePut(CACHE_STORE,{id:"dashboard",data:fresh,savedAt:Date.now()});
        const available=(fresh.exams||[]).filter(e=>e.studentStatus==="available"); let downloaded=0;
        for(const exam of available){
          if(await storeGet(EXAM_STORE,exam.id)) continue;
          try{const data=await api(`/api/student/exams/${encodeURIComponent(exam.id)}/download`); data.exam.packageVersion=data.packageVersion;data.exam.attemptId=data.attemptId;data.exam.packageSignature=data.packageSignature;await storePut(EXAM_STORE,{id:exam.id,exam:data.exam,packageVersion:data.packageVersion,attemptId:data.attemptId,packageSignature:data.packageSignature,downloadedAt:data.downloadedAt});downloaded++;}catch{}
        }
        setSync("حالت محلی"); toast(downloaded?`${fa(downloaded)} آزمون جدید روی گوشی ذخیره شد.`:"فهرست آزمون‌ها بررسی شد؛ مورد جدیدی نبود.","ok");
      });
    }catch(e){setSync("حالت محلی");toast("دریافت آزمون انجام نشد؛ اینترنت را بررسی کنید.","danger");}
  }

  // p25: Photo registered in the school's student profile; read-only and scoped to logged-in student.
  // p44: Keep the student's profile picture consistent across header, home and profile.
  let p44PhotoGeneration=0;
  let p44KnownPhoto='';
  function p44PaintPhoto(photo, student=dashboard?.student||{}){
    const initial=String(student.firstName||'د').slice(0,1);
    const valid=typeof photo==='string' && /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(photo);
    for(const id of ['studentAvatarP25','studentHeroPhotoP25']){
      const el=document.getElementById(id);if(!el)continue;
      el.replaceChildren();
      if(valid){const img=document.createElement('img');img.src=photo;img.alt='عکس پروفایل دانش‌آموز';img.loading='eager';img.decoding='async';el.appendChild(img);}
      else el.textContent=initial;
    }
  }
  async function refreshSchoolPhotoP25(){
    const generation=++p44PhotoGeneration;
    const student=dashboard?.student||{};
    let photo=String(student.photoDataUrl||student.profilePhotoDataUrl||student.photoUrl||student.profilePhoto||'');
    try{
      const cached=await getCachedProfileV37();
      if(cached?.photoPending){photo=cached.removePhoto?'':String(cached.photoDataUrl||'');}
      else if(!photo)photo=String(cached?.photoDataUrl||'');
    }catch{}
    if(generation!==p44PhotoGeneration)return;
    if(photo||!p44KnownPhoto)p44KnownPhoto=photo;
    p44PaintPhoto(photo||p44KnownPhoto,student);
    if(!token)return;
    try{
      const result=await withNetwork('student-photo-read',()=>api('/api/student/profile/photo',{},true));
      if(generation!==p44PhotoGeneration)return;
      const actual=String(result?.photoDataUrl||'');
      const cached=await getCachedProfileV37();
      if(cached?.photoPending)return; // Do not overwrite an unsynced local photo.
      p44KnownPhoto=actual;
      p44PaintPhoto(actual,student);
      if(actual!==String(cached?.photoDataUrl||''))await cacheProfileV37(cached?.profile||student,actual,Boolean(cached?.pendingSync),false,false);
    }catch{/* Offline mode keeps the locally cached profile picture. */}
  }
  function showApp() {
    $("authView").classList.add("hidden"); $("appView").classList.remove("hidden");
    const s = dashboard?.student; $("avatarText").textContent = s?.firstName?.slice(0,1) || "د";
    updateNotificationBadge(); navigate(currentPage,{fromPop:true}); refreshSchoolPhotoP25();
    // v45.27: پس از ورود از کش محلی استفاده می‌کنیم، اما بلافاصله یک همگام‌سازی سبک
    // انجام می‌دهیم تا آزمون/تکلیف تازه‌ای که معلم همین الآن منتشر کرده از قلم نیفتد.
    syncDashboard(true).then(()=>{ if(currentPage === "exams" || currentPage === "tasks" || currentPage === "home") navigate(currentPage,{fromPop:true}); }).catch(()=>{});
  }
  function updateNotificationBadge() {
    const count = (dashboard?.notifications || []).filter(n => !n.read).length + (dashboard?.announcements || []).filter(a => a.priority === "urgent").length; $("notificationBadge").textContent = fa(count); $("notificationBadge").classList.toggle("hidden", !count);
  }
  function navigate(page, opts = {}) {
    const target = page || "home";
    if (!opts.fromPop && currentPage !== target) history.pushState({[STUDENT_NAV_KEY_V4528]:target}, "", location.href);
    currentPage = target; document.querySelectorAll("#bottomNav button").forEach(b => b.classList.toggle("active", b.dataset.page === target));
    const titles = { home:"خانه", exams:"آزمون‌ها", tasks:"تکالیف", results:"کارنامه", more:"امکانات دانش‌آموزی", schedule:"برنامه هفتگی", resources:"منابع آموزشی", learning:"یادگیری من", appeals:"اعتراض‌ها", family:"خانواده و اولیا", profile:"پروفایل" };
    $("pageTitle").textContent = titles[target] || "مدرسه‌یار";
    const back = $("pageBackBtn"); if(back) back.classList.toggle("hidden", target === "home");
    const renderer = { home: renderHome, exams: renderExams, tasks: renderTasks, results: renderResults, more: renderMore, schedule: renderSchedule, resources: renderResources, learning: renderLearningV28, appeals: renderAppeals, family: renderFamilyV22, profile: renderProfile }[target] || renderHome;
    renderer(); window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function subjectIcon(subject) { if (/علوم/.test(subject)) return "⚗"; if (/ریاضی/.test(subject)) return "∑"; if (/فارسی|نگارش/.test(subject)) return "✍"; if (/مطالعات/.test(subject)) return "🌍"; if (/عربی/.test(subject)) return "ع"; if (/انگلیسی/.test(subject)) return "A"; return "📘"; }
  function groupBySubject(rows) {
    const map = new Map();
    for (const row of rows || []) { const subject = String(row.subject || "سایر درس‌ها"); if (!map.has(subject)) map.set(subject, { subject, bookTitle: row.bookTitle || subject, rows: [] }); const group = map.get(subject); group.rows.push(row); if (row.bookTitle) group.bookTitle = row.bookTitle; }
    return [...map.values()].sort((a,b)=>a.subject.localeCompare(b.subject,"fa"));
  }
  function groupByChapter(rows) {
    const map = new Map();
    for (const row of rows || []) { const chapter = String(row.chapter || "بدون فصل"); if (!map.has(chapter)) map.set(chapter, []); map.get(chapter).push(row); }
    return [...map.entries()].sort((a,b)=>a[0].localeCompare(b[0],"fa",{numeric:true}));
  }
  function bookGrid(groups, mode) {
    return `<div class="book-grid">${groups.map(group=>{ const finalCount = mode === "results" ? group.rows.filter(x=>x.status==="final").length : group.rows.filter(x=>x.studentStatus==="submitted").length; const caption = mode === "results" ? `${fa(group.rows.length)} آزمون · ${fa(finalCount)} نتیجه نهایی` : `${fa(group.rows.length)} آزمون · ${fa(finalCount)} تحویل‌شده`; return `<button class="book-card" data-book-subject="${esc(group.subject)}"><span class="book-icon">${subjectIcon(group.subject)}</span><b>${esc(group.bookTitle || group.subject)}</b><small>${esc(caption)}</small><span class="book-open">مشاهده فصل‌ها ←</span></button>`; }).join("")}</div>`;
  }
  function findExam(id) { return (dashboard?.exams || []).find(e => e.id === id); }
  function attemptFor(id) { return (dashboard?.attempts || []).find(a => a.examId === id); }
  function submissionFor(id) { return (dashboard?.submissions || []).find(a => a.examId === id); }
  function pendingGradeCount() { return (dashboard?.submissions || []).filter(s => !(dashboard?.grades || []).some(g => g.submissionId === s.id)).length; }

  // v74 — online/hybrid school client
  function localDateV74(d=new Date()){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),day=String(d.getDate()).padStart(2,"0");return `${y}-${m}-${day}`;}
  function dayNameV74(d=new Date()){return ({0:"یکشنبه",1:"دوشنبه",2:"سه‌شنبه",3:"چهارشنبه",4:"پنجشنبه",5:"جمعه",6:"شنبه"})[d.getDay()]||"";}
  function modeLabelV74(mode){return ({in_person:"حضوری",online:"آنلاین",hybrid:"ترکیبی",inherit:"طبق مدرسه"})[mode]||mode||"حضوری";}
  function onlineSessionForEntryV74(entryId){const date=localDateV74(),rows=(dashboard?.onlineClassSessions||[]).filter(x=>x.scheduleEntryId===entryId&&x.date===date&&x.status!=="cancelled");return rows.find(x=>x.status==="live")||rows.find(x=>x.status==="scheduled")||rows.find(x=>x.status==="ended")||null;}
  function canJoinOnlineEntryV74(e){const session=onlineSessionForEntryV74(e.id);if(session?.status==="ended")return false;return Boolean(session?.meetingUrl||e.meetingUrl);}
  function onlineTodayEntriesV74(){const ol=dashboard?.onlineLearning||{},today=dayNameV74();if(!ol.enabled)return[];return (dashboard?.weeklySchedule||[]).filter(e=>e.day===today&&["online","hybrid"].includes(e.effectiveMode));}
  async function refreshOnlineSchoolV74(){try{await withNetwork("online-school-refresh",()=>syncDashboard(true));navigate(currentPage,{fromPop:true});toast("آخرین برنامه و وضعیت کلاس‌ها دریافت شد.","ok");}catch(e){toast(e.message||"به‌روزرسانی کلاس‌ها انجام نشد.","danger");}}
  function onlineTodayCardV74(){const ol=dashboard?.onlineLearning||{},rows=onlineTodayEntriesV74();if(!ol.enabled)return"";return `<section class="card" style="margin:12px 0"><div class="row between"><div><b>🌐 مدرسه ${esc(modeLabelV74(ol.operationMode))}</b><small style="display:block;margin-top:4px">کلاس‌های آنلاین امروز از همین پنل باز می‌شوند و ورود شما در مدرسه‌یار ثبت می‌شود.</small></div><span class="chip ${ol.operationMode==="online"?"ok":"warn"}">${esc(modeLabelV74(ol.operationMode))}</span></div>${rows.length?`<div class="list mt">${rows.map(e=>{const session=onlineSessionForEntryV74(e.id),joinable=canJoinOnlineEntryV74(e);return `<div class="list-item"><div class="list-icon">🎥</div><div class="list-main"><b>${esc(e.subject)} · زنگ ${fa(e.periodNo)}</b><small>${esc(e.startTime||"")} تا ${esc(e.endTime||"")}${e.teacherName?` · ${esc(e.teacherName)}`:""}${session?.status==="live"?" · در حال برگزاری":session?.status==="ended"?" · پایان‌یافته":""}</small></div>${joinable?`<button class="btn primary" data-online-join-v74="${esc(e.id)}">ورود به کلاس</button>`:session?.status==="ended"?'<span class="chip">پایان‌یافته</span>':'<button class="btn secondary" data-online-refresh-v74>به‌روزرسانی</button>'}</div>`;}).join("")}</div>`:'<div class="empty" style="margin-top:10px">امروز کلاس آنلاین برنامه‌ریزی‌شده‌ای نداری.</div>'}<div class="row" style="margin-top:10px"><button class="btn secondary" data-online-refresh-v74>دریافت آخرین وضعیت کلاس‌ها</button></div>${ol.instructions?`<small style="display:block;margin-top:10px">${esc(ol.instructions)}</small>`:""}</section>`;}
  // v79 — authoritative weekly schedule delivered from the admin timetable.
  function todayScheduleEntriesV79(){const rows=Array.isArray(dashboard?.todaySchedule)?dashboard.todaySchedule:(dashboard?.weeklySchedule||[]).filter(e=>e.day===dayNameV74());return rows.slice().sort((a,b)=>(Number(String(a.startTime||"00:00").replace(":",""))||0)-(Number(String(b.startTime||"00:00").replace(":",""))||0)||Number(a.periodNo||0)-Number(b.periodNo||0));}
  function todayScheduleCardV79(){const rows=todayScheduleEntriesV79(),updated=dashboard?.scheduleUpdatedAt||"";return `<section class="card" style="margin:12px 0"><div class="row between"><div><b>📅 برنامه امروز</b><small style="display:block;margin-top:4px">همان برنامه‌ای که مدیریت مدرسه برای کلاس شما ثبت کرده است.</small></div><button class="btn secondary" data-go="schedule">برنامه کامل هفته</button></div>${updated?`<small style="display:block;margin-top:8px;color:var(--muted,#667085)">آخرین تغییر برنامه: ${esc(updated)}</small>`:""}${rows.length?`<div class="list mt">${rows.map(e=>{const session=onlineSessionForEntryV74(e.id),joinable=["online","hybrid"].includes(e.effectiveMode)&&canJoinOnlineEntryV74(e);return `<div class="list-item"><div class="list-icon">${["online","hybrid"].includes(e.effectiveMode)?"🎥":"📘"}</div><div class="list-main"><b>${esc(e.subject||"درس")} · زنگ ${fa(e.periodNo)}</b><small>${esc(e.startTime||"")} تا ${esc(e.endTime||"")}${e.teacherName?` · ${esc(e.teacherName)}`:""}${e.shiftName?` · ${esc(e.shiftName)}`:""}</small></div>${joinable?`<button class="btn primary" data-online-join-v74="${esc(e.id)}">ورود</button>`:`<span class="chip ${["online","hybrid"].includes(e.effectiveMode)?"ok":""}">${esc(modeLabelV74(e.effectiveMode))}</span>`}</div>`;}).join("")}</div>`:'<div class="empty" style="margin-top:10px">برای امروز کلاسی در برنامه شما ثبت نشده است.</div>'}</section>`;}
  function dateLabelV76(value){try{return new Intl.DateTimeFormat("fa-IR",{year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(`${value}T12:00:00`));}catch{return value||"—";}}
  function calendarTypeLabelV76(type){return ({instruction:"آموزشی",holiday:"تعطیل",closure:"تعطیلی اضطراری",exam:"آزمون",meeting:"جلسه",event:"رویداد"})[type]||"رویداد";}
  function academicCalendarCardV76(){const year=dashboard?.academicYearModel,all=Array.isArray(dashboard?.calendarEvents)?dashboard.calendarEvents:[],today=localDateV74(),future=all.filter(e=>String(e.endDate||e.startDate||"")>=today),rows=(future.length?future:all).slice(0,4);if(!year&&!rows.length)return"";const activeTerm=(year?.terms||[]).find(t=>t.status==="active")||(year?.terms||[])[0];return `<section class="card" style="margin:12px 0"><div class="row between"><div><b>🗓 تقویم آموزشی</b><small style="display:block;margin-top:4px">${esc(year?.label||dashboard?.student?.academicYear||"")}${activeTerm?` · ${esc(activeTerm.title||"")}`:""}</small></div>${activeTerm?`<span class="chip ok">${esc(activeTerm.status==="active"?"در حال اجرا":activeTerm.status||"")}</span>`:""}</div>${rows.length?`<div class="list mt">${rows.map(e=>`<div class="list-item"><div class="list-icon">${e.type==="holiday"||e.type==="closure"?"🏫":"📅"}</div><div class="list-main"><b>${esc(e.title)}</b><small>${dateLabelV76(e.startDate)}${e.endDate&&e.endDate!==e.startDate?` تا ${dateLabelV76(e.endDate)}`:""} · ${esc(calendarTypeLabelV76(e.type))}</small>${e.note?`<small>${esc(e.note)}</small>`:""}</div>${e.blocksTeaching?'<span class="chip warn">بدون کلاس</span>':''}</div>`).join("")}</div>`:'<div class="empty" style="margin-top:10px">رویداد آموزشی آینده‌ای ثبت نشده است.</div>'}</section>`;}
  async function joinOnlineClassV74(scheduleEntryId){const button=document.querySelector(`[data-online-join-v74="${CSS.escape(scheduleEntryId)}"]`);if(button){button.disabled=true;button.textContent="در حال اتصال…";}let popup=null;try{popup=window.open("about:blank","_blank");const result=await withNetwork("online-class-join",()=>api("/api/student/online-class/join",{method:"POST",body:JSON.stringify({scheduleEntryId,date:localDateV74()})}));if(!result?.meetingUrl)throw new Error("لینک کلاس آنلاین دریافت نشد.");if(popup)popup.location.href=result.meetingUrl;else window.open(result.meetingUrl,"_blank","noopener");await withNetwork("online-dashboard-refresh",()=>syncDashboard(true));toast("ورود شما به کلاس ثبت شد. حضور رسمی توسط معلم ثبت می‌شود.","ok");}catch(e){try{popup?.close();}catch{}toast(e.message||"ورود به کلاس انجام نشد.","danger");}finally{if(button){button.disabled=false;button.textContent="ورود به کلاس";}}}
  function bindOnlineJoinV74(){document.querySelectorAll("[data-online-join-v74]").forEach(b=>b.onclick=()=>joinOnlineClassV74(b.dataset.onlineJoinV74));document.querySelectorAll("[data-online-refresh-v74]").forEach(b=>b.onclick=refreshOnlineSchoolV74);}

  function p46Icon(name){
    const paths={
      "book-open":"<path d='M12 7v14m0-14C9 5 5 5 2 6v14c3-1 7-1 10 1m0-14c3-2 7-2 10-1v14c-3-1-7-1-10 1'/>",
      "clipboard-check":"<rect x='5' y='4' width='14' height='18' rx='2'/><path d='M9 4.5h6M9 13l2 2 4-4'/>",
      "file-pen":"<path d='M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM13 2v7h7M8 17l5-5 2 2-5 5-3 1z'/>",
      "chart":"<rect x='4' y='12' width='3' height='8' rx='1'/><rect x='10.5' y='8' width='3' height='12' rx='1'/><rect x='17' y='4' width='3' height='16' rx='1'/>",
      "folder":"<path d='M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3z'/>",
      "mail":"<rect x='2' y='5' width='20' height='14' rx='3'/><path d='m3 7 9 7 9-7'/>"
    };return `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.folder}</svg>`;
  }
  // p48 — نمای یکپارچه «امروز من»؛ صرفاً داده‌های موجود داشبورد، بدون تغییر API.
  function p48TodayPanel(active){
    const tasks=(dashboard?.homework||[]).filter(t=>!t.submission);
    const timeValue=v=>{if(!v)return null;const s=String(v).trim();const d=new Date(s);return Number.isFinite(d.getTime())?d.getTime():null;};
    const now=Date.now(), day=86400000;
    const sorted=tasks.slice().sort((a,b)=>(timeValue(a.dueAt)??Infinity)-(timeValue(b.dueAt)??Infinity));
    const upcoming=sorted.slice(0,3);
    const near=tasks.filter(t=>{const v=timeValue(t.dueAt);return v!==null&&v>=now&&v<=now+2*day;}).length;
    const overdue=tasks.filter(t=>{const v=timeValue(t.dueAt);return v!==null&&v<now;}).length;
    const lessons=todayScheduleEntriesV79();
    const notes=(dashboard?.notifications||[]).filter(n=>!n.read).length;
    const dueLabel=v=>{const n=timeValue(v);if(n===null)return v?String(v):"مهلت مشخص نشده";const diff=n-now;if(diff<0)return "مهلت گذشته";if(diff<day)return "کمتر از ۲۴ ساعت";if(diff<2*day)return "تا دو روز آینده";return dateFa(v);};
    const item=(title,sub,go,kind)=>`<button type="button" class="p48-today-item" data-go="${go}"><span class="p48-today-dot p48-${kind}"></span><span class="p48-today-item-body"><strong>${esc(title)}</strong><small>${esc(sub)}</small></span><span class="p48-today-chevron" aria-hidden="true">‹</span></button>`;
    return `<section class="p48-today" aria-label="کارهای امروز من"><div class="p48-today-head"><div><span class="p48-eyebrow">برنامه‌ریز شخصی</span><h3>امروز من <span aria-hidden="true">✦</span></h3><p>کارهای مهمت را یک‌جا ببین و از همین‌جا شروع کن.</p></div><span class="p48-today-date">${esc(new Intl.DateTimeFormat("fa-IR-u-ca-persian",{weekday:"long",month:"long",day:"numeric"}).format(new Date()))}</span></div>
      <div class="p48-today-stats">
        <button data-go="tasks" class="p48-today-stat"><span>تکالیف باقی‌مانده</span><b>${fa(tasks.length)}</b></button>
        <button data-go="exams" class="p48-today-stat"><span>آزمون‌های فعال</span><b>${fa(active.length)}</b></button>
        <button data-go="schedule" class="p48-today-stat"><span>کلاس‌های امروز</span><b>${fa(lessons.length)}</b></button>
        <button data-go="more" class="p48-today-stat"><span>اعلان‌های خوانده‌نشده</span><b>${fa(notes)}</b></button>
      </div>
      <div class="p48-today-content"><div class="p48-today-tasks"><div class="p48-today-subhead"><b>اولویت‌های من</b><button data-go="tasks">همه تکالیف ←</button></div>
      ${overdue?`<p class="p48-today-alert">${fa(overdue)} تکلیف با مهلت گذشته داری.</p>`:near?`<p class="p48-today-alert mild">${fa(near)} تکلیف تا دو روز آینده مهلت دارد.</p>`:""}
      ${upcoming.length?upcoming.map(t=>item(t.title||"تکلیف",`${t.subject||"درس"} · ${dueLabel(t.dueAt)}`,"tasks","task")).join(""):item("تکلیف انجام‌نشده‌ای نداری","برای دیدن تکالیف ثبت‌شده وارد این بخش شو.","tasks","done")}
      </div><div class="p48-today-lessons"><div class="p48-today-subhead"><b>کلاس‌های امروز</b><button data-go="schedule">برنامه هفته ←</button></div>
      ${lessons.length?lessons.slice(0,4).map(e=>item(e.subject||"درس",`${e.startTime||""}${e.endTime?" تا "+e.endTime:""}${e.teacherName?" · "+e.teacherName:""}`,"schedule","lesson")).join(""):item("کلاسی برای امروز ثبت نشده","برنامه هفتگی را بررسی کن.","schedule","done")}
      </div></div></section>`;
  }
  async function renderHome() {
    const s = dashboard?.student || {}; const exams = dashboard?.exams || []; const queue = await storeAll(QUEUE_STORE); const queuedIds=new Set(queue.map(x=>x.examId)); const cacheRows=await storeAll(CACHE_STORE); const localSubmitted=new Set(cacheRows.filter(x=>String(x.id||"").startsWith("exam_state_")&&x.data?.status==="submitted").map(x=>String(x.id).slice(11))); const active = exams.filter(e => e.studentStatus === "available" && !queuedIds.has(e.id) && !localSubmitted.has(e.id)); const report = dashboard?.report || [];
    const average = report.length ? Math.round(report.reduce((a,b) => a + b.percent, 0) / report.length) : 0;
    $("page").innerHTML = `
      <div class="offline-policy-note">برنامه در حالت محلی است؛ فقط عملیات لازم به سرور متصل می‌شوند.</div>
      ${queue.length ? `<div class="sync-banner">${fa(queue.length)} پاسخ در گوشی ذخیره شده و پس از اتصال ارسال می‌شود.</div>` : ""}
      <section class="hero"><div class="student-hero-photo-p25" id="studentHeroPhotoP25">${esc((s.firstName||"د").slice(0,1))}</div><h2>سلام ${esc(s.firstName || "دانش‌آموز")} 👋</h2><p>${esc(s.schoolName || "مدرسه")} · ${esc(s.gradeName ? `${s.gradeName}${s.grade===7?" (هفتم)":s.grade===8?" (هشتم)":s.grade===9?" (نهم)":""}` : "دوره اول متوسطه")} · ${esc(s.className || "کلاس")}</p><div class="hero-meta"><span>سال ${esc(s.academicYear || "")}</span><span>کد دانش‌آموزی ${esc(s.studentCode || "—")}</span><span>${dashboard?.onlineLearning?.enabled?`مدرسه ${esc(modeLabelV74(dashboard.onlineLearning.operationMode))}`:"حالت محلی"}</span></div></section>
      ${p48TodayPanel(active)}
      <section class="p46-shortcuts" aria-label="دسترسی سریع دانش‌آموز">
        ${[
          ["schedule","برنامه درسی","برنامه هفتگی","book-open","pink"],
          ["tasks","تکالیف من",`${fa((dashboard?.homework||[]).filter(t=>!t.submission).length)} تکلیف باقی‌مانده`,"clipboard-check","lilac"],
          ["exams","آزمون‌ها",`${fa(active.length)} آزمون فعال`,"file-pen","violet"],
          ["results","کارنامه","مشاهده نمرات","chart","mint"],
          ["resources","منابع آموزشی","جزوه‌ها و منابع","folder","peach"],
          ["more","امکانات بیشتر","پیام‌ها و پروفایل","mail","blue"]
        ].map(([go,title,sub,ico,tone])=>`<button type="button" class="p46-shortcut p46-${tone}" data-go="${go}"><span class="p46-shortcut-icon">${p46Icon(ico)}</span><b>${title}</b><small>${sub}</small><span class="p46-arrow">‹</span></button>`).join("")}
      </section>
      ${todayScheduleCardV79()}
      ${onlineTodayCardV74()}
      ${academicCalendarCardV76()}
      <button class="p57-home-launch" id="p57HomeLaunch" type="button">🗓 مشاهده تقویم آموزشی شمسی <span>←</span></button>
      <div class="grid">
        <article class="card stat-card"><div class="stat-icon">✎</div><b>${fa(active.length)}</b><small>آزمون فعال</small></article>
        <article class="card stat-card"><div class="stat-icon">★</div><b>${fa(average)}٪</b><small>میانگین عملکرد</small></article>
        <article class="card stat-card"><div class="stat-icon">✓</div><b>${fa((dashboard?.homework || []).filter(t=>!t.submission).length)}</b><small>تکلیف انجام‌نشده</small></article>
        <article class="card stat-card"><div class="stat-icon">⏳</div><b>${fa(pendingGradeCount())}</b><small>در انتظار نمره</small></article>
      </div>
      <div class="section-title"><h3>آزمون‌های فعال</h3><button data-go="exams">مشاهده همه</button></div>
      <div class="list">${active.length ? active.slice(0,3).map(exam => examMini(exam)).join("") : '<div class="card empty">🎉<b>آزمون فعالی نداری</b><small>اعلان آزمون‌های جدید اینجا نمایش داده می‌شود.</small></div>'}</div>
      <div class="section-title"><h3>اعلان‌های تازه</h3><button id="homeNotifBtn">همه اعلان‌ها</button></div>
      <div class="list">${[...(dashboard?.announcements||[]).map(a=>({...a,at:a.createdAt,schoolAnnouncement:true})),...(dashboard?.notifications||[])].slice(0,4).map(n => `<div class="list-item ${n.priority==="urgent"?"urgent-announcement":""}"><div class="list-icon">${n.priority==="urgent"?"🚨":"🔔"}</div><div class="list-main"><b>${esc(n.title)}</b><small>${esc(n.body)} · ${esc(n.at || "")}</small></div>${n.schoolAnnouncement?`<span class="chip ${n.priority==="urgent"?"danger":n.priority==="important"?"warn":"ok"}">${n.priority==="urgent"?"فوری":n.priority==="important"?"مهم":"مدرسه"}</span>`:n.read?"":'<span class="chip danger">جدید</span>'}</div>`).join("") || '<div class="card empty">اعلان جدیدی وجود ندارد.</div>'}</div>`;
    refreshSchoolPhotoP25(); bindExamMini(); bindOnlineJoinV74(); document.querySelectorAll("[data-go]").forEach(b => b.onclick = () => navigate(b.dataset.go)); $("homeNotifBtn").onclick = showNotifications; $("p57HomeLaunch").onclick=showCalendarP57;
  }
  function examTypeLabelV54(type){return ({mcq:"تستی",descriptive:"تشریحی",mixed:"ترکیبی"})[type]||String(type||"آزمون");}
  function examMini(exam) { return `<div class="list-item" data-exam-mini="${esc(exam.id)}"><div class="list-icon">${subjectIcon(exam.subject)}</div><div class="list-main"><b>${esc(exam.title)}</b><small>${esc(exam.subject)} · ${fa(exam.duration)} دقیقه · ${esc(examTypeLabelV54(exam.type))}</small></div><span class="chip warn">دریافت</span></div>`; }
  function bindExamMini() { document.querySelectorAll("[data-exam-mini]").forEach(el => el.onclick = () => downloadOrOpenExam(el.dataset.examMini)); }

  async function renderExams() {
    // v61.03: the real student exam renderer. Only this student-folder file is changed.
    const cached = await storeAll(EXAM_STORE);
    const cachedIds = new Set(cached.map(e => e.id));
    const queue = await storeAll(QUEUE_STORE);
    const queuedIds = new Set(queue.map(q => q.examId));
    const cacheRows = await storeAll(CACHE_STORE);
    const stateMap = new Map(
      cacheRows
        .filter(x => String(x.id || "").startsWith("exam_state_"))
        .map(x => [String(x.id).slice(11), x.data])
    );

    const all = Array.isArray(dashboard?.exams) ? dashboard.exams.slice() : [];

    // Newest first. Prefer the actual scheduled/start time, then fall back to createdAt.
    const examTimeV61 = (e) => {
      const values = [
        e?.scheduledAt, e?.startAt, e?.examDateTime, e?.examDate,
        e?.dateTime, e?.date, e?.createdAt, e?.created_at
      ];
      for (const value of values) {
        if (value === undefined || value === null || value === "") continue;
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return d.getTime();
        const n = Number(value);
        if (Number.isFinite(n)) return n;
      }
      return 0;
    };

    const isExecutedV61 = (e) => {
      const status = String(e?.studentStatus || e?.status || e?.state || "").toLowerCase();
      if (
        e?.studentStatus === "submitted" ||
        e?.submitted === true ||
        e?.completed === true ||
        e?.finished === true ||
        e?.isCompleted === true ||
        ["submitted","completed","finished","done","closed","executed","اجرا شده","پایان یافته"].includes(status)
      ) return true;

      const local = stateMap.get(e?.id);
      if (local?.status === "submitted" || local?.submitted === true || local?.completed === true) return true;

      return false;
    };

    const sorted = all.sort((a,b) => examTimeV61(b) - examTimeV61(a));
    const running = sorted.filter(e => !isExecutedV61(e));
    const executed = sorted.filter(isExecutedV61);

    // The legacy book-and-exam landing page is intentionally removed.
    if (!selectedExamSubject) {
      $("page").innerHTML = `
        <div class="offline-policy-note">
          آزمون‌های دانلودشده بدون اینترنت قابل اجرا هستند. آزمون تحویل‌شده قفل می‌شود.
        </div>

        <div class="section-title">
          <div>
            <h3>📝 آزمون‌ها</h3>
            <small class="muted">آزمون‌ها بر اساس تاریخ و ساعت، جدیدترین به قدیمی‌ترین نمایش داده می‌شوند.</small>
          </div>
          <div class="queue-actions-v456">
            <button id="syncExamsBtn">دریافت آزمون جدید</button>
            <button id="sendPendingExamsV456">ارسال پاسخ‌های در انتظار</button>
          </div>
        </div>

        <div class="student-exam-home-v61" dir="rtl">
          <button type="button" class="student-exam-card-v61" id="studentRunningExamsBtn">
            <span class="big-icon">📝</span>
            <b>آزمون‌های در حال اجرا</b>
            <small>${fa(running.length)} آزمون</small>
          </button>

          <button type="button" class="student-exam-card-v61" id="studentExecutedExamsBtn">
            <span class="big-icon">📊</span>
            <b>آزمون‌های اجرا شده</b>
            <small>${fa(executed.length)} آزمون</small>
          </button>
        </div>

        <div id="studentExamSectionV61" style="margin-top:18px"></div>
      `;

      const host = $("studentExamSectionV61");

      const renderSection = (type) => {
        const rows = type === "executed" ? executed : running;
        host.innerHTML = `
          <div class="section-title">
            <div>
              <h3>${type === "executed" ? "📊 آزمون‌های اجرا شده" : "📝 آزمون‌های در حال اجرا"}</h3>
              <small class="muted">${fa(rows.length)} آزمون · جدیدترین ابتدا</small>
            </div>
          </div>
          ${
            rows.length
              ? `<div class="student-exam-list-v61">${rows.map(e =>
                  examCard(e, cachedIds.has(e.id), queuedIds.has(e.id), stateMap.get(e.id))
                ).join("")}</div>`
              : `<div class="card empty">در این بخش آزمونی وجود ندارد.</div>`
          }
        `;

        document.querySelectorAll("[data-download-exam]").forEach(
          b => b.onclick = () => downloadOrOpenExam(b.dataset.downloadExam)
        );
        document.querySelectorAll("[data-delete-exam]").forEach(
          b => b.onclick = async () => {
            if (confirm("نسخه دانلودشده و پاسخ نیمه‌کاره حذف شود؟")) {
              await storeDelete(EXAM_STORE, b.dataset.deleteExam);
              await storeDelete(DRAFT_STORE, b.dataset.deleteExam);
              await renderExams();
            }
          }
        );
        document.querySelectorAll("[data-retry-exam]").forEach(
          b => b.onclick = () => retryExamSubmission(b.dataset.retryExam)
        );
        document.querySelectorAll("[data-view-receipt]").forEach(
          b => b.onclick = () => showSavedExamReceipt(b.dataset.viewReceipt)
        );
      };

      $("studentRunningExamsBtn").onclick = () => renderSection("running");
      $("studentExecutedExamsBtn").onclick = () => renderSection("executed");

      // Default view is the active/running exams section.
      renderSection("running");
    } else {
      // Keep the existing subject/chapter drill-down functionality intact.
      const rows = sorted.filter(e => e.subject === selectedExamSubject);
      const chapters = groupByChapter(rows);
      const group = {
        subject: selectedExamSubject,
        bookTitle: rows[0]?.bookTitle || selectedExamSubject,
        rows
      };

      $("page").innerHTML = `
        <div class="book-toolbar">
          <button class="back-book" id="backToBooks">→ آزمون‌ها</button>
          <div>
            <h3>${subjectIcon(group.subject)} ${esc(group.bookTitle)}</h3>
            <small>${fa(rows.length)} آزمون</small>
          </div>
        </div>
        ${chapters.map(([chapter, rs]) => `
          <section class="chapter-section">
            <div class="chapter-heading">
              <div><span>فصل</span><b>${esc(chapter)}</b></div>
              <small>${fa(rs.length)} آزمون</small>
            </div>
            ${rs.map(e => examCard(e, cachedIds.has(e.id), queuedIds.has(e.id), stateMap.get(e.id))).join("")}
          </section>
        `).join("")}
      `;

      $("backToBooks").onclick = () => {
        selectedExamSubject = "";
        renderExams();
      };

      document.querySelectorAll("[data-download-exam]").forEach(
        b => b.onclick = () => downloadOrOpenExam(b.dataset.downloadExam)
      );
      document.querySelectorAll("[data-delete-exam]").forEach(
        b => b.onclick = async () => {
          if (confirm("نسخه دانلودشده و پاسخ نیمه‌کاره حذف شود؟")) {
            await storeDelete(EXAM_STORE, b.dataset.deleteExam);
            await storeDelete(DRAFT_STORE, b.dataset.deleteExam);
            renderExams();
          }
        }
      );
      document.querySelectorAll("[data-retry-exam]").forEach(
        b => b.onclick = () => retryExamSubmission(b.dataset.retryExam)
      );
      document.querySelectorAll("[data-view-receipt]").forEach(
        b => b.onclick = () => showSavedExamReceipt(b.dataset.viewReceipt)
      );
    }

    if ($("syncExamsBtn")) {
      $("syncExamsBtn").onclick = async () => {
        await syncExamCenterV456();
        await renderExams();
      };
    }
    if ($("sendPendingExamsV456")) {
      $("sendPendingExamsV456").onclick = sendAllPendingExamAnswersV456;
    }
  }
  function examCard(exam, downloaded, queued, localState = null) {
    const serverSubmitted = exam.studentStatus === "submitted";
    const submitted = serverSubmitted || localState?.status === "submitted";
    const pending = queued && !submitted;
    const submittedAt = localState?.submittedAt || exam.submissionInfo?.submittedAt || 0;
    const fairness=exam.fairnessAdjustment&&Number(exam.fairnessAdjustment.expiresAt||0)>Date.now()?exam.fairnessAdjustment:null;
    const meta = submitted ? `تحویل نهایی${submittedAt ? ` · ${esc(dateFa(submittedAt))}` : ""}` : pending ? "پاسخ‌ها روی گوشی محفوظ‌اند و هنوز به مدرسه تحویل نشده‌اند" : fairness ? `فرصت جبرانی محدود تا ${esc(dateFa(fairness.expiresAt))}` : downloaded ? "نسخه آزمون روی گوشی آماده اجراست" : "برای شروع، سؤال‌ها را دریافت کن";
    return `<article class="exam-card ${downloaded ? "downloaded" : ""}"><div class="exam-head"><div class="exam-subject">${subjectIcon(exam.subject)}</div><div class="exam-title"><b>${esc(exam.title)}</b><small>${esc(exam.subject)} · ${esc(exam.chapter || "")}${exam.formCode ? ` · فرم ${esc(exam.formCode)}` : ""} · ${fa(exam.duration)} دقیقه<br>${meta}</small>${fairness?`<span class="chip ok">فرصت جبرانی ${fa(fairness.minutes||0)} دقیقه‌ای</span>`:""}</div><span class="chip ${submitted ? "ok" : pending ? "warn" : downloaded ? "ok" : "warn"}">${submitted ? "ارسال‌شده ✓" : pending ? "در انتظار ارسال" : downloaded ? "دانلودشده" : "آماده دانلود"}</span></div><div class="exam-actions">${submitted ? `<button class="btn secondary" data-view-receipt="${esc(exam.id)}">مشاهده رسید تحویل</button>` : pending ? `<button class="btn primary" data-retry-exam="${esc(exam.id)}">ارسال مجدد</button><button class="btn secondary" disabled>اجرای دوباره آزمون غیرفعال است</button>` : `<button class="btn primary" data-download-exam="${esc(exam.id)}">${downloaded ? "باز کردن آزمون" : "دانلود سؤال‌ها"}</button>`}${downloaded && !submitted && !pending ? `<button class="btn danger small" data-delete-exam="${esc(exam.id)}">حذف</button>` : ""}</div></article>`;
  }


  // v60 — Student exam package integrity guard. Keeps malformed/unsupported packages from crashing the exam runtime.
  const STUDENT_SUPPORTED_QUESTION_TYPES_V60=new Set(["mcq","true_false","descriptive","short_answer","fill_blank"]);
  function validateExamPackageV60(exam){
    const problems=[];
    if(!exam||typeof exam!=="object")return ["بسته آزمون نامعتبر است."];
    // v61 parity: published packages must retain the basic identity shown to the student.
    if(!String(exam.title||"").trim())problems.push("عنوان آزمون مشخص نیست.");
    if(!Array.isArray(exam.questions)||!exam.questions.length)problems.push("این آزمون سؤال قابل اجرا ندارد.");
    if(!(Number(exam.duration)>0))problems.push("زمان آزمون معتبر نیست.");
    const ids=new Set();
    (exam.questions||[]).forEach((q,index)=>{
      const n=index+1,type=String(q?.type||(exam.type==="mcq"?"mcq":"descriptive"));
      if(!q?.id)problems.push(`سؤال ${n} شناسه ندارد.`);else if(ids.has(q.id))problems.push(`شناسه سؤال ${n} تکراری است.`);else ids.add(q.id);
      if(!String(q?.text||"").trim())problems.push(`متن سؤال ${n} خالی است.`);
      if(!(Number(q?.score)>0))problems.push(`نمره سؤال ${n} معتبر نیست.`);
      if(!STUDENT_SUPPORTED_QUESTION_TYPES_V60.has(type))problems.push(`نوع سؤال ${n} در این نسخه پشتیبانی نمی‌شود.`);
      if(type==="mcq"&&(!Array.isArray(q.choices)||q.choices.length<2))problems.push(`گزینه‌های سؤال ${n} ناقص است.`);
    });
    return problems;
  }
  function showExamPackageProblemV60(exam,problems){
    openModal(`<div class="receipt"><div class="receipt-icon">⚠</div><h3>این آزمون فعلاً قابل اجرا نیست</h3><p class="muted">ساختار بسته آزمون نیاز به اصلاح توسط مدرسه دارد. پاسخ‌دهی شروع نشده و هیچ تلاشی مصرف نشده است.</p><div class="card mt"><b>${esc(exam?.title||"آزمون")}</b><ul style="text-align:right">${problems.slice(0,8).map(x=>`<li>${esc(x)}</li>`).join("")}</ul></div><button class="btn secondary mt" data-close>بستن</button></div>`);
  }

  async function downloadOrOpenExam(examId) {
    const queue=(await storeAll(QUEUE_STORE)).filter(item=>item.examId===examId);
    const localState=await getLocalExamState(examId);
    const serverExam=findExam(examId);
    if (serverExam?.studentStatus === "submitted" || localState?.status === "submitted") { await showSavedExamReceipt(examId); return; }
    if (queue.length) {
      openModal(`<div class="receipt"><div class="receipt-icon">⏳</div><h3>آزمون در انتظار ارسال است</h3><p class="muted">پاسخ‌ها روی گوشی محفوظ‌اند. آزمون برای جلوگیری از ارسال چندباره قفل شده است.</p><button class="btn primary mt" id="retrySingleExam">ارسال مجدد</button><button class="btn secondary mt" data-close>بستن</button></div>`);
      $("retrySingleExam").onclick=async()=>{closeModal();await retryExamSubmission(examId);};
      return;
    }
    let record = await storeGet(EXAM_STORE, examId);
    if (!record) {
      setSync("اتصال برای دانلود سؤال‌ها…");
      try { await withNetwork("exam-download",async()=>{ const data = await api(`/api/student/exams/${encodeURIComponent(examId)}/download`); data.exam.packageVersion = data.packageVersion; data.exam.attemptId=data.attemptId; data.exam.packageSignature=data.packageSignature; record = { id: examId, exam: data.exam, packageVersion: data.packageVersion, attemptId:data.attemptId, packageSignature:data.packageSignature, downloadedAt: data.downloadedAt }; await storePut(EXAM_STORE, record); }); toast("سؤال‌های آزمون روی گوشی ذخیره شد؛ ادامه آزمون بدون اینترنت انجام می‌شود.", "ok"); }
      catch (e) { if(e.status===409){await markExamSubmittedLocal(examId,{submittedAt:Date.now(),serverConfirmed:true,receiptId:"ثبت‌شده در سرور"});toast("این آزمون قبلاً تحویل داده شده و دیگر قابل اجرا نیست.","ok");await renderExams();}else toast("دانلود سؤال‌ها انجام نشد؛ اینترنت را بررسی کنید.", "danger"); setSync("حالت محلی"); return; }
      finally { setSync("حالت محلی"); }
    }
    const v60Problems=validateExamPackageV60(record.exam);
    if(v60Problems.length){showExamPackageProblemV60(record.exam,v60Problems);return;}
    openExamIntro(record.exam);
  }

  async function openExamIntro(exam) {
    const v60Problems=validateExamPackageV60(exam);
    if(v60Problems.length){showExamPackageProblemV60(exam,v60Problems);return;}
    const draft = await storeGet(DRAFT_STORE, exam.id);
    const answered = draft?.answers ? Object.keys(draft.answers).length : 0;
    openModal(`<div class="modal-head"><div><h3>${esc(exam.title)}</h3><small class="muted">${esc(exam.subject)}${exam.formCode ? ` · فرم ${esc(exam.formCode)}` : ""} · ${fa(exam.totalScore)} نمره</small></div><button class="close-btn" data-close>×</button></div><div class="card"><div class="list"><div class="row between"><span>نوع آزمون</span><b>${esc(examTypeLabelV54(exam.type))}</b></div><div class="row between"><span>تعداد سؤال</span><b>${fa(exam.questions.length)}</b></div><div class="row between"><span>زمان</span><b>${fa(exam.duration)} دقیقه</b></div>${(exam.sheetCode||exam.examCode) ? `<div class="row between"><span>کد اختصاصی برگه</span><b dir="ltr">${esc(exam.sheetCode||exam.examCode)}</b></div>` : ""}</div></div>${draft ? `<div class="sync-banner mt">یک آزمون نیمه‌کاره روی گوشی ذخیره شده است (${fa(answered)} پاسخ).</div>` : '<div class="offline-banner mt">بعد از شروع، پاسخ‌ها خودکار روی گوشی ذخیره می‌شوند. در زمان آزمون پنجره برنامه را نبند.</div>'}<button id="startExamBtn" class="btn primary mt">${draft ? "ادامه آزمون" : "شروع آزمون"}</button>`);
    $("startExamBtn").onclick = async () => { closeModal(); await startExam(exam, draft); };
  }

  async function startExam(exam, savedDraft = null) {
    const now = Date.now();
    const draft = savedDraft || { id: exam.id, examId: exam.id, answers: {}, flagged: {}, currentIndex: 0, startedAt: now, expiresAt: now + Math.max(1, exam.duration) * 60000, files: [], updatedAt: now };
    examSession = { exam, draft }; await storePut(DRAFT_STORE, draft); clearInterval(examTimer); renderExamScreen();
    examTimer = setInterval(async () => { if (!examSession) return; updateTimer(); if (Date.now() >= examSession.draft.expiresAt) { clearInterval(examTimer); await finalSubmitExam(true); } }, 1000);
  }
  function v54QuestionAnswered(q,answers){
    if(!answers||!Object.prototype.hasOwnProperty.call(answers,q.id))return false;
    const v=answers[q.id];return typeof v==="number"?true:String(v??"").trim().length>0;
  }
  function renderExamScreen() {
    const { exam, draft } = examSession; const index = Math.max(0, Math.min(exam.questions.length - 1, draft.currentIndex || 0)); draft.currentIndex = index; const q = exam.questions[index];
    $("bottomNav").classList.add("hidden"); $("pageTitle").textContent = exam.title; $("page").className = "page question-screen";
    const answered = exam.questions.filter(x=>v54QuestionAnswered(x,draft.answers||{})).length;
    const navAnswered=i=>v54QuestionAnswered(exam.questions[i],draft.answers||{});
    const body=exam.type === "mcq" ? renderMcqQuestion(q,index) : exam.type === "mixed" ? renderMixedQuestionV54(q,index) : renderDescriptiveExam(exam,draft);
    $("page").innerHTML = `<div class="exam-toolbar"><div class="exam-info"><div><b>سؤال ${fa(index+1)} از ${fa(exam.questions.length)}</b><small class="muted"> · ذخیره خودکار فعال</small></div><div id="examTimer" class="timer">--:--</div></div><div class="progress-ring mt"><i style="width:${Math.round((index+1)/exam.questions.length*100)}%"></i></div><div class="question-nav mt">${exam.questions.map((_,i)=>`<button data-qnav="${i}" class="${i===index?"current":""} ${navAnswered(i)?"answered":""}">${fa(i+1)}</button>`).join("")}</div></div>${body}<div class="fixed-submit"><button id="finishExamBtn" class="btn primary full">ارسال نهایی آزمون · ${fa(answered)} پاسخ ثبت‌شده</button></div>`;
    document.querySelectorAll("[data-qnav]").forEach(b => b.onclick = () => { draft.currentIndex = Number(b.dataset.qnav); saveDraftAndRender(); });
    if (exam.type === "mcq") bindMcq(q,index); else if(exam.type === "mixed") bindMixedQuestionV54(q,index); else bindDescriptive(exam,draft);
    $("finishExamBtn").onclick = () => finalSubmitExam(false); updateTimer();
  }
  function renderMixedQuestionV54(q,index){
    const value=examSession.draft.answers?.[q.id];const type=q.type||"descriptive";let control="";
    if(type==="mcq"||type==="true_false"){
      const choices=Array.isArray(q.choices)&&q.choices.length?q.choices:(type==="true_false"?["صحیح","غلط"]:[]);
      control=choices.map((choice,i)=>`<label class="option ${Number(value)===i?"selected":""}"><input type="radio" name="mixedAnswer" value="${i}" ${Number(value)===i?"checked":""}><span>${esc(choice)}</span></label>`).join("");
    }else if(type==="short_answer"||type==="fill_blank"){
      control=`<label class="field"><span>${type==="fill_blank"?"پاسخ جای‌خالی":"پاسخ کوتاه"}</span><input id="mixedTextAnswerV54" value="${esc(value||"")}" autocomplete="off" placeholder="پاسخ را بنویس…"></label>`;
    }else{
      control=`<label class="field"><span>پاسخ تشریحی</span><textarea id="mixedTextAnswerV54" rows="7" placeholder="پاسخ خود را کامل بنویس…">${esc(value||"")}</textarea></label>`;
    }
    return `<article class="question-card v54-mixed-question"><div class="row between"><h3>${fa(index+1)}. ${esc(q.text)}</h3><span class="chip">${fa(q.score)} نمره</span></div><small class="muted">${esc(({mcq:"چهارگزینه‌ای",true_false:"صحیح/غلط",short_answer:"پاسخ کوتاه",fill_blank:"جای‌خالی",descriptive:"تشریحی"})[type]||type)}</small><div class="mt">${control}</div><div class="question-footer"><button class="btn secondary" id="prevQ" ${index===0?"disabled":""}>قبلی</button><button class="btn secondary" id="flagQ">${examSession.draft.flagged?.[q.id]?"حذف علامت":"علامت‌گذاری"}</button><button class="btn secondary" id="nextQ" ${index===examSession.exam.questions.length-1?"disabled":""}>بعدی</button></div></article>`;
  }
  function bindMixedQuestionV54(q,index){
    const draft=examSession.draft;document.querySelectorAll('input[name="mixedAnswer"]').forEach(input=>input.onchange=()=>{draft.answers[q.id]=Number(input.value);saveDraftAndRender();});
    const text=$("mixedTextAnswerV54");if(text){let timer=null;text.oninput=()=>{draft.answers[q.id]=text.value;draft.updatedAt=Date.now();clearTimeout(timer);timer=setTimeout(()=>storePut(DRAFT_STORE,draft),180);};}
    $("prevQ").onclick=()=>{draft.currentIndex=index-1;saveDraftAndRender();};$("nextQ").onclick=()=>{draft.currentIndex=index+1;saveDraftAndRender();};$("flagQ").onclick=()=>{draft.flagged||={};draft.flagged[q.id]=!draft.flagged[q.id];saveDraftAndRender();};
  }
  function renderMcqQuestion(q,index) { const selected = examSession.draft.answers?.[q.id]; return `<article class="question-card"><h3>${fa(index+1)}. ${esc(q.text)}</h3>${q.choices.map((choice,i)=>`<label class="option ${Number(selected)===i?"selected":""}"><input type="radio" name="answer" value="${i}" ${Number(selected)===i?"checked":""}><span>${esc(choice)}</span></label>`).join("")}<div class="question-footer"><button class="btn secondary" id="prevQ" ${index===0?"disabled":""}>قبلی</button><button class="btn secondary" id="flagQ">${examSession.draft.flagged?.[q.id]?"حذف علامت":"علامت‌گذاری"}</button><button class="btn secondary" id="nextQ" ${index===examSession.exam.questions.length-1?"disabled":""}>بعدی</button></div></article>`; }
  function bindMcq(q,index) {
    document.querySelectorAll('input[name="answer"]').forEach(input => input.onchange = () => { examSession.draft.answers[q.id] = Number(input.value); saveDraftAndRender(); });
    $("prevQ").onclick = () => { examSession.draft.currentIndex = index-1; saveDraftAndRender(); }; $("nextQ").onclick = () => { examSession.draft.currentIndex = index+1; saveDraftAndRender(); };
    $("flagQ").onclick = () => { examSession.draft.flagged ||= {}; examSession.draft.flagged[q.id] = !examSession.draft.flagged[q.id]; saveDraftAndRender(); };
  }
  function renderDescriptiveExam(exam,draft) {
    draft.answers ||= {};
    return `<article class="question-card"><div class="offline-banner"><b>دو روش پاسخ‌گویی:</b> پاسخ را مستقیماً تایپ کن، یا روی کاغذ بنویس و عکس صفحات را بفرست. استفاده هم‌زمان از هر دو روش نیز مجاز است.</div><h3 class="mt">سؤال‌های تشریحی</h3>${exam.questions.map(q=>`<div class="descriptive-answer-card"><div class="row between"><b>${fa(q.number)}. ${esc(q.text)}</b><span class="chip">${fa(q.score)} نمره</span></div><textarea class="student-written-answer" data-answer-q="${esc(q.id)}" rows="5" placeholder="پاسخ خود را با توضیح کامل بنویس…">${esc(draft.answers?.[q.id]||"")}</textarea><small class="muted">پاسخ با عبارت‌های خودت پذیرفته می‌شود؛ لازم نیست متن کتاب را عیناً تکرار کنی.</small></div>`).join("")} ${(exam.sheetCode||exam.examCode) ? `<div class="offline-banner mt"><b>کد اختصاصی این دانش‌آموز:</b> <span dir="ltr"><b>${esc(exam.sheetCode||exam.examCode)}</b></span><br>این کد هنگام افزودن عکس به‌صورت خودکار روی بالای هر صفحه ثبت می‌شود. بهتر است همین کد را روی برگه کاغذی نیز بنویسی.</div>` : ""}<div class="upload-zone mt"><input id="answerPhotos" type="file" accept="image/*" capture="environment" multiple><label for="answerPhotos">📷 افزودن عکس صفحات پاسخ (اختیاری)<br><small class="muted">حداکثر ۱۲ صفحه؛ تصویر واضح، کامل و بدون سایه باشد</small></label></div><div id="photoGrid" class="photo-grid">${(draft.files||[]).map((f,i)=>`<div class="photo"><img src="${f.dataUrl}" alt="صفحه ${i+1}"><button data-remove-photo="${i}">×</button></div>`).join("")}</div></article>`;
  }
  function bindDescriptive(exam,draft) {
    let saveTimer=null;document.querySelectorAll("[data-answer-q]").forEach(area=>area.oninput=()=>{draft.answers||={};draft.answers[area.dataset.answerQ]=area.value;draft.updatedAt=Date.now();clearTimeout(saveTimer);saveTimer=setTimeout(()=>storePut(DRAFT_STORE,draft),250);});
    $("answerPhotos").onchange = async e => { const list = [...e.target.files].slice(0, 12-(draft.files||[]).length); for (const file of list) { try { const pageNumber=(draft.files||[]).length+1; const dataUrl = await compressImage(file, exam.sheetCode||exam.examCode||"", pageNumber); draft.files ||= []; draft.files.push({ name:`${exam.sheetCode||exam.examCode||"sheet"}-page-${pageNumber}.jpg`, type:"image/jpeg", size:Math.round(dataUrl.length*.75), dataUrl, sheetCode:exam.sheetCode||exam.examCode||"", pageNumber }); } catch { toast("خواندن یکی از تصاویر ناموفق بود.","danger"); } } await storePut(DRAFT_STORE,draft); renderExamScreen(); };
    document.querySelectorAll("[data-remove-photo]").forEach(b => b.onclick = async () => { draft.files.splice(Number(b.dataset.removePhoto),1); await storePut(DRAFT_STORE,draft); renderExamScreen(); });
  }
  function compressImage(file,sheetCode="",pageNumber=1) { return new Promise((resolve,reject) => { const reader = new FileReader(); reader.onerror=reject; reader.onload=() => { const img=new Image(); img.onerror=reject; img.onload=() => { const max=1800,scale=Math.min(1,max/Math.max(img.width,img.height)); const width=Math.max(1,Math.round(img.width*scale)),height=Math.max(1,Math.round(img.height*scale)); const header=sheetCode?72:0; const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height+header;const ctx=canvas.getContext("2d");if(header){ctx.fillStyle="#ffffff";ctx.fillRect(0,0,width,header);ctx.fillStyle="#111827";ctx.font=`bold ${Math.max(20,Math.min(30,Math.round(width/55)))}px sans-serif`;ctx.textBaseline="middle";ctx.direction="ltr";ctx.fillText(`${sheetCode}  |  PAGE ${pageNumber}`,24,header/2);ctx.strokeStyle="#111827";ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(0,header-2);ctx.lineTo(width,header-2);ctx.stroke();}ctx.drawImage(img,0,header,width,height);resolve(canvas.toDataURL("image/jpeg",.84)); };img.src=reader.result; };reader.readAsDataURL(file); }); }
  async function saveDraftAndRender() { examSession.draft.updatedAt = Date.now(); await storePut(DRAFT_STORE, examSession.draft); renderExamScreen(); }
  function updateTimer() { if (!examSession || !$("examTimer")) return; const remain = Math.max(0, examSession.draft.expiresAt-Date.now()); const m=Math.floor(remain/60000),s=Math.floor(remain%60000/1000); $("examTimer").textContent=`${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`; }

  async function finalSubmitExam(auto) {
    if (!examSession) return; const { exam, draft } = examSession;
    if (!auto) {
      const count = exam.questions.filter(q=>v54QuestionAnswered(q,draft.answers||{})).length;
      const warning = (exam.type === "mcq"||exam.type === "mixed") && count < exam.questions.length ? `فقط ${count} سؤال از ${exam.questions.length} پاسخ داده شده است. ` : exam.type === "descriptive" && !count && !(draft.files||[]).length ? "هیچ پاسخ تایپی یا تصویری ثبت نشده است. " : exam.type === "descriptive" && count < exam.questions.length ? `برای ${count} سؤال پاسخ تایپی ثبت شده است. پاسخ‌های تصویری نیز در صورت وجود ارسال می‌شوند. ` : "";
      if (!confirm(`${warning}پس از ارسال نهایی امکان تغییر پاسخ وجود ندارد. ارسال شود؟`)) return;
      if (exam.type === "descriptive" && !Object.values(draft.answers||{}).some(x=>String(x||"").trim()) && !(draft.files||[]).length) return;
    }
    clearInterval(examTimer); setSync("در حال ارسال آزمون…");
    const finalizedAt=Date.now();
    const existingQueue=(await storeAll(QUEUE_STORE)).find(item=>item.examId===exam.id);
    const submissionKey=String(existingQueue?.submissionKey||draft.submissionKey||uid("submission"));
    draft.submissionKey=submissionKey;draft.finalizedAt=finalizedAt;
    const commonPayload={ answers:draft.answers||{}, startedAt:draft.startedAt, finalizedAt, durationSeconds:Math.min(Math.round((finalizedAt-draft.startedAt)/1000),Math.max(60,Number(exam.duration||0)*60+60)), autoSubmitted:Boolean(auto), submissionKey, packageVersion:exam.packageVersion||"", attemptId:exam.attemptId||"", packageSignature:exam.packageSignature||"" };
    const payload = exam.type === "descriptive" ? { ...commonPayload, files:draft.files||[], sheetCode:exam.sheetCode||exam.examCode||"" } : commonPayload;
    const queueItem = existingQueue || { id:uid("queue"), submissionKey, examId:exam.id, title:exam.title, kind:exam.type, payload, finalizedAt, createdAt:Date.now(), retryCount:0 };
    if(existingQueue) Object.assign(queueItem,{submissionKey,payload,kind:exam.type,title:exam.title,finalizedAt,updatedAt:Date.now()});
    await storePut(QUEUE_STORE,queueItem);
    await storePut(CACHE_STORE,{id:examStateId(exam.id),data:{status:"pending",examId:exam.id,submissionKey,queuedAt:Date.now(),finalizedAt,serverConfirmed:false},savedAt:Date.now()});
    let receipt={queued:true};
    try{
      await withNetwork("exam-submit",async()=>{await syncQueue();});
      const stillQueued=await storeGet(QUEUE_STORE,queueItem.id);
      if(!stillQueued){receipt=(await storeGet(CACHE_STORE,`receipt_${exam.id}`))?.data||{receiptId:"submitted",submittedAt:Date.now()};}
    }catch{}
    examSession=null; $("bottomNav").classList.remove("hidden"); $("page").className="page"; showReceipt(exam,receipt); setSync(receipt.queued?"پاسخ محفوظ روی گوشی":"حالت محلی");
  }
  function showReceipt(exam,receipt) {
    const finalResult = !receipt.queued && receipt.result && receipt.result.status==="final";
    const gradingMessage = finalResult
      ? `<div class="card mt result-immediate-v4517"><small>تصحیح خودکار انجام شد و نمره در کارنامه ثبت شد</small><br><b>نمره نهایی: ${fa(receipt.result.score)} از ${fa(receipt.result.total)}</b>${receipt.result.percent!==undefined?`<br><small>${fa(receipt.result.percent)}٪</small>`:""}</div>`
      : (!receipt.queued && ["descriptive","mixed"].includes(exam.type) ? `<div class="card mt"><b>پاسخ دریافت شد</b><br><small>${exam.type==="mixed"&&receipt.result?`بخش خودکار: ${fa(receipt.result.autoScore||0)} از ${fa(receipt.result.autoTotal||0)} · `:""}وضعیت: در انتظار تکمیل تصحیح معلم</small></div>` : "");
    openModal(`<div class="receipt"><div class="receipt-icon">✓</div><h3>${receipt.queued?"پاسخ روی گوشی ذخیره شد":"آزمون با موفقیت تحویل شد"}</h3><p class="muted">${receipt.queued?"پاسخ‌ها روی گوشی محفوظ‌اند. از بخش آزمون‌ها «ارسال پاسخ‌های در انتظار» را بزن.":`رسید: ${esc(receipt.receiptId||"ثبت شد")}${receipt.receiptHash?`<br><small>هش رسید: ${esc(receipt.receiptHash.slice(0,24))}</small>`:""}`}</p>${receipt.sheetCode?`<div class="card mt"><small>کد اختصاصی برگه</small><br><b dir="ltr">${esc(receipt.sheetCode)}</b></div>`:""}${gradingMessage}${finalResult?`<button class="btn primary mt" id="receiptReportCard">مشاهده در کارنامه</button>`:""}<button class="btn secondary mt" id="receiptDone">بازگشت به آزمون‌ها</button></div>`);
    if($("receiptReportCard")) $("receiptReportCard").onclick=async()=>{closeModal();try{await withNetwork("receipt-results-refresh",()=>refreshResultsCacheV4517());}catch{}navigate("results");};
    $("receiptDone").onclick=()=>{closeModal();navigate("exams");};
  }

  function renderTasks() { const tasks = dashboard?.homework || []; const statusText=(s,max=20)=>s?.status==="graded"?`نمره ${fa(s.score)} از ${fa(s.maxScore||max)}`:s?"تحویل‌شده":"انجام شود"; $("page").innerHTML = `<div class="section-title"><div><h3>تکالیف و فعالیت‌ها</h3><small class="muted">پاسخ یا توضیح تحویل را از همین صفحه برای معلم بفرست.</small></div><button id="refreshTasks">به‌روزرسانی</button></div><div class="list">${tasks.map(t=>{const sub=t.submission;return `<article class="card homework-student-card"><div class="row between"><div><b>${esc(t.title)}</b><small>${esc(t.subject)} · مهلت ${esc(t.dueAt||"تعیین نشده")}</small></div><span class="chip ${sub?.status==="graded"?"ok":sub?"ok":"warn"}">${statusText(sub,t.totalScore||20)}</span></div><p>${esc(t.description||"")}</p>${(t.attachments||[]).map(f=>`<a class="btn secondary" href="${f.data}" download="${esc(f.name)}">📎 ${esc(f.name)}</a>`).join('')}${sub?`<div class="sync-banner"><b>پاسخ ثبت‌شده:</b> ${esc(sub.text||"")}${sub.feedback?`<br><b>بازخورد معلم:</b> ${esc(sub.feedback)}`:""}</div>`:""}<div class="exam-actions">${sub?.status==="graded"?`<button class="btn secondary" disabled>نمره نهایی ثبت شده است</button>`:`<button class="btn primary" data-submit-homework-v19="${esc(t.id)}">${sub?"ویرایش تحویل":"تحویل تکلیف"}</button>`}</div></article>`;}).join("") || '<div class="card empty">تکلیف فعالی وجود ندارد.</div>'}</div>`; $("refreshTasks").onclick=async()=>{try{await withNetwork("homework-refresh",()=>syncDashboard());renderTasks();toast("تکالیف از سرور به‌روز شد.","ok");}catch(e){toast(e.message||"به‌روزرسانی تکالیف انجام نشد.","danger");}}; document.querySelectorAll("[data-submit-homework-v19]").forEach(b=>b.onclick=()=>submitHomeworkV19(b.dataset.submitHomeworkV19)); }
  function submitHomeworkV19(homeworkId){const task=(dashboard?.homework||[]).find(t=>t.id===homeworkId);if(!task)return;const needsFile=task.responseType==='file'||task.responseType==='both';openModal(`<div class="modal-head"><div><h3>${esc(task.title)}</h3><small class="muted">${esc(task.subject)} · مهلت ${esc(task.dueAt||"تعیین نشده")}</small></div><button class="close-btn" data-close>×</button></div><div class="card"><p>${esc(task.description||"")}</p>${(task.attachments||[]).map(f=>`<a class="btn secondary" href="${f.data}" download="${esc(f.name)}">📎 ${esc(f.name)}</a>`).join('')}</div>${task.responseType!=='file'?`<label class="field"><span>پاسخ یا توضیح تحویل</span><textarea id="homeworkAnswerV19" rows="7" placeholder="پاسخ را بنویس…">${esc(task.submission?.text||"")}</textarea></label>`:''}${needsFile?`<label class="field"><span>فایل پاسخ (حداکثر ۳ فایل، هرکدام ۵۰۰KB)</span><input id="homeworkFilesV65" type="file" multiple accept="image/png,image/jpeg,image/webp,application/pdf,.docx"></label>`:''}<button class="btn primary full" id="sendHomeworkV19">ارسال برای معلم</button>`);$("sendHomeworkV19").onclick=async()=>{const text=$("homeworkAnswerV19")?.value.trim()||'',input=$("homeworkFilesV65"),selected=input?[...input.files].slice(0,3):[];if(task.responseType==='text'&&text.length<2){toast("پاسخ یا توضیح تحویل را وارد کن.","danger");return;}if(task.responseType==='file'&&!selected.length){toast("فایل پاسخ را انتخاب کن.","danger");return;}const btn=$("sendHomeworkV19");btn.disabled=true;btn.textContent="در حال ارسال…";try{const files=await Promise.all(selected.map(f=>new Promise((ok,no)=>{if(f.size>500*1024)return no(Error('حجم هر فایل حداکثر ۵۰۰ کیلوبایت است.'));const r=new FileReader;r.onload=()=>ok({name:f.name,data:r.result});r.onerror=()=>no(Error('خواندن فایل ناموفق بود.'));r.readAsDataURL(f)})));await withNetwork("homework-submit",async()=>{const data=await api("/api/student/homework/submit",{method:"POST",body:JSON.stringify({homeworkId,text,files})});task.submission=data.submission;await syncDashboard(true);});closeModal();renderTasks();toast("تکلیف برای معلم ارسال شد.","ok");}catch(e){toast(e.message||"ارسال تکلیف انجام نشد.","danger");btn.disabled=false;btn.textContent="ارسال برای معلم";}};}


  function resultCard(row) {
    const final = row.status === "final";
    return `<article class="result-card"><div class="result-card-head"><div class="result-status-icon ${final?"final":"pending"}">${final?"✓":"⌛"}</div><div><b>${esc(row.title)}</b><small>${esc(examTypeLabelV54(row.type))} · ${final?`نمره ${fa(row.score)} از ${fa(row.total)}`:"در انتظار تصحیح معلم"}</small></div><span class="chip ${final?"ok":"warn"}">${final?"نتیجه نهایی":"در انتظار"}</span></div><div class="exam-actions">${final?`<button class="btn primary" data-result-details="${esc(row.examId)}">تحلیل سؤال‌به‌سؤال</button><button class="btn secondary small" data-appeal-exam="${esc(row.examId)}">اعتراض</button>`:`<button class="btn secondary" disabled>پس از ثبت نمره معلم قابل مشاهده است</button>`}</div></article>`;
  }

  function buildReportFromResultsV6104(results) {
    const bySubject = new Map();
    for (const r of results || []) {
      if (!r || r.status === "pending" || r.score == null) continue;
      const subject = r.subject || "سایر درس‌ها";
      const row = bySubject.get(subject) || { subject, earned: 0, possible: 0, count: 0 };
      row.earned += Number(r.score || 0);
      row.possible += Number(r.total || 0);
      row.count += 1;
      bySubject.set(subject, row);
    }
    return [...bySubject.values()].map(r => ({
      ...r,
      percent: r.possible ? Math.round((r.earned / r.possible) * 1000) / 10 : 0
    }));
  }

  // ===== 72.33-p1: professional semester report cards =====
  const TERM_LABEL_V733={semester1:"نیم‌سال اول",semester2:"نیم‌سال دوم"};
  function termLabelV733(period){return TERM_LABEL_V733[period]||"نیم‌سال دوم";}
  function professionalCardsStudentV733(){
    const reports=dashboard?.termReports||{};
    return `<section class="card" style="margin-bottom:14px"><div class="section-title"><div><h3>کارنامه رسمی نیم‌سال‌ها</h3><small class="muted">کارنامه فقط پس از انتشار نهایی مدرسه قابل مشاهده است.</small></div></div><div class="grid">${["semester1","semester2"].map(period=>{const r=reports[period]||{},published=r.reportCardStatus==="published";return `<article class="card stat-card"><small>${termLabelV733(period)}</small><b>${published&&r.average!==null&&r.average!==undefined?fa(r.average):"—"}</b><small>${published?`معدل از ${fa(r.scoreScale||20)}`:"هنوز منتشر نشده"}</small><button class="btn ${published?'primary':'secondary'}" data-v733-student-card="${period}" ${published?'':'disabled'}>${published?'مشاهده / چاپ':'در انتظار انتشار'}</button></article>`;}).join("")}</div></section>`;
  }
  function termStatusFaV733(status){return ({passed:"قبول",failed:"نیاز به پیگیری",pending:"ثبت نشده"})[status]||status||"ثبت نشده";}
  function studentTermCardBodyV733(period){
    const r=dashboard?.termReports?.[period]||{},student=dashboard?.student||{},att=r.attendanceSummary||{},rows=r.completeSubjects||r.subjects||[],published=r.reportCardStatus==="published";
    if(!published)return `<div class="modal-head"><h3>کارنامه ${termLabelV733(period)}</h3><button class="close-btn" data-close>×</button></div><div class="card empty">این کارنامه هنوز توسط مدرسه منتشر نشده است.</div>`;
    const table=rows.map((x,i)=>`<tr><td>${fa(i+1)}</td><td>${esc(x.subject||"")}</td><td>${x.continuousScore===null||x.continuousScore===undefined?'—':fa(x.continuousScore)}</td><td>${x.finalComponent===null||x.finalComponent===undefined?'—':fa(x.finalComponent)}</td><td><b>${x.finalScore===null||x.finalScore===undefined?'—':fa(x.finalScore)}</b></td><td>${termStatusFaV733(x.status)}</td></tr>`).join("");
    return `<div class="modal-head"><div><h3>کارنامه رسمی ${termLabelV733(period)}</h3><small>${esc(student.className||"")} · سال تحصیلی ${esc(r.academicYear||"")}</small></div><button class="close-btn" data-close>×</button></div><div class="grid"><article class="card stat-card"><b>${r.average===null||r.average===undefined?'—':fa(r.average)}</b><small>معدل نیم‌سال</small></article><article class="card stat-card"><b>${fa(r.summary?.gradedSubjects||0)}</b><small>دروس نمره‌دار</small></article><article class="card stat-card"><b>${fa(r.summary?.failedCount||0)}</b><small>نیازمند پیگیری</small></article></div><div class="table-wrap"><table><thead><tr><th>ردیف</th><th>درس</th><th>مستمر</th><th>پایانی</th><th>نهایی</th><th>وضعیت</th></tr></thead><tbody>${table||'<tr><td colspan="6">نمره‌ای ثبت نشده است.</td></tr>'}</tbody></table></div><div class="card"><b>حضور و غیاب ${termLabelV733(period)}</b><p>حاضر: ${fa(att.present||0)} · تأخیر: ${fa(att.late||0)} · غیبت موجه: ${fa(att.excused||0)} · غیبت غیرموجه: ${fa(att.unexcused||0)} · در انتظار بررسی: ${fa(att.pending||0)}</p></div><div class="grid"><article class="card"><b>انضباط</b><p>${r.disciplineScore===null||r.disciplineScore===undefined?'—':fa(r.disciplineScore)}</p></article><article class="card"><b>پرورشی</b><p>${r.cultivationScore===null||r.cultivationScore===undefined?'—':fa(r.cultivationScore)}</p></article></div><div class="card"><b>نظر معلم</b><p>${esc(r.teacherComment||'—')}</p><b>نظر مدیر</b><p>${esc(r.managerComment||'—')}</p></div><button class="btn primary full" data-v733-student-print="${period}">چاپ / ذخیره PDF</button>`;
  }
  function openStudentTermCardV733(period){openModal(studentTermCardBodyV733(period));document.querySelector(`[data-v733-student-print="${period}"]`)?.addEventListener("click",()=>printStudentTermCardV733(period));}
  function printStudentTermCardV733(period){
    const r=dashboard?.termReports?.[period]||{},student=dashboard?.student||{},att=r.attendanceSummary||{},rows=r.completeSubjects||r.subjects||[];if(r.reportCardStatus!=="published"){toast("این کارنامه هنوز منتشر نشده است.","danger");return;}const win=window.open("","_blank");if(!win){toast("پنجره چاپ مسدود شده است.","danger");return;}
    const table=rows.map((x,i)=>`<tr><td>${fa(i+1)}</td><td>${esc(x.subject||"")}</td><td>${x.continuousScore===null||x.continuousScore===undefined?'—':fa(x.continuousScore)}</td><td>${x.finalComponent===null||x.finalComponent===undefined?'—':fa(x.finalComponent)}</td><td><b>${x.finalScore===null||x.finalScore===undefined?'—':fa(x.finalScore)}</b></td><td>${termStatusFaV733(x.status)}</td></tr>`).join("");
    win.document.write(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>کارنامه ${termLabelV733(period)}</title><style>@page{size:A4 portrait;margin:9mm}*{box-sizing:border-box}body{font-family:Tahoma,Arial;color:#15324a}.sheet{border:2px solid #174b72;border-radius:10px;padding:10mm}.head{text-align:center;border-bottom:2px solid #c59a3d;padding-bottom:4mm}.head h1{margin:0;color:#123f70}.meta,.summary,.att{display:grid;grid-template-columns:repeat(3,1fr);gap:3mm;margin:4mm 0}.summary{grid-template-columns:repeat(4,1fr)}.att{grid-template-columns:repeat(5,1fr)}.box{border:1px solid #b8cbd9;border-radius:6px;padding:2.5mm}.box small{display:block;color:#64748b}table{width:100%;border-collapse:collapse;font-size:9pt}th{background:#eaf3f8;color:#123f70}th,td{border:1px solid #b3c3cf;padding:2mm;text-align:center}.comments{display:grid;grid-template-columns:1fr 1fr;gap:3mm;margin-top:4mm}.comment{border:1px solid #b8cbd9;border-radius:6px;min-height:25mm;padding:3mm}.sign{display:grid;grid-template-columns:repeat(3,1fr);gap:8mm;text-align:center;margin-top:15mm}.sign div{border-top:1px dotted #789;padding-top:2mm}</style></head><body><section class="sheet"><div class="head"><h1>کارنامه رسمی ${termLabelV733(period)}</h1><h2>${esc(student.schoolName||"مدرسه")}</h2><div>سال تحصیلی ${esc(r.academicYear||"")}</div></div><div class="meta"><div class="box"><small>دانش‌آموز</small><b>${esc(`${student.firstName||''} ${student.lastName||''}`.trim())}</b></div><div class="box"><small>کلاس</small><b>${esc(student.className||"—")}</b></div><div class="box"><small>کد دانش‌آموزی</small><b>${esc(student.studentCode||"—")}</b></div></div><table><thead><tr><th>ردیف</th><th>درس</th><th>مستمر</th><th>پایانی</th><th>نهایی</th><th>وضعیت</th></tr></thead><tbody>${table}</tbody></table><div class="summary"><div class="box"><small>معدل</small><b>${r.average===null||r.average===undefined?'—':fa(r.average)}</b></div><div class="box"><small>دروس نمره‌دار</small><b>${fa(r.summary?.gradedSubjects||0)}</b></div><div class="box"><small>نیازمند پیگیری</small><b>${fa(r.summary?.failedCount||0)}</b></div><div class="box"><small>انضباط</small><b>${r.disciplineScore===null||r.disciplineScore===undefined?'—':fa(r.disciplineScore)}</b></div></div><div class="att"><div class="box"><small>حاضر</small><b>${fa(att.present||0)}</b></div><div class="box"><small>تأخیر</small><b>${fa(att.late||0)}</b></div><div class="box"><small>غیبت موجه</small><b>${fa(att.excused||0)}</b></div><div class="box"><small>غیبت غیرموجه</small><b>${fa(att.unexcused||0)}</b></div><div class="box"><small>در انتظار</small><b>${fa(att.pending||0)}</b></div></div><div class="comments"><div class="comment"><b>نظر معلم</b><p>${esc(r.teacherComment||'—')}</p></div><div class="comment"><b>نظر مدیر</b><p>${esc(r.managerComment||'—')}</p></div></div><div class="sign"><div>امضای معلم</div><div>امضای مدیر</div><div>مهر مدرسه</div></div></section><script>setTimeout(()=>window.print(),400)<\/script></body></html>`);win.document.close();
  }

  let resultsLastRefreshAtV135 = 0;
  async function renderResults(options = {}) {
    /* v61.12.0.0: کارنامه همیشه از داده تازه سرور ساخته می‌شود.
       اگر report خلاصه قدیمی باشد، از خود results دوباره محاسبه می‌کنیم. */
    let resultsData = null;
    let dashboardFresh = null;

    const shouldRefreshNetworkV135 = Boolean(options?.forceNetwork) || (Date.now() - resultsLastRefreshAtV135 > 30000);
    if (shouldRefreshNetworkV135) {
      try {
        dashboardFresh = await withNetwork("results-refresh",()=>api("/api/student/dashboard", {}, true));
        if (dashboardFresh) {
          dashboard = dashboardFresh;
          await reconcileSubmittedExams(dashboardFresh);
          await storePut(CACHE_STORE, { id:"dashboard", data:dashboardFresh, savedAt:Date.now() });
        }
      } catch {}

      try {
        resultsData = await withNetwork("results-refresh",()=>api("/api/student/results", {}, true));
        if (resultsData) await storePut(CACHE_STORE, { id:"results", data:resultsData, savedAt:Date.now() });
      } catch {}
      if (dashboardFresh || resultsData) resultsLastRefreshAtV135 = Date.now();
    }

    if (!resultsData) resultsData = (await storeGet(CACHE_STORE,"results"))?.data || null;
    if (!resultsData) resultsData = { results: [], report: [] };

    let results = Array.isArray(resultsData.results) ? resultsData.results.slice() : [];

    // Fallback/merge from the freshly fetched dashboard. This also handles
    // the short window immediately after an exam is submitted and graded.
    const resultMap = new Map(results.map(r => [String(r.examId), {...r}]));
    for (const attempt of (dashboard?.attempts || [])) {
      const exam = (dashboard?.exams || []).find(e => String(e.id) === String(attempt.examId));
      if (!exam) continue;
      const total = Number(attempt.total || exam.totalScore || 0);
      const score = Number(attempt.score || 0);
      resultMap.set(String(exam.id), {
        ...(resultMap.get(String(exam.id)) || {}),
        id: attempt.id || `attempt_${exam.id}`,
        examId: exam.id,
        title: exam.title,
        subject: exam.subject || "",
        bookId: exam.bookId || resultMap.get(String(exam.id))?.bookId || "",
        bookTitle: exam.bookTitle || resultMap.get(String(exam.id))?.bookTitle || exam.subject || "",
        chapterId: exam.chapterId || resultMap.get(String(exam.id))?.chapterId || "",
        chapter: exam.chapter || resultMap.get(String(exam.id))?.chapter || "",
        type: exam.type || "mcq",
        score,
        total,
        percent: Number(attempt.percent ?? (total ? Math.round(score / total * 1000) / 10 : 0)),
        correctCount: Number(attempt.correctCount || 0),
        answeredCount: Number(attempt.answeredCount || 0),
        questionCount: Number(attempt.questionCount || (exam.questions || []).length),
        gradingStatus: "final",
        status: "final",
        submittedAt: Number(attempt.submittedAt || 0),
        resultRevision: Number(attempt.resultRevision||1),
        resultUpdatedAt: Number(attempt.resultUpdatedAt||attempt.submittedAt||0),
        canAppeal: true
      });
    }

    for (const submission of (dashboard?.submissions || [])) {
      const exam = (dashboard?.exams || []).find(e => String(e.id) === String(submission.examId));
      if (!exam) continue;
      const grade = (dashboard?.grades || []).find(g => String(g.submissionId) === String(submission.id) && String(g.publishStatus || "published") === "published");
      if (!grade) continue;
      const old = resultMap.get(String(exam.id)) || {};
      resultMap.set(String(exam.id), {
        ...old,
        id: submission.id,
        examId: exam.id,
        title: exam.title,
        subject: exam.subject || "",
        bookTitle: exam.bookTitle || old.bookTitle || exam.subject || "",
        chapter: exam.chapter || old.chapter || "",
        type: exam.type || "descriptive",
        score: Number(grade.finalScore || 0),
        total: Number(exam.totalScore || old.total || 0),
        status: "final",
        gradingStatus: "final",
        submittedAt: Number(submission.submittedAt || 0),
        feedback: grade.feedback || "",
        resultRevision: Number(grade.resultRevision||1),
        resultUpdatedAt: Number(grade.publishedAt||grade.gradedAt||0),
        canAppeal: true
      });
    }

    results = [...resultMap.values()].sort((a,b) => Number(b.submittedAt || 0) - Number(a.submittedAt || 0));
    const serverReport = Array.isArray(resultsData.report) ? resultsData.report : [];
    const report = serverReport.length ? serverReport : buildReportFromResultsV6104(results);
    const groups = groupBySubject(results);

    // p10: کارنامه مستمر تفصیلی، متصل به تحلیل واقعی آزمون و نه داده نمایشی.
    const detailedContinuousP10 = (()=>{
      const published=results.filter(r=>r.status==="final" && Number.isFinite(Number(r.score)) && Number(r.total)>0);
      const bySubject=new Map();
      for(const r of published){
        const key=String(r.subject||"درس نامشخص").trim();
        if(!bySubject.has(key))bySubject.set(key,[]);
        bySubject.get(key).push(r);
      }
      const subjects=[...bySubject].sort((a,b)=>a[0].localeCompare(b[0],"fa"));
      const score20=r=>Number(r.score)/Number(r.total)*20;
      const average=rows=>rows.length?rows.reduce((sum,r)=>sum+score20(r),0)/rows.length:null;
      const numeric=n=>fa(Math.round(n*100)/100);
      const dateOf=r=>{const t=Number(r.submittedAt||0);return t?new Date(t<1e11?t*1000:t).toLocaleDateString("fa-IR"):"ثبت نشده";};
      const shell=`<style>.p10-wrap{border:1px solid #d8e2ee;border-radius:17px;background:#fff;padding:16px;margin:14px 0;color:#143252}.p10-head{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:2px solid #d5ae66;padding-bottom:12px;margin-bottom:12px}.p10-table{width:100%;border-collapse:collapse;min-width:530px}.p10-table th{background:#133e70;color:white}.p10-table td,.p10-table th{padding:12px 9px;border:1px solid #dbe5f0;text-align:right}.p10-table tbody tr:nth-child(even){background:#f4f8fd}.p10-btn{border:1px solid #b4cbe0;border-radius:8px;background:#edf5ff;color:#143e70;padding:7px 12px;cursor:pointer;font-weight:bold}.p10-summary{background:#f7f1e6;border:1px solid #e4d0a7;padding:10px;border-radius:9px}.p10-scroll{overflow-x:auto}</style>`;
      const header=`<div class="p10-head"><div><h3>کارنامه مستمر تفصیلی</h3><small>آزمون‌های دارای نتیجه نهایی و منتشرشده</small></div><span class="p10-summary">${numeric(average(published)||0)} از ۲۰</span></div>`;
      const table=subjects.map(([subject,rows],i)=>`<tr><td>${fa(i+1)}</td><td><b>${esc(subject)}</b></td><td>${fa(rows.length)}</td><td>${numeric(average(rows))} از ۲۰</td><td><button class="p10-btn" data-p10-subject="${esc(subject)}">مشاهده آزمون‌ها</button></td></tr>`).join("");
      const overview=`${shell}<section class="p10-wrap">${header}<div class="p10-scroll"><table class="p10-table"><thead><tr><th>ردیف</th><th>درس</th><th>تعداد آزمون</th><th>میانگین</th><th>جزئیات</th></tr></thead><tbody>${table||'<tr><td colspan="5">هنوز نتیجه آزمون منتشرشده‌ای وجود ندارد.</td></tr>'}</tbody></table></div></section>`;
      const openSubject=(subject)=>{
        const rows=(bySubject.get(subject)||[]).slice().sort((a,b)=>Number(a.submittedAt||0)-Number(b.submittedAt||0));
        const html=`${shell}<div class="p10-head"><h3>کارنامه درس ${esc(subject)}</h3><span class="p10-summary">میانگین: ${numeric(average(rows))} از ۲۰</span></div><div class="p10-scroll"><table class="p10-table"><thead><tr><th>آزمون</th><th>عنوان</th><th>تاریخ ارسال</th><th>نوع</th><th>نمره</th><th>برگه تصحیح</th></tr></thead><tbody>${rows.map((r,i)=>`<tr><td>${fa(i+1)}</td><td>${esc(r.title||"آزمون")}</td><td>${dateOf(r)}</td><td>${esc(r.type==="mcq"?"تستی":r.type==="mixed"?"ترکیبی":"تشریحی")}</td><td>${numeric(score20(r))} از ۲۰</td><td><button class="p10-btn" data-p10-exam="${esc(r.examId)}">تحلیل آزمون</button></td></tr>`).join("")}</tbody></table></div>`;
        openModal(html);
        document.querySelectorAll("[data-p10-exam]").forEach(b=>b.onclick=()=>openResultDetails(b.dataset.p10Exam));
      };
      return {overview,openSubject};
    })();
    if(selectedResultSubject&&!groups.some(g=>g.subject===selectedResultSubject))selectedResultSubject="";
    if(!selectedResultSubject){
      $("page").innerHTML=`<div class="section-title"><div><h3>کارنامه و تحلیل یادگیری</h3><small class="muted">نمره‌های ثبت‌شده در سرور در این صفحه نمایش داده می‌شوند.</small></div><button id="resultSync">به‌روزرسانی</button></div>${professionalCardsStudentV733()}${detailedContinuousP10.overview}<article class="card"><h3>عملکرد در درس‌ها</h3>${report.length?report.map(r=>`<div class="report-row"><div class="label"><span>${esc(r.subject)}</span><b>${fa(r.percent)}٪</b></div><div class="progress-ring"><i style="width:${Math.min(100,r.percent)}%"></i></div></div>`).join(""):'<div class="empty">هنوز نمره‌ای ثبت نشده است.</div>'}</article><div class="section-title"><h3>کتاب‌ها</h3></div>${groups.length?bookGrid(groups,"results"):'<div class="card empty">هنوز نتیجه‌ای ثبت نشده است.</div>'}`;
      document.querySelectorAll("[data-p10-subject]").forEach(b=>b.onclick=()=>detailedContinuousP10.openSubject(b.dataset.p10Subject));document.querySelectorAll("[data-book-subject]").forEach(b=>b.onclick=()=>{selectedResultSubject=b.dataset.bookSubject;renderResults();});document.querySelectorAll("[data-v733-student-card]").forEach(b=>b.onclick=()=>openStudentTermCardV733(b.dataset.v733StudentCard));
    }else{
      const group=groups.find(g=>g.subject===selectedResultSubject),chapters=groupByChapter(group?.rows||[]);
      $("page").innerHTML=`<div class="book-toolbar"><button class="back-book" id="backToResultBooks">→ کتاب‌ها</button><div><h3>${subjectIcon(group.subject)} ${esc(group.bookTitle||group.subject)}</h3><small>نتایج و ایرادهای هر فصل</small></div><button id="resultSync">به‌روزرسانی</button></div>${chapters.map(([chapter,rows])=>`<section class="chapter-section"><div class="chapter-heading"><div><span>فصل</span><b>${esc(chapter)}</b></div><small>${fa(rows.length)} آزمون</small></div>${rows.map(resultCard).join("")}</section>`).join("")}`;
      $("backToResultBooks").onclick=()=>{selectedResultSubject="";renderResults();};
      document.querySelectorAll("[data-result-details]").forEach(b=>b.onclick=()=>openResultDetails(b.dataset.resultDetails));
      document.querySelectorAll("[data-appeal-exam]").forEach(b=>b.onclick=()=>appealDialog(b.dataset.appealExam));
    }
    if($("resultSync"))$("resultSync").onclick=async()=>{await renderResults({forceNetwork:true});toast("کارنامه از سرور به‌روز شد.","ok");};
  }

  function questionStatusFa(status){return ({correct:"کاملاً درست",partial:"نیازمند تکمیل",incorrect:"نادرست"})[status]||status;}
  async function openResultDetails(examId){
    openModal(`<div class="result-loading">در حال دریافت تحلیل آزمون…</div>`);
    // v45.25: همه اقدام‌های صریح کاربر که نیازمند سرور هستند با مجوز موقت شبکه اجرا می‌شوند.
    // v45.24: لمس «تحلیل سؤال‌به‌سؤال» یک اقدام صریح کاربر است؛ بنابراین اتصال موقت شبکه فقط برای دریافت جزئیات همین نتیجه مجاز می‌شود.
    let data=null, loadError=null;
    try{
      data=await withNetwork("result-details",()=>api(`/api/student/results/${encodeURIComponent(examId)}/details`,{},true));
      if(data)await storePut(CACHE_STORE,{id:`result_detail_${examId}`,data,savedAt:Date.now()});
    }catch(e){loadError=e;}
    if(!data){
      const cached=(await storeGet(CACHE_STORE,`result_detail_${examId}`))?.data||null;
      const listCache=(await storeGet(CACHE_STORE,"results"))?.data?.results||[];
      const latest=listCache.find(r=>String(r.examId)===String(examId));
      const cachedRev=Number(cached?.resultRevision||0), latestRev=Number(latest?.resultRevision||0);
      if(cached && (!latestRev || cachedRev>=latestRev)) data=cached;
      else if(cached && latestRev>cachedRev) loadError=new Error("نسخه ذخیره‌شده نتیجه قدیمی است؛ برای دیدن نتیجه بازبینی‌شده به اینترنت وصل شوید.");
    }
    if(!data){
      const message=loadError?.message||"دریافت تحلیل از سرور انجام نشد. اینترنت گوشی را بررسی کن و دوباره بزن.";
      openModal(`<div class="modal-head"><h3>تحلیل آزمون</h3><button class="close-btn" data-close>×</button></div><div class="offline-banner">${esc(message)}</div>`);return;
    }
    if(data.status!=="final"){openModal(`<div class="modal-head"><div><h3>${esc(data.title)}</h3><small class="muted">${esc(data.subject)} · ${esc(data.chapter)}</small></div><button class="close-btn" data-close>×</button></div><div class="offline-banner">${esc(data.feedback||"برگه در انتظار تصحیح معلم است.")}</div>`);return;}
    const summary=`<div class="result-summary"><div><small>نمره نهایی</small><b>${fa(data.score)} از ${fa(data.total)}</b></div><div><small>کتاب و فصل</small><b>${esc(data.subject)} · ${esc(data.chapter)}</b></div></div>${data.feedback?`<div class="teacher-overall-feedback"><b>بازخورد کلی معلم</b><p>${esc(data.feedback)}</p></div>`:""}`;
    const questions=(data.questions||[]).map(q=>{
      if(data.type==="mcq" || (data.type==="mixed" && q.autoGraded)) return `<article class="analysis-question ${q.correct?"correct":"incorrect"}"><div class="analysis-question-head"><b>${fa(q.number)}. ${esc(q.text)}</b><span class="chip ${q.correct?"ok":"danger"}">${q.correct?"درست":"غلط"} · ${fa(q.earnedScore)} از ${fa(q.maxScore)}</span></div><div class="answer-comparison"><div class="student-answer ${q.correct?"ok":"wrong"}"><small>پاسخ تو</small><b>${esc(q.answered?q.selectedAnswer:"بدون پاسخ")}</b></div>${q.correct?"":`<div class="correct-answer"><small>پاسخ صحیح</small><b>${esc(q.correctAnswer)}</b></div>`}</div><div class="learning-note"><b>نکته آموزشی</b><p>${esc(q.explanation||"")}</p></div>${q.correct?"":`<button class="btn secondary small" data-question-appeal="${esc(data.examId)}|${esc(q.questionId)}">اعتراض به این سؤال</button>`}</article>`;
      const criteria=(q.criteria||[]).length?`<div class="criteria-result">${q.criteria.map(c=>`<div><span>${esc(c.title)}</span><b>${fa(c.score)} از ${fa(c.maxScore)}</b></div>`).join("")}</div>`:"";
      return `<article class="analysis-question ${q.status}"><div class="analysis-question-head"><b>${fa(q.number)}. ${esc(q.text)}</b><span class="chip ${q.status==="correct"?"ok":q.status==="partial"?"warn":"danger"}">${questionStatusFa(q.status)} · ${fa(q.earnedScore)} از ${fa(q.maxScore)}</span></div><div class="written-result"><small>پاسخ ثبت‌شده تو</small><p>${esc(q.studentAnswer)}</p></div>${criteria}${q.teacherFeedback?`<div class="learning-note"><b>بازخورد این سؤال</b><p>${esc(q.teacherFeedback)}</p></div>`:""}${q.referenceAnswer?`<details class="reference-answer"><summary>پاسخ راهنما را ببین</summary><p>${esc(q.referenceAnswer)}</p></details>`:""}<button class="btn secondary small" data-question-appeal="${esc(data.examId)}|${esc(q.questionId)}">اعتراض به این سؤال</button></article>`;
    }).join("");
    openModal(`<div class="modal-head"><div><h3>${esc(data.title)}</h3><small class="muted">تحلیل سؤال‌به‌سؤال</small></div><button class="close-btn" data-close>×</button></div>${summary}<div class="analysis-list">${questions||'<div class="empty">جزئیات سؤالات ثبت نشده است.</div>'}</div>`);
    document.querySelectorAll("[data-question-appeal]").forEach(b=>b.onclick=()=>{const [examId,questionId]=b.dataset.questionAppeal.split("|");appealDialog(examId,questionId);});
  }

  function appealDialog(examId,questionId=null) { const exam=findExam(examId)||{};openModal(`<div class="modal-head"><h3>درخواست بررسی مجدد</h3><button class="close-btn" data-close>×</button></div><p>${esc(exam.title||"آزمون")}${questionId?`<br><small>اعتراض مربوط به یک سؤال مشخص است.</small>`:""}</p><label class="field"><span>توضیح کامل اعتراض</span><textarea id="appealText" rows="5" placeholder="دلیل درخواست بررسی مجدد را بنویس…"></textarea></label><button id="sendAppealBtn" class="btn primary">ثبت اعتراض</button>`); $("sendAppealBtn").onclick=async()=>{const message=$("appealText").value.trim();if(message.length<10){toast("توضیح اعتراض باید کامل‌تر باشد.","danger");return;}try{await withNetwork("appeal-submit",async()=>{await api("/api/student/appeals",{method:"POST",body:JSON.stringify({examId,questionId,message})});await syncDashboard(true);});closeModal();toast("اعتراض برای معلم ارسال شد.","ok");}catch(e){toast(e.message,"danger");}}; }
  function renderAppeals() { const rows=dashboard?.appeals||[]; $("page").innerHTML=`<div class="section-title"><h3>پیگیری اعتراض‌ها</h3></div><div class="list">${rows.map(a=>{const ex=findExam(a.examId)||{},timeline=(a.history||[]).map(h=>`<div class="appeal-step"><b>${esc({open:"ثبت‌شده",reviewing:"در حال بررسی",accepted:"پذیرفته‌شده",rejected:"ردشده",closed:"بسته‌شده"}[h.status]||h.status)}</b><small>${esc(h.note||h.reason||"")}<br>${esc(h.at||"")}</small></div>`).join("");return `<div class="card"><div class="row between"><b>${esc(ex.title||"آزمون")}</b><span class="chip ${a.status==="accepted"?"ok":a.status==="rejected"?"danger":"warn"}">${esc({open:"ثبت‌شده",reviewing:"در حال بررسی",accepted:"پذیرفته‌شده",rejected:"ردشده",closed:"بسته‌شده"}[a.status]||a.status)}</span></div><p class="muted">${esc(a.message)}</p>${timeline?`<details><summary>مراحل رسیدگی</summary><div class="appeal-timeline">${timeline}</div></details>`:""}${a.teacherResponse?`<div class="sync-banner">پاسخ معلم: ${esc(a.teacherResponse)}${a.resolvedResultRevision?`<br><small>نسخه نتیجه پس از رسیدگی: ${fa(a.resolvedResultRevision)}</small>`:""}</div>`:""}</div>`}).join("")||'<div class="card empty">اعتراضی ثبت نکرده‌ای.</div>'}</div>`; }
  function renderSchedule() {
    const weekly=dashboard?.weeklySchedule||[];
    if(weekly.length){
      const today=dayNameV74();
      const order=["شنبه","یکشنبه","دوشنبه","سه‌شنبه","چهارشنبه","پنجشنبه"];
      const rows=weekly.slice().sort((a,b)=>order.indexOf(a.day)-order.indexOf(b.day)||Number(a.periodNo)-Number(b.periodNo));
      $("page").innerHTML=`<article class="card table-card"><div class="row between"><div><h3>برنامه هفتگی</h3><small>کلاس‌های آنلاین و ترکیبی مستقیماً از همین برنامه باز می‌شوند.</small></div>${dashboard?.onlineLearning?.enabled?`<span class="chip ok">${esc(modeLabelV74(dashboard.onlineLearning.operationMode))}</span>`:""}</div><table><thead><tr><th>روز</th><th>شیفت</th><th>زنگ / ساعت</th><th>درس</th><th>دبیر</th><th>نوع کلاس</th><th>ورود</th></tr></thead><tbody>${rows.map(e=>`<tr><td><b>${esc(e.day)}</b>${e.day===today?'<small style="display:block">امروز</small>':""}</td><td>${esc(e.shiftName||"—")}</td><td>زنگ ${fa(e.periodNo)}<small style="display:block">${esc(e.startTime||"")}–${esc(e.endTime||"")}</small></td><td>${esc(e.subject)}</td><td>${esc(e.teacherName||"—")}</td><td><span class="chip ${["online","hybrid"].includes(e.effectiveMode)?"ok":""}">${esc(modeLabelV74(e.effectiveMode))}</span></td><td>${e.day===today&&["online","hybrid"].includes(e.effectiveMode)?(canJoinOnlineEntryV74(e)?`<button class="btn primary" data-online-join-v74="${esc(e.id)}">ورود به کلاس</button>`:`<button class="btn secondary" data-online-refresh-v74>به‌روزرسانی</button>`):"—"}</td></tr>`).join("")}</tbody></table></article>`;
      bindOnlineJoinV74();
      return;
    }
    const rows=dashboard?.schedule||[];
    const count=Math.max(4,...rows.map(r=>(r.periods||[]).length));
    const body=rows.map(r=>`<tr><th>${esc(r.day)}</th>${Array.from({length:count},(_,i)=>`<td>${esc(r.periods?.[i]||"—")}</td>`).join("")}</tr>`).join("");
    $("page").innerHTML=`<article class="card table-card"><h3>برنامه هفتگی</h3><table><thead><tr><th>روز</th>${Array.from({length:count},(_,i)=>`<th>زنگ ${fa(i+1)}</th>`).join("")}</tr></thead><tbody>${body||`<tr><td colspan="${count+1}">برنامه هفتگی ثبت نشده است.</td></tr>`}</tbody></table></article>`;
  }
  function safeResourceUrlV135(value){
    const raw=String(value||"").trim(); if(!raw)return "";
    try{const u=new URL(raw,`${server.replace(/\/$/,"")}/`);return ["http:","https:"].includes(u.protocol)?u.href:"";}catch{return "";}
  }
  function renderResources() {
    const rows=dashboard?.resources||[];
    $("page").innerHTML=`<div class="section-title"><div><h3>منابع آموزشی</h3><small class="muted">جزوه، فایل و لینک‌هایی که مدرسه برای کلاس شما منتشر کرده است.</small></div></div><div class="list">${rows.map(r=>{const url=safeResourceUrlV135(r.url||r.link||r.fileUrl);return `<article class="card"><div class="row between"><div><b>📚 ${esc(r.title)}</b><small>${esc(r.subject||"")} · ${esc(r.type||"منبع آموزشی")}</small></div>${url?'<span class="chip ok">آماده</span>':'<span class="chip warn">بدون فایل</span>'}</div>${r.description?`<p>${esc(r.description)}</p>`:""}${url?`<button class="btn primary full" data-resource-open-v135="${esc(url)}">باز کردن / دریافت منبع</button>`:'<small class="muted">برای این مورد هنوز فایل یا لینک قابل دریافت ثبت نشده است.</small>'}</article>`;}).join("")||'<div class="card empty">منبع آموزشی ثبت نشده است.</div>'}</div>`;
    document.querySelectorAll("[data-resource-open-v135]").forEach(b=>b.onclick=()=>{const url=safeResourceUrlV135(b.dataset.resourceOpenV135);if(!url){toast("لینک این منبع معتبر نیست.","danger");return;}const w=window.open(url,"_blank","noopener,noreferrer");if(!w)toast("مرورگر اجازه باز کردن منبع را نداد.","danger");});
  }

  function renderLearningV28(){
    const lessons=dashboard?.lessonLogs||[],ass=dashboard?.continuousAssessments||[],goals=dashboard?.studentGoals||[],mastery=dashboard?.masteryRecords||[],plans=dashboard?.studyPlans||[],achievements=dashboard?.achievements||[];
    const goalHtml=goals.slice(0,20).map(x=>{const progress=Math.max(0,Math.min(100,Number(x.progress??x.percent??0)||0));return `<article class="card"><div class="row between"><div><b>${esc(x.title||x.goal||x.subject||"هدف آموزشی")}</b><small>${esc(x.subject||x.topic||"")}${x.dueDate?` · مهلت ${esc(x.dueDate)}`:""}</small></div><span class="chip ${String(x.status||"")==="done"?"ok":"info"}">${progress?fa(progress)+"٪":esc(({done:"انجام‌شده",active:"فعال",open:"فعال"})[x.status]||x.status||"فعال")}</span></div>${x.description||x.note?`<p>${esc(x.description||x.note)}</p>`:""}${progress?`<div class="progress-ring"><i style="width:${progress}%"></i></div>`:""}</article>`;}).join("");
    const planHtml=plans.slice(0,20).map(x=>`<article class="card"><div class="row between"><div><b>${esc(x.title||x.subject||"برنامه مطالعه")}</b><small>${esc(x.subject||"")}${x.date||x.dueDate?` · ${esc(x.date||x.dueDate)}`:""}</small></div><span class="chip ${String(x.status||"")==="done"?"ok":"warn"}">${esc(({done:"انجام‌شده",active:"در حال اجرا",open:"در حال اجرا",planned:"برنامه‌ریزی‌شده"})[x.status]||x.status||"برنامه‌ریزی‌شده")}</span></div>${x.description||x.note||x.action?`<p>${esc(x.description||x.note||x.action)}</p>`:""}</article>`).join("");
    const achievementHtml=achievements.slice(0,20).map(x=>`<div class="list-item"><div class="list-icon">🏆</div><div class="list-main"><b>${esc(x.title||x.name||"دستاورد")}</b><small>${esc(x.date||x.createdAt||"")}${x.note||x.description?`<br>${esc(x.note||x.description)}`:""}</small></div></div>`).join("");
    $("page").innerHTML=`<div class="section-title"><div><h3>یادگیری من</h3><small class="muted">جلسات، ارزیابی‌های مستمر، هدف‌ها، برنامه مطالعه و دستاوردهای شما</small></div></div><div class="grid"><article class="card stat-card"><b>${fa(lessons.length)}</b><small>جلسه آموزشی</small></article><article class="card stat-card"><b>${fa(ass.length)}</b><small>ارزیابی مستمر</small></article><article class="card stat-card"><b>${fa(goals.filter(x=>!["done","closed"].includes(String(x.status||""))).length)}</b><small>هدف فعال</small></article><article class="card stat-card"><b>${fa(achievements.length)}</b><small>دستاورد</small></article></div><div class="section-title"><h3>هدف‌های من</h3></div><div class="list">${goalHtml||'<div class="card empty">هدف آموزشی فعالی ثبت نشده است.</div>'}</div><div class="section-title"><h3>برنامه مطالعه</h3></div><div class="list">${planHtml||'<div class="card empty">برنامه مطالعه‌ای ثبت نشده است.</div>'}</div><div class="section-title"><h3>تسلط بر مباحث</h3></div><div class="list">${mastery.slice(0,20).map(x=>`<div class="list-item"><div class="list-main"><b>${esc(x.subject||x.title||"مبحث")}</b><small>${esc(x.chapter||x.topic||"")}</small></div><span class="chip ok">${fa(x.percent||0)}٪</span></div>`).join("")||'<div class="card empty">داده تسلط هنوز ثبت نشده است.</div>'}</div><div class="section-title"><h3>دستاوردها و افتخارات</h3></div><div class="list">${achievementHtml||'<div class="card empty">دستاوردی ثبت نشده است.</div>'}</div><div class="section-title"><h3>جلسات اخیر</h3></div><div class="list">${lessons.slice(0,12).map(x=>`<article class="card"><b>${esc(x.subject||"")} · ${esc(x.topic||"")}</b><p>${esc(x.content||"")}</p><small>${esc(x.date||"")}</small></article>`).join("")||'<div class="card empty">جلسه‌ای ثبت نشده است.</div>'}</div><div class="section-title"><h3>نمره‌های مستمر اخیر</h3></div><div class="list">${ass.slice(0,12).map(x=>`<div class="list-item"><div class="list-main"><b>${esc(x.subject||"")} · ${esc(x.category||"ارزیابی")}</b><small>${esc(x.date||x.at||"")}${x.note?`<br>${esc(x.note)}`:""}</small></div><span class="chip ok">${fa(x.score)} از ${fa(x.maxScore||20)}</span></div>`).join("")||'<div class="card empty">ارزیابی مستمری ثبت نشده است.</div>'}</div>`;
  }

  function renderMore() { const a=dashboard?.attendance||{},assessments=dashboard?.continuousAssessments||[],behavior=dashboard?.behaviorRecords||[],lessons=dashboard?.lessonLogs||[],termReport=dashboard?.termReport||{subjects:[],average:null}; $("page").innerHTML=`<div class="more-grid"><button class="more-item" data-more="schedule"><span>📅</span><small>برنامه هفتگی</small></button><button class="more-item" id="p57MoreLaunch"><span>🗓</span><small>تقویم آموزشی</small></button><button class="more-item" data-more="resources"><span>📚</span><small>منابع آموزشی</small></button><button class="more-item" id="p633ExamCenter" type="button"><span>📝</span><small>مرکز آزمون</small></button><button class="more-item" data-more="learning"><span>📈</span><small>یادگیری من</small></button><button class="more-item" data-more="appeals"><span>⚖</span><small>اعتراض‌ها</small></button><button class="more-item" data-more="family"><span>👪</span><small>خانواده و اولیا</small></button><button class="more-item" id="attendanceBtn"><span>🧑‍🏫</span><small>جزئیات حضور</small></button><button class="more-item" data-more="profile"><span>⚙</span><small>تنظیمات</small></button><button class="more-item" id="manualSyncBtn"><span>↻</span><small>همگام‌سازی</small></button></div><div class="section-title"><h3>وضعیت حضور</h3></div><div class="grid"><article class="card stat-card"><b>${fa(a.present)}</b><small>حاضر</small></article><article class="card stat-card"><b>${fa(a.absent)}</b><small>غیبت</small></article><article class="card stat-card"><b>${fa(a.late)}</b><small>تأخیر</small></article></div><div class="section-title"><h3>جلسه‌های اخیر کلاس</h3></div><div class="list">${lessons.slice(0,6).map(x=>`<div class="card"><div class="row between"><b>${esc(x.subject)} · ${esc(x.topic)}</b><span class="chip ok">${esc(x.date||"")}</span></div>${x.content?`<p>${esc(x.content)}</p>`:""}${x.homework?`<small>تکلیف: ${esc(x.homework)}</small>`:""}</div>`).join("")||'<div class="card empty">گزارش جلسه‌ای ثبت نشده است.</div>'}</div><div class="section-title"><h3>کارنامه پایان ترم</h3></div><div class="card"><div class="row between"><b>معدل دروس</b><span class="chip ok">${termReport.average===null?"—":fa(termReport.average)}</span></div><small style="display:block;margin:8px 0;color:var(--muted,#667085)">${termReport.gradingPolicy?.mode==="weighted"?`فرمول وزنی: ${fa(termReport.gradingPolicy.continuousWeight)}٪ مستمر + ${fa(termReport.gradingPolicy.finalWeight)}٪ آزمون پایانی`:"فرمول جمع سهم‌ها: مستمر + آزمون پایانی با سقف نمره مدرسه"}</small>${termReport.officialCard?`<div class="grid" style="margin:10px 0"><article class="card stat-card"><b>${termReport.disciplineScore===null?"—":fa(termReport.disciplineScore)}</b><small>انضباط</small></article><article class="card stat-card"><b>${termReport.cultivationScore===null?"—":fa(termReport.cultivationScore)}</b><small>پرورشی</small></article></div>`:""}<div class="list">${(termReport.completeSubjects||termReport.subjects||[]).map(r=>`<div class="list-item"><div class="list-main"><b>${esc(r.subject)}</b><small>مستمر: ${r.continuousScore===null||r.continuousScore===undefined?"—":fa(r.continuousScore)} · آزمون پایان‌ترم: ${r.finalExamScore===null||r.finalExamScore===undefined?"—":fa(r.finalExamScore)}${r.gradingMode==="weighted"&&r.finalExamNormalized!==null&&r.finalExamNormalized!==undefined?` · نرمال‌شده: ${fa(r.finalExamNormalized)}`:""}</small></div><span class="chip ${r.finalScore===null||r.finalScore===undefined?"":"info"}">${r.finalScore===null||r.finalScore===undefined?"ثبت نشده":fa(r.finalScore)}</span></div>`).join("")||'<div class="empty">هنوز درسی برای کارنامه ثبت نشده است.</div>'}</div>${termReport.officialCard?`<div class="card" style="margin-top:10px"><b>نظر معلم</b><p>${esc(termReport.teacherComment||"—")}</p><b>نظر مدیر</b><p>${esc(termReport.managerComment||"—")}</p></div>`:""}</div><div class="section-title"><h3>نمره‌های مستمر اخیر</h3></div><div class="list">${assessments.slice(0,8).map(x=>`<div class="list-item"><div class="list-icon">★</div><div class="list-main"><b>${esc(x.subject)} · ${esc(x.category||"فعالیت کلاسی")}</b><small>${esc(x.date||x.at||"")}${x.note?`<br>${esc(x.note)}`:""}</small></div><span class="chip ok">${fa(x.score)} از ${fa(x.maxScore)}</span></div>`).join("")||'<div class="card empty">نمره مستمری ثبت نشده است.</div>'}</div><div class="section-title"><h3>تشویق‌ها و بازخورد کلاسی</h3></div><div class="list">${behavior.slice(0,8).map(x=>`<div class="list-item"><div class="list-icon">${x.kind==="positive"?"🌟":x.kind==="negative"?"⚠️":"📝"}</div><div class="list-main"><b>${esc(x.category||"بازخورد")}</b><small>${esc(x.date||x.at||"")}<br>${esc(x.note||"")}</small></div><span class="chip ${x.kind==="positive"?"ok":x.kind==="negative"?"danger":"warn"}">${fa(x.points||0)}</span></div>`).join("")||'<div class="card empty">بازخوردی ثبت نشده است.</div>'}</div><div class="section-title"><h3>برنامه‌های پیگیری آموزشی</h3></div><div class="list">${(dashboard?.interventions||[]).map(x=>`<div class="card"><div class="row between"><b>${esc(x.title)}</b><span class="chip ${x.status==="done"?"ok":"warn"}">${esc({open:"باز",in_progress:"در حال اجرا",done:"انجام‌شده"}[x.status]||x.status)}</span></div><p>${esc(x.action||"")}</p>${x.dueDate?`<small>مهلت: ${esc(x.dueDate)}</small>`:""}</div>`).join("")||'<div class="card empty">برنامه پیگیری فعالی برایت ثبت نشده است.</div>'}</div>`; document.querySelectorAll("[data-more]").forEach(b=>b.onclick=()=>navigate(b.dataset.more)); $("p57MoreLaunch").onclick=showCalendarP57; $("manualSyncBtn").onclick=async()=>{try{await withNetwork("manual-sync",()=>syncDashboard());navigate("more");toast("اطلاعات از سرور به‌روز شد.","ok");}catch(e){toast(e.message||"همگام‌سازی انجام نشد.","danger");}}; $("attendanceBtn").onclick=()=>showAttendanceV19(); const p633Btn=$("p633ExamCenter"); if(p633Btn) p633Btn.onclick=()=>{const center=window.MadreseyarExamCenterP63; if(center&&typeof center.open==="function")center.open();else toast("مرکز آزمون بارگذاری نشده است؛ فایل p63-exam-center.js را بررسی کنید.","danger");}; }
  function showAttendanceV19(){const a=dashboard?.attendance||{},labels={present:"حاضر",absent:"غایب · در انتظار بررسی",absent_pending:"غایب · در انتظار بررسی",late:"تأخیر",excused:"غیبت موجه",absent_excused:"غیبت موجه",absent_unexcused:"غیبت غیرموجه"};openModal(`<div class="modal-head"><h3>جزئیات حضور و غیاب</h3><button class="close-btn" data-close>×</button></div><div class="grid"><article class="card stat-card"><b>${fa(a.present)}</b><small>حاضر</small></article><article class="card stat-card"><b>${fa(a.absent)}</b><small>غیبت</small></article><article class="card stat-card"><b>${fa(a.late)}</b><small>تأخیر</small></article></div><div class="list mt">${(a.recent||[]).map(r=>`<div class="list-item"><div class="list-icon">${r.status==="present"?"✓":r.status==="late"?"⏰":"!"}</div><div class="list-main"><b>${esc(r.subject||"جلسه کلاسی")}</b><small>${esc(r.date||r.at||"")}${r.note?` · ${esc(r.note)}`:""}</small></div><span class="chip ${r.status==="present"?"ok":r.status==="late"?"warn":"danger"}">${esc(labels[r.status]||r.status)}</span></div>`).join("")||'<div class="empty">جزئیات جلسه‌ای ثبت نشده است.</div>'}</div>`);}


  function renderFamilyV22(){
    const consents=dashboard?.consentForms||[],reports=dashboard?.progressReports||[];
    $("page").innerHTML=`<div class="section-title"><div><h3>رضایت‌نامه‌های مدرسه</h3><small class="muted">پاسخ حقوقی رضایت‌نامه فقط توسط ولی از پنل اولیا ثبت می‌شود.</small></div></div><div class="list">${consents.map(c=>`<article class="card"><div class="row between"><div><b>${esc(c.title)}</b><small>مهلت پاسخ: ${esc(c.dueDate||"ثبت نشده")}</small></div>${c.response?`<span class="chip ${c.response.decision==="approved"?"ok":"danger"}">${c.response.decision==="approved"?"موافقت ولی":"عدم موافقت ولی"}</span>`:'<span class="chip warn">در انتظار پاسخ ولی</span>'}</div><p>${esc(c.description||"")}</p>${c.response?`<small>ثبت‌شده توسط ${esc(c.response.guardianName||"ولی دانش‌آموز")} · ${esc(c.response.respondedAt||"")}</small>`:'<div class="notice">این رضایت‌نامه در پنل اولیا قابل پاسخ است و دانش‌آموز امکان ثبت پاسخ به‌جای ولی را ندارد.</div>'}</article>`).join("")||'<div class="card empty">رضایت‌نامه فعالی وجود ندارد.</div>'}</div><div class="section-title"><h3>گزارش‌های پیشرفت</h3></div><div class="list">${reports.map(r=>`<article class="card"><div class="row between"><div><b>${esc(r.title||r.period||"گزارش پیشرفت")}</b><small>${esc(r.publishedAt||r.createdAt||"")}</small></div><span class="chip ${r.acknowledgedAt?"ok":"warn"}">${r.acknowledgedAt?"مشاهده شد":"جدید"}</span></div><h4>جمع‌بندی</h4><p>${esc(r.summary||"—")}</p><div class="family-report-grid-v22"><div><b>نقاط قوت</b><small>${esc(r.strengths||"—")}</small></div><div><b>نیازمند تمرین</b><small>${esc(r.needsWork||"—")}</small></div></div>${r.nextSteps?`<div class="notice"><b>اقدام پیشنهادی خانه و مدرسه</b><br>${esc(r.nextSteps)}</div>`:""}${!r.acknowledgedAt?`<button class="btn secondary full" data-ack-progress-v22="${r.id}">تأیید مشاهده گزارش</button>`:""}</article>`).join("")||'<div class="card empty">گزارش پیشرفتی منتشر نشده است.</div>'}</div>`;
    document.querySelectorAll('[data-ack-progress-v22]').forEach(b=>b.onclick=async()=>{try{await withNetwork('progress-acknowledge',async()=>{await api('/api/student/progress/acknowledge',{method:'POST',body:JSON.stringify({reportId:b.dataset.ackProgressV22})});await syncDashboard(true);});renderFamilyV22();toast('مشاهده گزارش ثبت شد.','ok');}catch(e){toast(e.message,'danger');}});
  }
  function openConsentResponseV22(){toast("پاسخ رضایت‌نامه فقط از پنل اولیا مجاز است.","danger");}

  function profileValueV37(id){return ($(id)?.value||"").trim();}
  async function imageFileToDataUrlV37(file){
    if(!file)return ""; if(!/^image\/(jpeg|png|webp)$/i.test(file.type))throw new Error("فقط عکس JPG، PNG یا WebP مجاز است."); if(file.size>5*1024*1024)throw new Error("حجم فایل انتخابی بیش از ۵ مگابایت است.");
    const source=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error("خواندن عکس ناموفق بود."));r.readAsDataURL(file);});
    const img=await new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error("تصویر قابل خواندن نیست."));i.src=source;});
    const max=720,scale=Math.min(1,max/Math.max(img.width,img.height)),w=Math.max(1,Math.round(img.width*scale)),h=Math.max(1,Math.round(img.height*scale));
    const canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;const ctx=canvas.getContext("2d");ctx.drawImage(img,0,0,w,h);return canvas.toDataURL("image/jpeg",.82);
  }
  async function getCachedProfileV37(){return (await storeGet(CACHE_STORE,PROFILE_CACHE_ID))||null;}
  async function cacheProfileV37(profile,photoDataUrl,pendingSync=false,photoPending=false,removePhoto=false){const row={id:PROFILE_CACHE_ID,profile:{...(profile||{})},photoDataUrl:photoDataUrl||"",pendingSync:Boolean(pendingSync),photoPending:Boolean(photoPending),removePhoto:Boolean(removePhoto),savedAt:Date.now()};await storePut(CACHE_STORE,row);return row;}
  async function syncPendingProfileV37(){
    if(!token||!networkAllowed())return false;const cached=await getCachedProfileV37();if(!cached?.pendingSync)return false;
    try{const data=await api("/api/student/profile",{method:"POST",body:JSON.stringify({...cached.profile,photoDataUrl:cached.photoPending&&!cached.removePhoto?cached.photoDataUrl||undefined:undefined,removePhoto:Boolean(cached.removePhoto)})});await cacheProfileV37(data.student,data.photoDataUrl||cached.photoDataUrl,false,false,false);if(dashboard)dashboard.student={...dashboard.student,...data.student};return true;}catch{return false;}
  }
  async function renderProfile() {
    const serverStudent=dashboard?.student||{}; const cached=await getCachedProfileV37(); let photoDataUrl=cached?.photoDataUrl||""; if(!photoDataUrl&&token){try{const r=await withNetwork("student-profile-photo",()=>api("/api/student/profile/photo",{},true));photoDataUrl=String(r?.photoDataUrl||"");}catch{}}
    const s={...serverStudent,...(cached?.profile||{})}; const exams=await storeAll(EXAM_STORE),queue=await storeAll(QUEUE_STORE); const initials=esc((s.firstName||"د").slice(0,1));
    $("page").innerHTML=`<article class="card profile-hero-v37"><div class="profile-photo-wrap-v37"><div class="profile-photo-v37" id="profilePhotoPreviewV37">${photoDataUrl?`<img src="${photoDataUrl}" alt="عکس دانش‌آموز">`:`<span>${initials}</span>`}</div><label class="photo-action-v37"><input id="profilePhotoInputV37" type="file" accept="image/jpeg,image/png,image/webp" hidden><span>تغییر عکس</span></label><button class="photo-remove-v37" id="removeProfilePhotoV37" type="button">حذف</button></div><div><h3>${esc(`${s.firstName||""} ${s.lastName||""}`)}</h3><p class="muted">${esc(s.className||"")} · کد ${esc(s.studentCode||"")}</p><span class="sync-state-v37 ${cached?.pendingSync?'pending':'ok'}">${cached?.pendingSync?'ذخیره محلی؛ در انتظار همگام‌سازی':'همگام با سرور'}</span></div></article>
    <article class="card mt"><div class="section-title"><h3>مشخصات رسمی</h3></div><div class="profile-readonly-grid-v37"><div><small>نام و نام خانوادگی</small><b>${esc(`${s.firstName||""} ${s.lastName||""}`)}</b></div><div><small>کد ملی</small><b>${esc(s.nationalId||"—")}</b></div><div><small>تاریخ تولد</small><b>${esc(s.birthDate||"—")}</b></div><div><small>کد دانش‌آموزی</small><b>${esc(s.studentCode||"—")}</b></div><div><small>پایه</small><b>${esc(s.gradeName ? `${s.gradeName}${s.grade===7?" (هفتم)":s.grade===8?" (هشتم)":s.grade===9?" (نهم)":""}` : "—")}</b></div><div><small>کلاس</small><b>${esc(s.className||"—")}</b></div><div><small>سال تحصیلی</small><b>${esc(s.academicYear||"—")}</b></div></div><small class="field-hint">این اطلاعات رسمی از پرونده مدرسه می‌آیند و توسط دانش‌آموز قابل تغییر نیستند.</small></article>
    <article class="card mt"><div class="section-title"><h3>اطلاعات تماس</h3><small>این اطلاعات روی گوشی و سرور مدرسه ذخیره می‌شوند.</small></div><div class="profile-form-grid-v37"><label class="field"><span>موبایل دانش‌آموز</span><input id="studentMobileV37" inputmode="tel" maxlength="16" value="${esc(s.studentMobile||"")}" placeholder="09xxxxxxxxx"></label><label class="field"><span>ایمیل اختیاری</span><input id="studentEmailV37" type="email" maxlength="160" value="${esc(s.email||"")}" placeholder="name@example.com"></label><label class="field"><span>شماره موبایل ولی</span><input id="guardianMobileV37" inputmode="tel" maxlength="16" value="${esc(s.guardianMobile||"")}" placeholder="09xxxxxxxxx"></label><label class="field"><span>تلفن منزل</span><input id="homePhoneV37" inputmode="tel" maxlength="16" value="${esc(s.homePhone||"")}" placeholder="شماره ثابت"></label></div></article>
    <article class="card mt emergency-card-v37"><div class="section-title"><h3>تماس ضروری</h3><small>برای مواقع ضروری مدرسه</small></div><div class="profile-form-grid-v37"><label class="field"><span>نام فرد تماس اضطراری</span><input id="emergencyNameV37" maxlength="120" value="${esc(s.emergencyGuardianName||"")}" placeholder="نام و نام خانوادگی"></label><label class="field"><span>نسبت</span><select id="emergencyRelationV37"><option value="">انتخاب کنید</option>${['پدر','مادر','سرپرست','پدربزرگ','مادربزرگ','خواهر/برادر','سایر'].map(x=>`<option ${s.emergencyGuardianRelation===x?'selected':''}>${x}</option>`).join('')}</select></label><label class="field full-span-v37"><span>شماره تماس اضطراری ولی *</span><input id="emergencyMobileV37" inputmode="tel" maxlength="16" value="${esc(s.emergencyGuardianMobile||"")}" placeholder="09xxxxxxxxx" required></label></div></article>
    <article class="card mt"><div class="section-title"><h3>نشانی</h3></div><label class="field"><span>آدرس منزل</span><textarea id="studentAddressV37" rows="4" maxlength="600" placeholder="استان، شهر، خیابان، پلاک...">${esc(s.address||"")}</textarea></label><label class="field"><span>کد پستی</span><input id="postalCodeV37" inputmode="numeric" maxlength="10" value="${esc(s.postalCode||"")}" placeholder="۱۰ رقم"></label><button id="saveStudentProfileV37" class="btn primary full">ذخیره و همگام‌سازی پروفایل</button><small class="field-hint">اگر اینترنت قطع باشد، اطلاعات ابتدا روی همین دستگاه ذخیره می‌شود و پس از اتصال به سرور ارسال خواهد شد.</small></article>
    <article class="card mt"><div class="row between"><span>اتصال به سرور مدرسه</span><b>خودکار</b></div><small class="field-hint">برنامه به‌صورت ثابت به سرور رسمی مدرسه متصل می‌شود و نیازی به تنظیم آدرس نیست.</small><div class="row between mt"><span>آزمون دانلودشده</span><b>${fa(exams.length)}</b></div><div class="row between mt"><span>ارسال در انتظار</span><b>${fa(queue.length)}</b></div></article><article class="card mt"><button id="themeBtn" class="btn secondary full">تغییر حالت روشن / تیره</button><button id="clearDownloadsBtn" class="btn danger full mt">حذف آزمون‌های دانلودشده</button><button id="logoutProfileBtn" class="btn danger full mt">خروج از حساب</button></article>`;
    let selectedPhoto=photoDataUrl,removePhoto=false,photoDirty=false;
    $("profilePhotoInputV37").onchange=async e=>{try{selectedPhoto=await imageFileToDataUrlV37(e.target.files?.[0]);removePhoto=false;photoDirty=true;p44KnownPhoto=selectedPhoto;p44PaintPhoto(selectedPhoto);$("profilePhotoPreviewV37").innerHTML=`<img src="${selectedPhoto}" alt="عکس دانش‌آموز">`; }catch(err){toast(err.message,"danger");}};
    $("removeProfilePhotoV37").onclick=()=>{selectedPhoto="";removePhoto=true;photoDirty=true;p44KnownPhoto="";p44PaintPhoto("");$("profilePhotoPreviewV37").innerHTML=`<span>${initials}</span>`;};
    $("saveStudentProfileV37").onclick=async()=>{const profile={studentMobile:profileValueV37("studentMobileV37"),email:profileValueV37("studentEmailV37"),guardianMobile:profileValueV37("guardianMobileV37"),homePhone:profileValueV37("homePhoneV37"),emergencyGuardianName:profileValueV37("emergencyNameV37"),emergencyGuardianRelation:profileValueV37("emergencyRelationV37"),emergencyGuardianMobile:profileValueV37("emergencyMobileV37"),address:profileValueV37("studentAddressV37"),postalCode:normalizeDigits(profileValueV37("postalCodeV37")).slice(0,10)};if(!profile.emergencyGuardianMobile){toast("شماره تماس اضطراری ولی را وارد کنید.","danger");return;}const btn=$("saveStudentProfileV37");btn.disabled=true;btn.textContent="در حال ذخیره…";await cacheProfileV37({...s,...profile},selectedPhoto,true,photoDirty,removePhoto);try{const data=await withNetwork("profile-update",()=>api("/api/student/profile",{method:"POST",body:JSON.stringify({...profile,photoDataUrl:photoDirty&&selectedPhoto&&!removePhoto?selectedPhoto:undefined,removePhoto:photoDirty&&removePhoto})}));dashboard.student={...dashboard.student,...data.student};await cacheProfileV37(data.student,data.photoDataUrl||selectedPhoto||"",false,false,false);toast("پروفایل روی گوشی و سرور ذخیره شد.","ok");p44KnownPhoto=String(data.photoDataUrl||selectedPhoto||"");p44PaintPhoto(p44KnownPhoto);renderProfile();}catch(err){if(err.name==="TypeError"||/fetch/i.test(err.message)){toast("روی گوشی ذخیره شد؛ پس از اتصال با سرور همگام می‌شود.","ok");renderProfile();}else{toast(err.message,"danger");}}finally{if(btn){btn.disabled=false;btn.textContent="ذخیره و همگام‌سازی پروفایل";}}};
    $("themeBtn").onclick=toggleTheme; $("clearDownloadsBtn").onclick=async()=>{if(confirm("تمام آزمون‌های دانلودشده و پاسخ‌های نیمه‌کاره حذف شوند؟")){await storeClear(EXAM_STORE);await storeClear(DRAFT_STORE);toast("اطلاعات آفلاین حذف شد.","ok");renderProfile();}}; $("logoutProfileBtn").onclick=()=>{if(confirm("از حساب خارج می‌شوی؟"))logout();};
  }
  async function testConnectionAt(url){if(!networkAllowed())return false;try{const r=await fetch(`${url}/api/ping`,{cache:"no-store"});return r.ok;}catch{return false;}}
  function toggleTheme(){const dark=!document.body.classList.contains("dark");document.body.classList.toggle("dark",dark);localStorage.setItem(THEME_KEY,dark?"dark":"light");}

  // p57 — تقویم شمسی، فقط نمایش داده‌های موجود داشبورد.
  function p57Day(value){
    if(value===null||value===undefined||value==='')return null;
    const str=String(value).trim();
    const iso=/^(\d{4})-(\d{2})-(\d{2})/.exec(str);
    const d=iso?new Date(+iso[1],+iso[2]-1,+iso[3],12):new Date(value);
    if(!Number.isFinite(d.getTime()))return null;
    return new Date(d.getFullYear(),d.getMonth(),d.getDate(),12);
  }
  function p57Key(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
  const p57Persian=new Intl.DateTimeFormat('en-US-u-ca-persian',{year:'numeric',month:'numeric',day:'numeric'});
  function p57Parts(d){const parts=Object.fromEntries(p57Persian.formatToParts(d).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));return {y:parts.year,m:parts.month,d:parts.day};}
  function p57Events(){
    const out=[];
    const add=(date,title,type,detail)=>{const d=p57Day(date);if(d)out.push({key:p57Key(d),title:String(title||'رویداد'),type,detail:String(detail||'')});};
    (dashboard?.calendarEvents||[]).forEach(e=>{const start=p57Day(e.startDate),end=p57Day(e.endDate||e.startDate);if(!start)return;let current=new Date(start);let count=0;while(current<=(end||start)&&count++<45){add(current,e.title,'school',calendarTypeLabelV76(e.type));current.setDate(current.getDate()+1);}});
    (dashboard?.homework||[]).forEach(t=>add(t.dueAt,t.title||'تکلیف','task',(t.subject||'درس')+(t.submission?' · تحویل‌شده':' · در انتظار تحویل')));
    (dashboard?.exams||[]).forEach(e=>add(e.startAt,e.title||'آزمون','exam',(e.subject||'درس')+' · شروع آزمون'));
    return out;
  }
  function showCalendarP57(){
    const today=new Date(),base=p57Parts(today),events=p57Events();let year=base.y,month=base.m,selected=p57Key(today);
    openModal(`<section class="p57-calendar" dir="rtl" aria-label="تقویم آموزشی شمسی"><div class="modal-head"><div><h3>🗓 تقویم آموزشی من</h3><small>رویدادهای مدرسه، مهلت تکالیف و شروع آزمون‌ها</small></div><button class="close-btn" data-close aria-label="بستن">×</button></div><div class="p57-controls"><button id="p57Prev" type="button" aria-label="ماه قبل">‹</button><b id="p57Month"></b><button id="p57Next" type="button" aria-label="ماه بعد">›</button><button id="p57Today" type="button">امروز</button></div><div class="p57-week">${['ش','ی','د','س','چ','پ','ج'].map(x=>`<span>${x}</span>`).join('')}</div><div class="p57-grid" id="p57Grid"></div><div id="p57Details" class="p57-details" aria-live="polite"></div><p class="p57-footnote">رویدادها از آخرین اطلاعات دریافت‌شده مدرسه نمایش داده می‌شوند؛ تاریخ‌های بدون زمان معتبر در تقویم قرار نمی‌گیرند.</p></section>`);
    const monthFmt=new Intl.DateTimeFormat('fa-IR-u-ca-persian',{month:'long',year:'numeric'});
    function findDay(y,m,d){const estimate=new Date(y+620,11,1,12);for(let i=0;i<430;i++){const parts=p57Parts(estimate);if(parts.y===y&&parts.m===m&&parts.d===d)return new Date(estimate);estimate.setDate(estimate.getDate()+1);}return null;}
    function paint(){
      const first=findDay(year,month,1);if(!first){document.getElementById('p57Month').textContent='تاریخ در دسترس نیست';document.getElementById('p57Grid').innerHTML='';document.getElementById('p57Details').textContent='امکان محاسبه روزهای این ماه وجود ندارد.';return;}
      document.getElementById('p57Month').textContent=monthFmt.format(first);
      const next=month===12?findDay(year+1,1,1):findDay(year,month+1,1);
      const days=next?Math.round((next-first)/86400000):31;
      const offset=(first.getDay()+1)%7;
      let html='';for(let i=0;i<offset;i++)html+='<span class="p57-blank"></span>';
      for(let n=1;n<=days;n++){const d=findDay(year,month,n);if(!d)continue;const key=p57Key(d),items=events.filter(e=>e.key===key),isToday=key===p57Key(today);html+=`<button type="button" class="p57-day ${isToday?'is-today':''} ${key===selected?'is-selected':''}" data-p57-day="${key}" aria-label="${fa(n)}، ${fa(items.length)} رویداد"><span>${fa(n)}</span>${items.length?`<i aria-hidden="true"></i>`:''}</button>`;}
      document.getElementById('p57Grid').innerHTML=html;
      document.querySelectorAll('[data-p57-day]').forEach(b=>b.onclick=()=>{selected=b.dataset.p57Day;paint();});
      const chosen=events.filter(e=>e.key===selected);const date=p57Day(selected);
      document.getElementById('p57Details').innerHTML=`<h4>${date?esc(new Intl.DateTimeFormat('fa-IR-u-ca-persian',{dateStyle:'full'}).format(date)):'رویدادهای روز'}</h4>${chosen.length?chosen.map(e=>`<div class="p57-event"><span>${e.type==='task'?'📝':e.type==='exam'?'📋':'🏫'}</span><div><b>${esc(e.title)}</b><small>${esc(e.detail)}</small></div></div>`).join(''):'<p class="p57-empty">رویدادی برای این روز ثبت نشده است.</p>'}`;
    }
    document.getElementById('p57Prev').onclick=()=>{month--;if(month<1){month=12;year--;}selected='';paint();};
    document.getElementById('p57Next').onclick=()=>{month++;if(month>12){month=1;year++;}selected='';paint();};
    document.getElementById('p57Today').onclick=()=>{year=base.y;month=base.m;selected=p57Key(today);paint();};
    paint();
  }
  // p56 — مرکز اعلان‌ها: داده‌ها فقط از داشبورد دریافت می‌شوند.
  function p56NotificationRows(){
    const personal=(dashboard?.notifications||[]).map((n,i)=>({...n,_kind:'personal',_order:i,_date:n.at||n.createdAt||n.date||'',_read:Boolean(n.read)}));
    const school=(dashboard?.announcements||[]).map((n,i)=>({...n,_kind:'school',_order:i,_date:n.createdAt||n.at||n.date||'',_read:true}));
    return [...personal,...school].sort((a,b)=>String(b._date||'').localeCompare(String(a._date||'')));
  }
  function showNotifications(){
    const rows=p56NotificationRows();
    const unread=rows.filter(n=>n._kind==='personal'&&!n._read).length;
    const urgent=rows.filter(n=>n.priority==='urgent').length;
    openModal(`<section class="p56-center" dir="rtl" aria-label="مرکز اعلان‌های دانش‌آموز">
      <div class="modal-head"><div><h3>مرکز اعلان‌های من</h3><small>پیام‌ها و اطلاعیه‌های مدرسه</small></div><button class="close-btn" data-close aria-label="بستن">×</button></div>
      <div class="p56-summary"><span><b>${fa(rows.length)}</b> همه اعلان‌ها</span><span><b>${fa(unread)}</b> خوانده‌نشده</span><span><b>${fa(urgent)}</b> فوری</span></div>
      <div class="p56-tools"><div class="p56-filters" role="group" aria-label="فیلتر اعلان‌ها">
        <button type="button" data-p56-filter="all" aria-pressed="true">همه</button>
        <button type="button" data-p56-filter="unread" aria-pressed="false">خوانده‌نشده</button>
        <button type="button" data-p56-filter="urgent" aria-pressed="false">فوری</button>
        <button type="button" data-p56-filter="school" aria-pressed="false">اطلاعیه مدرسه</button>
      </div><label class="p56-search-label">جست‌وجو در اعلان‌ها<input id="p56Search" type="search" autocomplete="off" placeholder="عنوان یا متن اعلان…"></label></div>
      <div id="p56List" class="p56-list" aria-live="polite"></div>
      <button id="p56ReadAll" type="button" class="btn secondary full mt" ${unread?'':'disabled'}>علامت‌زدن اعلان‌های شخصی به‌عنوان خوانده‌شده</button>
      <p class="p56-note">اطلاعیه‌های عمومی مدرسه جدا از وضعیت خواندن اعلان‌های شخصی هستند. داده‌ها از آخرین همگام‌سازی پنل نمایش داده می‌شوند.</p>
    </section>`);
    const list=document.getElementById('p56List');
    const filters=[...document.querySelectorAll('[data-p56-filter]')];
    const search=document.getElementById('p56Search');
    let active='all';
    function paint(){
      const q=String(search?.value||'').trim().toLocaleLowerCase('fa');
      const found=rows.filter(n=>{
        const match=active==='all'||(active==='unread'&&n._kind==='personal'&&!n._read)||(active==='urgent'&&n.priority==='urgent')||(active==='school'&&n._kind==='school');
        return match&&(!q||String((n.title||'')+' '+(n.body||'')).toLocaleLowerCase('fa').includes(q));
      });
      list.innerHTML=found.length?found.map(n=>`<article class="p56-item ${n.priority==='urgent'?'p56-urgent':''}">
        <span class="p56-item-icon" aria-hidden="true">${n.priority==='urgent'?'!':n._kind==='school'?'▣':'✉'}</span>
        <div class="p56-item-main"><div class="p56-item-title"><b>${esc(n.title||'اعلان')}</b>${n._kind==='personal'&&!n._read?'<span class="p56-new">جدید</span>':''}</div>
        <p>${esc(n.body||'')}</p><small>${esc(String(n._date||''))} · ${n._kind==='school'?'اطلاعیه مدرسه':'اعلان شخصی'}</small></div>
      </article>`).join(''):'<div class="p56-empty">اعلانی با این شرایط پیدا نشد.</div>';
    }
    filters.forEach(btn=>btn.addEventListener('click',()=>{active=btn.dataset.p56Filter;filters.forEach(x=>x.setAttribute('aria-pressed',String(x===btn)));paint();}));
    search.addEventListener('input',paint);
    paint();
    document.getElementById('p56ReadAll').onclick=async()=>{
      const btn=document.getElementById('p56ReadAll');btn.disabled=true;
      try{
        await withNetwork('notifications-read',()=>api('/api/student/notifications/read',{method:'POST',body:'{}'}));
        (dashboard?.notifications||[]).forEach(n=>n.read=true);
        rows.forEach(n=>{if(n._kind==='personal')n._read=true;});
        updateNotificationBadge();
        const label=document.querySelector('.p56-summary span:nth-child(2) b');if(label)label.textContent=fa(0);
        paint();toast('اعلان‌های شخصی خوانده شدند.','ok');
      }catch(e){btn.disabled=false;toast(e.message||'ثبت وضعیت اعلان‌ها انجام نشد.','danger');}
    };
  }


  function bindGlobal() {
    history.replaceState({[STUDENT_NAV_KEY_V4528]:currentPage}, "", location.href);
    window.addEventListener("popstate", e=>{
      const target=e.state?.[STUDENT_NAV_KEY_V4528] || "home";
      navigate(target,{fromPop:true});
    });
    const back=$("pageBackBtn"); if(back) back.onclick=()=>{if(currentPage!=="home") history.back();};
    server = FIXED_SERVER; localStorage.setItem(SERVER_KEY, server); $("loginBtn").onclick = login; bindBirthDateInputs();
    $("bottomNav").querySelectorAll("button").forEach(b=>b.onclick=()=>navigate(b.dataset.page)); $("p57CalendarTopBtn").onclick=showCalendarP57; $("notificationsBtn").onclick=showNotifications; $("profileBtn").onclick=()=>navigate("profile");
    window.addEventListener("online",()=>{setSync("اتصال برقرار شد");if(token)syncDashboard(true).then(()=>{if(currentPage === "exams" || currentPage === "tasks" || currentPage === "home")navigate(currentPage,{fromPop:true});}).catch(()=>{});});
    window.addEventListener("offline",()=>{setSync("حالت محلی");});
    document.addEventListener("visibilitychange",()=>{
      if(document.visibilityState==="hidden"&&examSession)storePut(DRAFT_STORE,examSession.draft);
      if(document.visibilityState==="visible"&&token)syncDashboard(true).then(()=>{if(currentPage === "exams" || currentPage === "tasks" || currentPage === "home")navigate(currentPage,{fromPop:true});}).catch(()=>{});
    });
    // هر 60 ثانیه فقط وقتی اپ در پیش‌زمینه است، فهرست آزمون/تکلیف را تازه می‌کنیم.
    setInterval(()=>{if(token&&document.visibilityState==="visible")syncDashboard(true).then(()=>{if(currentPage === "exams" || currentPage === "tasks" || currentPage === "home")navigate(currentPage,{fromPop:true});}).catch(()=>{});},60000);
  }

  async function init() {
    bindGlobal(); if(localStorage.getItem(THEME_KEY)==="dark")document.body.classList.add("dark");
    setTimeout(()=>$("splash").classList.add("hidden"),650);
    if("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("./service-worker.js", { scope: "./" }).catch(()=>{});
    if(token){
      const cached=await storeGet(CACHE_STORE,"dashboard");
      if(cached?.data){dashboard=cached.data;setSync("حالت محلی");showApp();}
      else{token="";localStorage.removeItem(TOKEN_KEY);$("authView").classList.remove("hidden");$("authMessage").textContent="برای اولین استفاده یک‌بار احراز هویت کنید.";}
    }else{$("authView").classList.remove("hidden");const state=$("connectionState");if(state){state.className="connection offline-first";state.innerHTML='<span class="dot"></span><span>حالت محلی؛ اتصال هنگام ورود فعال می‌شود</span>';}}
  }
  init();

  // v42: branding synced from server
  async function loadBrandingV42(){if(!networkAllowed())return;try{const brandingServer=server;const r=await fetch(`${brandingServer}/api/branding`,{cache:"no-store"});const d=await r.json();if(!r.ok||!d.branding)return;const b=d.branding,h=b.headers?.student||{},top=document.querySelector('.topbar');if(!top)return;document.documentElement.style.setProperty('--student-brand-primary-v42',b.primaryColor||'#14233f');document.documentElement.style.setProperty('--student-brand-accent-v42',b.accentColor||'#4f7cff');const rawImage=String(h.imageDataUrl||'');let imageUrl=rawImage;try{if(rawImage&&rawImage.startsWith('/'))imageUrl=new URL(rawImage.replace(/^\/+/,''),brandingServer.endsWith('/')?brandingServer:`${brandingServer}/`).href;}catch{}const hasCopy=(h.showLogo!==false)||(h.showSchoolName!==false)||(h.showSubtitle!==false&&!!h.subtitle)||(h.showYear!==false&&!!d.school?.year);top.className=`topbar branded-v42 template-${h.template||'compact'} tone-${h.textTone||'light'}${imageUrl&&!hasCopy?' image-only-v43':''}`;top.style.minHeight=`${Math.min(190,Math.max(60,Number(h.height||78)))}px`;if(h.showImage!==false&&imageUrl){top.style.backgroundImage=imageUrl&&!hasCopy?`url("${imageUrl.replace(/"/g,'%22')}")`:`linear-gradient(90deg,rgba(13,27,51,.76),rgba(13,27,51,.25)),url("${imageUrl.replace(/"/g,'%22')}")`;top.style.backgroundSize=h.fit==='contain'?'contain':'cover';top.style.backgroundPosition=rawImage==='/assets/school-header-v43.jpg'?'center 34%':'center';}else top.style.backgroundImage='';let brand=document.getElementById('studentBrandV42');if(!brand){brand=document.createElement('div');brand.id='studentBrandV42';brand.className='student-brand-v42';top.insertBefore(brand,top.children[1]);}brand.innerHTML=`${h.showLogo!==false?`<span class="student-brand-logo-v42">${b.logoDataUrl?`<img src="${esc(b.logoDataUrl)}">`:'م'}</span>`:''}<span class="student-brand-copy-v42">${h.showSchoolName!==false?`<b>${esc(d.school?.name||'مدرسه')}</b>`:''}${h.showSubtitle!==false&&h.subtitle?`<small>${esc(h.subtitle)}</small>`:''}${h.showYear!==false&&d.school?.year?`<em>${esc(d.school.year)}</em>`:''}</span>`;brand.classList.toggle('hidden',!hasCopy);const old=document.querySelector('.topbar-title');if(old)old.classList.add('student-page-status-v42');}catch{}}


  /* ==================== MADRESEYAR v62 — EXAM AVAILABILITY CONSISTENCY ==================== */
  const V62_VERSION="v62-exam-availability-consistency";
  function availabilityMessageV62(state){
    return ({scheduled:"زمان شروع این آزمون هنوز نرسیده است.",ended:"زمان اجرای این آزمون به پایان رسیده است.",withdrawn:"این آزمون توسط مدرسه از دسترس خارج شده است.",stale:"نسخه ذخیره‌شده این آزمون قدیمی است و باید دوباره دریافت شود."})[state]||"این آزمون فعلاً قابل اجرا نیست.";
  }
  function availabilityStateV62(exam){
    const explicit=String(exam?.availabilityState||exam?.state||"").toLowerCase();
    if(["scheduled","running","ended","withdrawn"].includes(explicit))return explicit;
    const now=Number(dashboard?.serverTime)||Date.now(),start=exam?.startAt?new Date(exam.startAt).getTime():NaN,end=exam?.endAt?new Date(exam.endAt).getTime():NaN;
    if(Number.isFinite(end)&&now>=end)return "ended";
    if(Number.isFinite(start)&&now<start)return "scheduled";
    return "running";
  }
  async function reconcileExamAvailabilityV62(fresh){
    if(!fresh||!Array.isArray(fresh.exams))return {updated:0,blocked:0};
    const liveMap=new Map(fresh.exams.map(e=>[String(e.id),e]));
    const cached=await storeAll(EXAM_STORE);let updated=0,blocked=0;
    for(const row of cached){
      const live=liveMap.get(String(row.id));
      const localState=await getLocalExamState(row.id);
      if(localState?.status==="submitted")continue;
      if(!live){
        row.availabilityState="withdrawn";row.blockReason=availabilityMessageV62("withdrawn");row.lastServerCheckAt=Date.now();blocked++;updated++;await storePut(EXAM_STORE,row);continue;
      }
      const mismatch=Boolean(live.packageVersion&&row.packageVersion&&live.packageVersion!==row.packageVersion);
      row.serverPackageVersion=live.packageVersion||row.packageVersion||"";
      row.availabilityState=availabilityStateV62(live);
      row.availabilityRevision=Number(live.availabilityRevision||row.availabilityRevision||1);
      row.lastServerCheckAt=Date.now();
      row.exam={...row.exam,startAt:live.startAt||"",endAt:live.endAt||"",publicationState:live.publicationState||"",availabilityState:row.availabilityState,availabilityRevision:row.availabilityRevision};
      if(mismatch){row.stale=true;row.blockReason=availabilityMessageV62("stale");blocked++;}
      else if(row.availabilityState!=="running"){row.stale=false;row.blockReason=availabilityMessageV62(row.availabilityState);blocked++;}
      else{row.stale=false;row.blockReason="";}
      updated++;await storePut(EXAM_STORE,row);
    }
    return {updated,blocked};
  }
  const syncDashboardBeforeV62=syncDashboard;
  syncDashboard=async function(silent=false){
    await syncDashboardBeforeV62(silent);
    if(dashboard&&networkAllowed()){
      await reconcileExamAvailabilityV62(dashboard);
      await storePut(CACHE_STORE,{id:"dashboard",data:dashboard,savedAt:Date.now()});
    }
  };
  function showAvailabilityBlockV62(exam,state,hasDraft=false){
    const text=availabilityMessageV62(state);
    openModal(`<div class="receipt"><div class="receipt-icon">⛔</div><h3>آزمون فعلاً قابل اجرا نیست</h3><p class="muted">${esc(text)}</p>${hasDraft?'<div class="sync-banner mt">پاسخ نیمه‌کاره روی این دستگاه حفظ شده و پاک نشده است.</div>':''}<button class="btn secondary mt" data-close>بستن</button></div>`);
  }
  const downloadOrOpenExamBeforeV62=downloadOrOpenExam;
  downloadOrOpenExam=async function(examId){
    const live=findExam(examId),record=await storeGet(EXAM_STORE,examId),draft=await storeGet(DRAFT_STORE,examId);
    const state=live?availabilityStateV62(live):record?.availabilityState||"withdrawn";
    if(record?.stale){
      if(draft){showAvailabilityBlockV62(record.exam,"stale",true);return;}
      if(!networkAllowed()){showAvailabilityBlockV62(record.exam,"stale",false);return;}
      await storeDelete(EXAM_STORE,examId);
    }
    if(state!=="running"){
      showAvailabilityBlockV62(live||record?.exam,state,Boolean(draft));return;
    }
    return downloadOrOpenExamBeforeV62(examId);
  };
  const startExamBeforeV62=startExam;
  startExam=async function(exam,savedDraft=null){
    const state=availabilityStateV62(exam);
    if(state!=="running"){showAvailabilityBlockV62(exam,state,Boolean(savedDraft));return;}
    if(savedDraft&&savedDraft.packageVersion&&exam.packageVersion&&savedDraft.packageVersion!==exam.packageVersion){showAvailabilityBlockV62(exam,"stale",true);return;}
    const result=await startExamBeforeV62(exam,savedDraft);
    if(examSession?.draft){examSession.draft.packageVersion=exam.packageVersion||"";examSession.draft.availabilityRevision=Number(exam.availabilityRevision||1);await storePut(DRAFT_STORE,examSession.draft);}
    return result;
  };
  const renderExamsBeforeV62=renderExams;
  renderExams=async function(){
    await renderExamsBeforeV62();
    const rows=await storeAll(EXAM_STORE),blocked=rows.filter(x=>x.stale||["withdrawn","ended","scheduled"].includes(String(x.availabilityState||"")));
    if(blocked.length){
      const host=$("page");if(host&&!host.querySelector(".v62-local-block-notice"))host.insertAdjacentHTML("afterbegin",`<div class="offline-policy-note v62-local-block-notice">⚠ ${fa(blocked.length)} نسخه محلی به‌دلیل تغییر وضعیت/نسخه مدرسه قفل شده است. پاسخ‌های نیمه‌کاره حذف نشده‌اند.</div>`);
    }
  };
  window.__MSY_V62_STUDENT_TEST__={version:V62_VERSION,availabilityState:availabilityStateV62,message:availabilityMessageV62,reconcile:reconcileExamAvailabilityV62};

  /* ==================== MADRESEYAR v63 — RESUME & OFFLINE SUBMISSION SAFETY ==================== */
  const V63_VERSION="v63-resume-offline-submission-safety";
  async function sealDraftForOfflineDeliveryV63(record,draft,reason="timeout") {
    if(!record?.exam||!draft)return null;
    const exam=record.exam;
    const existing=(await storeAll(QUEUE_STORE)).find(x=>x.examId===exam.id);
    if(existing)return existing;
    const finalizedAt=Math.max(Number(draft.updatedAt||0),Math.min(Date.now(),Number(draft.expiresAt||Date.now())));
    const submissionKey=String(draft.submissionKey||uid("submission"));draft.submissionKey=submissionKey;draft.finalizedAt=finalizedAt;
    const common={answers:draft.answers||{},startedAt:Number(draft.startedAt||finalizedAt),finalizedAt,durationSeconds:Math.min(Math.max(0,Math.round((finalizedAt-Number(draft.startedAt||finalizedAt))/1000)),Math.max(60,Number(exam.duration||0)*60+60)),autoSubmitted:true,submissionKey,packageVersion:record.packageVersion||exam.packageVersion||"",attemptId:record.attemptId||exam.attemptId||"",packageSignature:record.packageSignature||exam.packageSignature||""};
    const payload=exam.type==="descriptive"?{...common,files:draft.files||[],sheetCode:exam.sheetCode||exam.examCode||""}:common;
    const item={id:uid("queue"),submissionKey,examId:exam.id,title:exam.title,kind:exam.type,payload,finalizedAt,createdAt:Date.now(),sealedReason:reason,retryCount:0};
    await storePut(QUEUE_STORE,item);
    await storePut(CACHE_STORE,{id:examStateId(exam.id),data:{status:"pending",examId:exam.id,submissionKey,queuedAt:Date.now(),finalizedAt,serverConfirmed:false,sealedReason:reason},savedAt:Date.now()});
    return item;
  }
  async function sealExpiredDraftsV63(){
    const drafts=await storeAll(DRAFT_STORE);let sealed=0;
    for(const draft of drafts){
      if(!draft?.examId||!draft.expiresAt||Date.now()<Number(draft.expiresAt))continue;
      const state=await getLocalExamState(draft.examId);if(state?.status==="submitted")continue;
      const record=await storeGet(EXAM_STORE,draft.examId);if(!record?.exam)continue;
      const item=await sealDraftForOfflineDeliveryV63(record,draft,"timeout_resume");if(item)sealed++;
    }
    return sealed;
  }
  const startExamBeforeV63=startExam;
  startExam=async function(exam,savedDraft=null){
    if(savedDraft?.expiresAt&&Date.now()>=Number(savedDraft.expiresAt)){
      const record=await storeGet(EXAM_STORE,exam.id);
      await sealDraftForOfflineDeliveryV63(record||{exam,packageVersion:exam.packageVersion,attemptId:exam.attemptId,packageSignature:exam.packageSignature},savedDraft,"expired_before_resume");
      examSession=null;clearInterval(examTimer);
      openModal(`<div class="receipt"><div class="receipt-icon">⏱</div><h3>زمان آزمون پایان یافته است</h3><p class="muted">پاسخ‌های ذخیره‌شده بدون تغییر در صف تحویل قرار گرفتند و پس از اتصال به مدرسه ارسال می‌شوند.</p><button class="btn secondary mt" data-close>بستن</button></div>`);
      return;
    }
    return startExamBeforeV63(exam,savedDraft);
  };
  const renderExamsBeforeV63=renderExams;
  renderExams=async function(){await sealExpiredDraftsV63();return renderExamsBeforeV63();};
  const syncQueueBeforeV63=syncQueue;
  syncQueue=async function(onlyExamId=""){await sealExpiredDraftsV63();return syncQueueBeforeV63(onlyExamId);};
  window.__MSY_V63_STUDENT_TEST__={version:V63_VERSION,sealDraft:sealDraftForOfflineDeliveryV63,sealExpiredDrafts:sealExpiredDraftsV63};


  /* ==================== MADRESEYAR v64 — STUDENT SUBMISSION DIAGNOSTICS ==================== */
  const V64_STUDENT_VERSION="v64-student-recovery-submission-diagnostics";
  function v64Date(ts){if(!Number(ts))return "—";try{return new Date(Number(ts)).toLocaleString("fa-IR");}catch{return "—";}}
  async function v64SubmissionDiagnosticsRows(){
    const queue=await storeAll(QUEUE_STORE), cache=await storeAll(CACHE_STORE), exams=dashboard?.exams||[];
    const rows=[];
    for(const item of queue){const ex=exams.find(e=>e.id===item.examId)||{};rows.push({examId:item.examId,title:item.title||ex.title||"آزمون",state:"pending",submissionKey:item.submissionKey||item.payload?.submissionKey||"",queuedAt:item.createdAt||0,finalizedAt:item.finalizedAt||item.payload?.finalizedAt||0,retryCount:Number(item.retryCount||0),lastTriedAt:item.lastTriedAt||0,lastError:item.lastError||"",lastErrorStatus:Number(item.lastErrorStatus||0),receiptId:""});}
    for(const rec of cache.filter(x=>String(x.id||"").startsWith("receipt_"))){const examId=String(rec.id).slice(8),r=rec.data||{},ex=exams.find(e=>e.id===examId)||{};if(rows.some(x=>x.examId===examId))continue;rows.push({examId,title:ex.title||"آزمون",state:"submitted",submissionKey:r.submissionKey||"",queuedAt:0,finalizedAt:r.finalizedAt||0,retryCount:Number(r.retryCount||0),lastTriedAt:0,lastError:"",lastErrorStatus:0,receiptId:r.receiptId||"",submittedAt:r.submittedAt||0,receiptHash:r.receiptHash||""});}
    return rows.sort((a,b)=>Number(b.submittedAt||b.finalizedAt||b.queuedAt)-Number(a.submittedAt||a.finalizedAt||a.queuedAt));
  }
  async function openSubmissionDiagnosticsV64(){
    const rows=await v64SubmissionDiagnosticsRows(),pending=rows.filter(x=>x.state==="pending").length,failed=rows.filter(x=>x.state==="pending"&&x.lastError).length,submitted=rows.filter(x=>x.state==="submitted").length;
    openModal(`<div class="modal-head"><div><h3>وضعیت تحویل آزمون‌ها</h3><small class="muted">v64 · اطلاعات این دستگاه و رسیدهای Server</small></div><button class="close-btn" data-close>×</button></div><div class="grid"><article class="card stat-card"><b>${fa(pending)}</b><small>در صف ارسال</small></article><article class="card stat-card"><b>${fa(failed)}</b><small>دارای خطای آخر</small></article><article class="card stat-card"><b>${fa(submitted)}</b><small>دارای رسید</small></article></div><div class="list v64-delivery-list">${rows.map(x=>`<article class="card"><div class="row between"><div><b>${esc(x.title)}</b><small>${x.state==="submitted"?`تحویل قطعی · ${esc(v64Date(x.submittedAt))}`:`پاسخ روی گوشی محفوظ · ${esc(v64Date(x.finalizedAt||x.queuedAt))}`}</small></div><span class="chip ${x.state==="submitted"?'ok':x.lastError?'danger':'warn'}">${x.state==="submitted"?'رسید Server':x.lastError?'نیاز به ارسال مجدد':'در انتظار ارسال'}</span></div>${x.state==="pending"?`<div class="v64-delivery-meta"><span>تلاش ارسال: <b>${fa(x.retryCount)}</b></span><span>آخرین تلاش: <b>${esc(v64Date(x.lastTriedAt))}</b></span></div>${x.lastError?`<div class="offline-banner"><b>آخرین خطا${x.lastErrorStatus?` (${fa(x.lastErrorStatus)})`:''}</b><br>${esc(x.lastError)}</div>`:''}<button class="btn primary full" data-v64-retry="${esc(x.examId)}">ارسال مجدد همین آزمون</button>`:`<div class="v64-delivery-meta"><span>شماره رسید: <b>${esc(x.receiptId||'ثبت‌شده')}</b></span>${x.receiptHash?`<span>هش: <b dir="ltr">${esc(x.receiptHash.slice(0,20))}…</b></span>`:''}</div>`}</article>`).join('')||'<div class="card empty">هنوز تحویل آزمونی روی این دستگاه ثبت نشده است.</div>'}</div>`);
    document.querySelectorAll('[data-v64-retry]').forEach(b=>b.onclick=async()=>{await retryExamSubmission(b.dataset.v64Retry);closeModal();await openSubmissionDiagnosticsV64();});
  }
  const renderMoreBeforeV64=renderMore;
  renderMore=function(){renderMoreBeforeV64();const grid=document.querySelector('.more-grid');if(grid&&!grid.querySelector('#submissionDiagnosticsV64')){const b=document.createElement('button');b.className='more-item';b.id='submissionDiagnosticsV64';b.innerHTML='<span>📡</span><small>وضعیت تحویل آزمون</small>';grid.appendChild(b);b.onclick=()=>openSubmissionDiagnosticsV64();}};
  window.__MSY_V64_STUDENT_DIAGNOSTICS_TEST__={version:V64_STUDENT_VERSION,rows:v64SubmissionDiagnosticsRows};

  /* ==================== MADRESEYAR v65 — STUDENT DELIVERY RECOVERY ==================== */
  const V65_STUDENT_VERSION="v65-exam-delivery-recovery-actions";
  function v65RecoveryForItem(item){
    const rows=dashboard?.deliveryRecoveryRequests||[],key=String(item?.submissionKey||item?.payload?.submissionKey||"");
    return rows.find(r=>r.examId===item?.examId&&r.submissionKey===key&&["pending","approved"].includes(r.status))||null;
  }
  async function requestDeliveryRecoveryV65(examId){
    const item=(await storeAll(QUEUE_STORE)).find(x=>x.examId===examId);if(!item){toast("این آزمون دیگر در صف ارسال نیست.","ok");return;}
    try{
      await withNetwork("delivery-recovery-request",async()=>{
        await api("/api/student/exam-delivery-recovery/request",{method:"POST",body:JSON.stringify({examId:item.examId,submissionKey:item.submissionKey||item.payload?.submissionKey||"",packageVersion:item.payload?.packageVersion||"",finalizedAt:Number(item.finalizedAt||item.payload?.finalizedAt||0),queuedAt:Number(item.createdAt||0),retryCount:Number(item.retryCount||0),lastError:item.lastError||"",lastErrorStatus:Number(item.lastErrorStatus||0)})});
        await syncDashboard(true);
      });
      toast("درخواست بررسی برای مدرسه ثبت شد. پاسخ‌های شما روی گوشی بدون تغییر محفوظ است.","ok");
    }catch(e){toast(e.message||"ثبت درخواست بررسی انجام نشد.","danger");}
  }
  const syncQueueBeforeV65=syncQueue;
  syncQueue=async function(onlyExamId=""){
    const queue=await storeAll(QUEUE_STORE),targets=onlyExamId?queue.filter(x=>x.examId===onlyExamId):queue;
    for(const item of targets){const r=v65RecoveryForItem(item);if(r?.status==="approved"&&Number(r.expiresAt||0)>Date.now()){item.payload ||= {};item.payload.recoveryRequestId=r.id;await storePut(QUEUE_STORE,item);}}
    return syncQueueBeforeV65(onlyExamId);
  };
  const openDiagBeforeV65=openSubmissionDiagnosticsV64;
  openSubmissionDiagnosticsV64=async function(){
    const rows=await v64SubmissionDiagnosticsRows(),queue=await storeAll(QUEUE_STORE),recoveries=dashboard?.deliveryRecoveryRequests||[];
    const pending=rows.filter(x=>x.state==="pending").length,failed=rows.filter(x=>x.state==="pending"&&x.lastError).length,submitted=rows.filter(x=>x.state==="submitted").length;
    openModal(`<div class="modal-head"><div><h3>وضعیت تحویل و Recovery آزمون‌ها</h3><small class="muted">v65 · پاسخ‌ها روی دستگاه می‌مانند؛ فقط metadata خطا برای مدرسه ارسال می‌شود.</small></div><button class="close-btn" data-close>×</button></div><div class="grid"><article class="card stat-card"><b>${fa(pending)}</b><small>در صف ارسال</small></article><article class="card stat-card"><b>${fa(failed)}</b><small>دارای خطای آخر</small></article><article class="card stat-card"><b>${fa(submitted)}</b><small>دارای رسید</small></article></div><div class="list v64-delivery-list">${rows.map(x=>{const item=queue.find(q=>q.examId===x.examId),key=x.submissionKey||item?.submissionKey||item?.payload?.submissionKey||"",rec=recoveries.find(r=>r.examId===x.examId&&r.submissionKey===key&&!["rejected","resolved","consumed"].includes(r.status));return `<article class="card"><div class="row between"><div><b>${esc(x.title)}</b><small>${x.state==="submitted"?`تحویل قطعی · ${esc(v64Date(x.submittedAt))}`:`پاسخ Seal‌شده روی گوشی · ${esc(v64Date(x.finalizedAt||x.queuedAt))}`}</small></div><span class="chip ${x.state==='submitted'?'ok':rec?.status==='approved'?'ok':x.lastError?'danger':'warn'}">${x.state==='submitted'?'رسید Server':rec?.status==='approved'?'مجوز Retry صادر شد':rec?.status==='pending'?'در انتظار بررسی مدرسه':x.lastError?'نیاز به پیگیری':'در انتظار ارسال'}</span></div>${x.state==='pending'?`<div class="v64-delivery-meta"><span>تلاش ارسال: <b>${fa(x.retryCount)}</b></span><span>آخرین تلاش: <b>${esc(v64Date(x.lastTriedAt))}</b></span></div>${x.lastError?`<div class="offline-banner"><b>آخرین خطا${x.lastErrorStatus?` (${fa(x.lastErrorStatus)})`:''}</b><br>${esc(x.lastError)}</div>`:''}${rec?.status==='approved'?`<div class="offline-banner"><b>مجوز مدرسه فعال است</b><br>فقط همین پاسخ نهایی‌شده و همین نسخه آزمون قابل Retry است.</div><button class="btn primary full" data-v65-retry="${esc(x.examId)}">ارسال مجدد با مجوز</button>`:rec?.status==='pending'?'<div class="notice info">درخواست شما ثبت شده و منتظر بررسی مدرسه است.</div>':`<div class="row"><button class="btn primary" data-v64-retry="${esc(x.examId)}">تلاش مجدد</button>${x.lastError?`<button class="btn outline" data-v65-request="${esc(x.examId)}">درخواست بررسی مدرسه</button>`:''}</div>`}`:`<div class="v64-delivery-meta"><span>شماره رسید: <b>${esc(x.receiptId||'ثبت‌شده')}</b></span>${x.receiptHash?`<span>هش: <b dir="ltr">${esc(x.receiptHash.slice(0,20))}…</b></span>`:''}</div>`}</article>`;}).join('')||'<div class="card empty">هنوز تحویل آزمونی روی این دستگاه ثبت نشده است.</div>'}</div>`);
    document.querySelectorAll('[data-v64-retry],[data-v65-retry]').forEach(b=>b.onclick=async()=>{await retryExamSubmission(b.dataset.v64Retry||b.dataset.v65Retry);closeModal();await syncDashboard(true);await openSubmissionDiagnosticsV64();});
    document.querySelectorAll('[data-v65-request]').forEach(b=>b.onclick=async()=>{await requestDeliveryRecoveryV65(b.dataset.v65Request);closeModal();await openSubmissionDiagnosticsV64();});
  };
  window.__MSY_V65_STUDENT_RECOVERY_TEST__={version:V65_STUDENT_VERSION,recoveryForItem:v65RecoveryForItem};

  /* ==================== MADRESEYAR v66 — STUDENT EXAM INCIDENTS ==================== */
  const V66_STUDENT_VERSION="v66-student-exam-incident-fairness-control";
  const V66_INCIDENT_PREFIX="exam_incident_v66_";
  function v66IncidentId(){return `cei_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,9)}`;}
  async function saveLocalIncidentV66(examId,type,description=""){
    if(!examId)return null;const id=v66IncidentId(),row={id:V66_INCIDENT_PREFIX+id,data:{clientEventId:id,examId,type,description:String(description||"").slice(0,600),clientAt:Date.now(),networkOnline:navigator.onLine,visibility:document.visibilityState,appVersion:V66_STUDENT_VERSION,sessionKey:String(examSession?.submissionKey||examSession?.grantToken||examId).slice(0,120),clientSeq:Date.now()},savedAt:Date.now()};await storePut(CACHE_STORE,row);return row.data;
  }
  async function syncIncidentsV66(){
    if(!networkAllowed())return;const rows=(await storeAll(CACHE_STORE)).filter(x=>String(x.id||"").startsWith(V66_INCIDENT_PREFIX));
    for(const row of rows){try{await api('/api/student/exam-incidents',{method:'POST',body:JSON.stringify(row.data||{})});await storeDelete(CACHE_STORE,row.id);}catch(e){if(e.status===404||e.status===400)await storeDelete(CACHE_STORE,row.id);}}
  }
  async function reportIncidentV66(){
    const exams=(dashboard?.exams||[]).filter(e=>e.studentStatus!=='submitted');if(!exams.length){toast('آزمونی برای ثبت رخداد فنی وجود ندارد.','danger');return;}
    const options=exams.map((e,i)=>`${i+1}) ${e.title}`).join('\n'),raw=prompt(`شماره آزمون را وارد کنید:\n${options}`,'1');if(raw===null)return;const exam=exams[Number(raw)-1];if(!exam)return toast('آزمون انتخاب‌شده معتبر نیست.','danger');
    const typeRaw=prompt('نوع رخداد: 1 قطع اینترنت، 2 بسته/باز شدن برنامه، 3 خرابی بسته آزمون، 4 خطای ارسال، 5 سایر','1');if(typeRaw===null)return;const type={1:'network_disconnect',2:'app_restart',3:'package_error',4:'submission_error',5:'other'}[Number(typeRaw)]||'other';const desc=prompt('شرح کوتاه رخداد را بنویسید:','')??'';
    const data=await saveLocalIncidentV66(exam.id,type,desc);try{await syncIncidentsV66();await syncDashboard(true);toast('گزارش فنی برای مدرسه ثبت شد. ثبت Incident به‌تنهایی زمان اضافه ایجاد نمی‌کند.','ok');}catch(_){toast('گزارش روی گوشی ذخیره شد و با اولین اتصال ارسال می‌شود.','ok');}return data;
  }
  window.addEventListener('offline',()=>{if(examSession?.exam?.id)saveLocalIncidentV66(examSession.exam.id,'network_disconnect','قطع اتصال شبکه هنگام اجرای آزمون').catch(()=>{});});
  window.addEventListener('online',()=>{if(examSession?.exam?.id)saveLocalIncidentV66(examSession.exam.id,'other','NETWORK_RESTORED').catch(()=>{});syncIncidentsV66().catch(()=>{});});
  const syncDashboardBeforeV66=syncDashboard;syncDashboard=async function(silent=false){const r=await syncDashboardBeforeV66(silent);try{await syncIncidentsV66();}catch(_){}return r;};
  const renderMoreBeforeV66=renderMore;renderMore=function(){renderMoreBeforeV66();const grid=document.querySelector('.more-grid');if(grid&&!grid.querySelector('#examIncidentV66')){const b=document.createElement('button');b.className='more-item';b.id='examIncidentV66';b.innerHTML='<span>🛟</span><small>گزارش مشکل فنی آزمون</small>';grid.appendChild(b);b.onclick=()=>reportIncidentV66();}};
  window.__MSY_V66_STUDENT_INCIDENT_TEST__={version:V66_STUDENT_VERSION,saveLocal:saveLocalIncidentV66,sync:syncIncidentsV66};


  /* ==================== MADRESEYAR v69 — STUDENT EXAM UX & SYNC CONFIDENCE ==================== */
  const V69_STUDENT_VERSION="v69-student-exam-ux-sync-confidence";
  let v69LastSavedAt=0, v69Saving=false, v69Warn5=false, v69Warn1=false;

  function v69FmtClock(at){
    if(!at)return "هنوز ذخیره نشده";
    try{return new Date(Number(at)).toLocaleTimeString("fa-IR",{hour:"2-digit",minute:"2-digit",second:"2-digit"});}catch(_){return "ذخیره شد";}
  }
  function v69StatusText(){
    if(v69Saving)return {text:"در حال ذخیره…",kind:"saving"};
    if(!navigator.onLine)return {text:`آفلاین · روی دستگاه ذخیره شد ${v69LastSavedAt?`(${v69FmtClock(v69LastSavedAt)})`:""}`,kind:"offline"};
    return {text:v69LastSavedAt?`ذخیره شد · ${v69FmtClock(v69LastSavedAt)}`:"ذخیره خودکار فعال",kind:"saved"};
  }
  function v69RefreshExamConfidence(){
    if(!examSession)return;
    const host=document.getElementById("v69ExamConfidence"); if(host){const s=v69StatusText();host.className=`v69-exam-confidence ${s.kind}`;host.innerHTML=`<span class="v69-dot"></span><b>${esc(s.text)}</b><small>${navigator.onLine?"اتصال برقرار است":"پاسخ‌ها روی همین دستگاه محفوظ می‌مانند"}</small>`;}
    const timer=document.getElementById("examTimer");
    if(timer){
      const remain=Math.max(0,Number(examSession.draft?.expiresAt||0)-Date.now());
      timer.classList.toggle("v69-timer-warn",remain<=5*60*1000&&remain>60*1000);
      timer.classList.toggle("v69-timer-danger",remain<=60*1000);
      if(remain<=5*60*1000&&!v69Warn5){v69Warn5=true;toast("۵ دقیقه یا کمتر تا پایان آزمون باقی مانده است.","danger");}
      if(remain<=60*1000&&!v69Warn1){v69Warn1=true;toast("کمتر از یک دقیقه تا پایان آزمون باقی مانده است.","danger");}
    }
  }

  const renderExamScreenBeforeV69=renderExamScreen;
  renderExamScreen=function(){
    renderExamScreenBeforeV69();
    if(!examSession)return;
    const toolbar=document.querySelector(".exam-toolbar");
    if(toolbar&&!document.getElementById("v69ExamConfidence")){
      const s=v69StatusText(), box=document.createElement("div");
      box.id="v69ExamConfidence";box.className=`v69-exam-confidence ${s.kind}`;
      box.innerHTML=`<span class="v69-dot"></span><b>${esc(s.text)}</b><small>${navigator.onLine?"اتصال برقرار است":"پاسخ‌ها روی همین دستگاه محفوظ می‌مانند"}</small>`;
      toolbar.appendChild(box);
    }
    const finish=document.getElementById("finishExamBtn");
    if(finish&&!document.getElementById("v69FinalHint")){
      const hint=document.createElement("small");hint.id="v69FinalHint";hint.className="v69-final-hint";hint.textContent="ارسال نهایی پاسخ‌ها را قفل می‌کند؛ قبل از ارسال، تعداد پاسخ‌های ثبت‌شده را بررسی کنید.";finish.parentElement?.insertBefore(hint,finish);
    }
    v69RefreshExamConfidence();
  };

  const saveDraftAndRenderBeforeV69=saveDraftAndRender;
  saveDraftAndRender=async function(){
    v69Saving=true;v69RefreshExamConfidence();
    try{
      await saveDraftAndRenderBeforeV69();
      v69LastSavedAt=Date.now();
    }finally{
      v69Saving=false;
      v69RefreshExamConfidence();
    }
  };

  const updateTimerBeforeV69=updateTimer;
  updateTimer=function(){updateTimerBeforeV69();v69RefreshExamConfidence();};

  window.addEventListener("beforeunload",e=>{
    if(!examSession)return;
    const finalized=Boolean(examSession.draft?.finalizedAt);
    if(finalized)return;
    e.preventDefault();
    e.returnValue="";
  });
  window.addEventListener("pagehide",()=>{
    if(examSession?.draft&&!examSession.draft.finalizedAt){
      examSession.draft.updatedAt=Date.now();
      storePut(DRAFT_STORE,examSession.draft).then(()=>{v69LastSavedAt=Date.now();}).catch(()=>{});
    }
  });
  window.addEventListener("online",()=>setTimeout(v69RefreshExamConfidence,0));
  window.addEventListener("offline",()=>setTimeout(v69RefreshExamConfidence,0));

  window.__MSY_V69_STUDENT_UX_TEST__={
    version:V69_STUDENT_VERSION,
    status:v69StatusText,
    refresh:v69RefreshExamConfidence
  };


  /* ==================== MADRESEYAR v70 — STUDENT ANSWER REVIEW ==================== */
  const V70_STUDENT_VERSION="v70-student-exam-navigation-answer-review";

  function v70ReviewRows(){
    if(!examSession)return [];
    const {exam,draft}=examSession;
    return (exam.questions||[]).map((q,index)=>({
      q,index,
      answered:v54QuestionAnswered(q,draft.answers||{}),
      flagged:Boolean(draft.flagged?.[q.id])
    }));
  }
  function v70JumpToQuestion(index){
    if(!examSession)return;
    closeModal();
    const {exam,draft}=examSession;
    if(exam.type==="descriptive"){
      const target=document.querySelector(`[data-answer-q="${CSS.escape(String(exam.questions[index]?.id||""))}"]`);
      if(target){target.scrollIntoView({behavior:"smooth",block:"center"});setTimeout(()=>target.focus(),250);}
      return;
    }
    draft.currentIndex=index;
    saveDraftAndRender();
  }
  function v70OpenReview(){
    if(!examSession)return;
    const rows=v70ReviewRows(), answered=rows.filter(x=>x.answered).length, unanswered=rows.length-answered, flagged=rows.filter(x=>x.flagged).length;
    openModal(`<div class="modal-head"><div><h3>مرور پاسخ‌ها قبل از ارسال</h3><small class="muted">هنوز چیزی ارسال نشده؛ می‌توانی به سؤال‌ها برگردی و پاسخ را اصلاح کنی.</small></div><button class="close-btn" data-close>×</button></div>
      <div class="v70-review-stats"><article><b>${fa(answered)}</b><small>پاسخ‌داده‌شده</small></article><article class="${unanswered?"warn":""}"><b>${fa(unanswered)}</b><small>بی‌پاسخ</small></article><article><b>${fa(flagged)}</b><small>علامت‌گذاری‌شده</small></article></div>
      <div class="v70-review-list">${rows.map(x=>`<button type="button" class="v70-review-row ${x.answered?"answered":"unanswered"} ${x.flagged?"flagged":""}" data-v70-jump="${x.index}"><span>${fa(x.index+1)}</span><div><b>${esc(String(x.q.text||"").slice(0,80))}${String(x.q.text||"").length>80?"…":""}</b><small>${x.answered?"پاسخ ثبت شده":"بدون پاسخ"}${x.flagged?" · علامت‌گذاری‌شده":""}</small></div><i>←</i></button>`).join("")}</div>
      ${unanswered?`<div class="notice warn"><b>${fa(unanswered)} سؤال بی‌پاسخ است.</b> اگر عمدی نیست، قبل از ارسال به آن‌ها برگرد.</div>`:`<div class="notice info">همه سؤال‌ها پاسخ ثبت‌شده دارند.</div>`}
      <div class="v70-review-actions"><button class="btn secondary" data-close>بازگشت به آزمون</button><button class="btn primary" id="v70ConfirmSubmit">${unanswered?"ارسال با وجود سؤال بی‌پاسخ":"تأیید و ارسال نهایی"}</button></div>`);
    document.querySelectorAll("[data-v70-jump]").forEach(b=>b.onclick=()=>v70JumpToQuestion(Number(b.dataset.v70Jump)));
    const submit=document.getElementById("v70ConfirmSubmit");
    if(submit)submit.onclick=()=>{closeModal();finalSubmitExam(false);};
  }

  const renderExamScreenBeforeV70=renderExamScreen;
  renderExamScreen=function(){
    renderExamScreenBeforeV70();
    const finish=document.getElementById("finishExamBtn");
    if(finish){
      finish.textContent="مرور پاسخ‌ها و ارسال نهایی";
      finish.onclick=v70OpenReview;
    }
  };

  window.__MSY_V70_STUDENT_REVIEW_TEST__={
    version:V70_STUDENT_VERSION,
    rows:v70ReviewRows,
    open:v70OpenReview,
    jump:v70JumpToQuestion
  };


  /* ==================== MADRESEYAR v71 — STUDENT ACCESSIBILITY & MOBILE TOUCH ==================== */
  const V71_STUDENT_VERSION="v71-student-exam-accessibility-mobile-touch";

  function v71EnhanceExamA11y(){
    if(!examSession)return;
    document.querySelectorAll("[data-qnav]").forEach((b,i)=>{
      b.setAttribute("aria-label",`رفتن به سؤال ${i+1}`);
      if(Number(examSession.draft?.currentIndex||0)===i)b.setAttribute("aria-current","step");else b.removeAttribute("aria-current");
    });
    document.querySelectorAll(".option").forEach((label,i)=>{
      label.setAttribute("role","presentation");
      const input=label.querySelector("input");
      if(input&&!input.getAttribute("aria-label")){
        const txt=label.querySelector("span")?.textContent?.trim();
        if(txt)input.setAttribute("aria-label",txt);
      }
    });
    const prev=document.getElementById("prevQ"), next=document.getElementById("nextQ"), flag=document.getElementById("flagQ");
    if(prev)prev.setAttribute("aria-label","سؤال قبلی");
    if(next)next.setAttribute("aria-label","سؤال بعدی");
    if(flag)flag.setAttribute("aria-pressed",String(Boolean(examSession.draft?.flagged?.[examSession.exam?.questions?.[examSession.draft?.currentIndex||0]?.id])));
  }

  const renderExamScreenBeforeV71=renderExamScreen;
  renderExamScreen=function(){
    renderExamScreenBeforeV71();
    v71EnhanceExamA11y();
  };

  function v71ViewportInset(){
    const vv=window.visualViewport;
    if(!vv){document.documentElement.style.setProperty("--v71-keyboard-inset","0px");return;}
    const inset=Math.max(0,window.innerHeight-vv.height-vv.offsetTop);
    document.documentElement.style.setProperty("--v71-keyboard-inset",`${Math.round(inset)}px`);
  }
  if(window.visualViewport){
    window.visualViewport.addEventListener("resize",v71ViewportInset);
    window.visualViewport.addEventListener("scroll",v71ViewportInset);
  }
  window.addEventListener("resize",v71ViewportInset);
  v71ViewportInset();

  window.__MSY_V71_STUDENT_A11Y_TEST__={
    version:V71_STUDENT_VERSION,
    enhance:v71EnhanceExamA11y,
    viewport:v71ViewportInset
  };


  /* ==================== MADRESEYAR v72 — STUDENT EXAM PROGRESS & RESUME CLARITY ==================== */
  const V72_STUDENT_VERSION="v72-student-exam-progress-resume-clarity";

  function v72ResumeInfo(exam,draft){
    const questions=Array.isArray(exam?.questions)?exam.questions:[];
    const answers=draft?.answers||{};
    const answered=questions.filter(q=>v54QuestionAnswered(q,answers)).length;
    const total=questions.length,remaining=Math.max(0,total-answered);
    const idx=Math.max(0,Math.min(Math.max(0,total-1),Number(draft?.currentIndex||0)));
    const lastSaved=Number(draft?.updatedAt||draft?.startedAt||0);
    const expiresAt=Number(draft?.expiresAt||0);
    const remainMs=expiresAt?Math.max(0,expiresAt-Date.now()):0;
    const versionKnown=Boolean(draft?.packageVersion&&exam?.packageVersion);
    const versionMatch=!versionKnown||String(draft.packageVersion)===String(exam.packageVersion);
    return {answered,total,remaining,currentIndex:idx,lastSaved,expiresAt,remainMs,expired:Boolean(expiresAt&&Date.now()>=expiresAt),versionMatch};
  }
  function v72TimeLeft(ms){
    if(ms<=0)return "پایان یافته";
    const min=Math.floor(ms/60000),sec=Math.floor((ms%60000)/1000);
    return `${fa(min)} دقیقه و ${fa(sec)} ثانیه`;
  }
  const openExamIntroBeforeV72=openExamIntro;
  openExamIntro=async function(exam){
    const v60Problems=validateExamPackageV60(exam);
    if(v60Problems.length){showExamPackageProblemV60(exam,v60Problems);return;}
    const draft=await storeGet(DRAFT_STORE,exam.id);
    if(!draft)return openExamIntroBeforeV72(exam);
    const info=v72ResumeInfo(exam,draft);
    const lastSaved=info.lastSaved?new Date(info.lastSaved).toLocaleString("fa-IR"):"نامشخص";
    const syncLabel=info.versionMatch?"نسخه ذخیره‌شده با بسته فعلی هماهنگ است":"نسخه محلی با بسته فعلی هم‌خوان نیست";
    const syncClass=info.versionMatch?"ok":"warn";
    openModal(`<div class="modal-head"><div><h3>${esc(exam.title)}</h3><small class="muted">ادامه آزمون نیمه‌کاره</small></div><button class="close-btn" data-close>×</button></div>
      <div class="v72-resume-summary"><article><b>${fa(info.answered)}</b><small>پاسخ ثبت‌شده</small></article><article><b>${fa(info.remaining)}</b><small>سؤال باقی‌مانده</small></article><article><b>${fa(info.currentIndex+1)}</b><small>محل ادامه</small></article></div>
      <div class="card v72-resume-details"><div class="list"><div class="row between"><span>آخرین ذخیره</span><b>${esc(lastSaved)}</b></div><div class="row between"><span>زمان باقی‌مانده</span><b>${esc(v72TimeLeft(info.remainMs))}</b></div><div class="row between"><span>وضعیت نسخه</span><b class="v72-${syncClass}">${esc(syncLabel)}</b></div><div class="row between"><span>کل سؤال‌ها</span><b>${fa(info.total)}</b></div></div></div>
      ${info.expired?'<div class="notice warn"><b>زمان این Draft تمام شده است.</b> پاسخ‌های ذخیره‌شده تغییر داده نمی‌شوند و هنگام ادامه، مسیر امن تحویل آفلاین اجرا می‌شود.</div>':!info.versionMatch?'<div class="notice warn"><b>ادامه مستقیم مسدود است.</b> نسخه محلی باید با وضعیت مدرسه تعیین تکلیف شود؛ پاسخ نیمه‌کاره حذف نمی‌شود.</div>':'<div class="sync-banner">ادامه دقیقاً از سؤال ذخیره‌شده انجام می‌شود و پاسخ‌های قبلی روی دستگاه باقی می‌مانند.</div>'}
      <button id="v72ResumeBtn" class="btn primary mt">${info.expired?"تعیین تکلیف پاسخ ذخیره‌شده":info.versionMatch?"ادامه از سؤال "+fa(info.currentIndex+1):"نسخه ناسازگار — ادامه ممکن نیست"}</button>
      <button class="btn secondary mt" data-close>فعلاً ادامه نمی‌دهم</button>`);
    document.getElementById("v72ResumeBtn").onclick=async()=>{if(!info.versionMatch){toast("نسخه محلی با بسته فعلی هماهنگ نیست؛ پاسخ‌ها حذف نشده‌اند.","danger");return;}closeModal();await startExam(exam,draft);};
  };

  window.__MSY_V72_STUDENT_RESUME_TEST__={
    version:V72_STUDENT_VERSION,
    info:v72ResumeInfo,
    time:v72TimeLeft
  };


  /* ==================== MADRESEYAR v73 — STUDENT EXAM START READINESS ==================== */
  const V73_STUDENT_VERSION="v73-student-exam-start-readiness";

  async function v73Readiness(exam){
    const checks=[];
    checks.push({id:"package",ok:validateExamPackageV60(exam).length===0,label:"ساختار آزمون",detail:validateExamPackageV60(exam).length?"بسته آزمون نیاز به اصلاح مدرسه دارد.":"بسته آزمون معتبر است.",blocking:true});
    const avail=typeof availabilityStateV62==="function"?availabilityStateV62(exam):"running";
    checks.push({id:"availability",ok:avail==="running",label:"زمان و دسترسی آزمون",detail:avail==="running"?"آزمون در بازه مجاز اجرا قرار دارد.":availabilityMessageV62(avail),blocking:true});
    let storageOk=true;
    try{const probe={id:"v73_probe",data:{at:Date.now()},savedAt:Date.now()};await storePut(CACHE_STORE,probe);const got=await storeGet(CACHE_STORE,"v73_probe");storageOk=Boolean(got);await storeDelete(CACHE_STORE,"v73_probe");}catch(_){storageOk=false;}
    checks.push({id:"storage",ok:storageOk,label:"ذخیره محلی پاسخ‌ها",detail:storageOk?"ذخیره روی دستگاه آماده است.":"ذخیره محلی قابل تأیید نیست؛ شروع آزمون امن نیست.",blocking:true});
    checks.push({id:"network",ok:navigator.onLine,label:"اتصال اینترنت",detail:navigator.onLine?"اینترنت در دسترس است؛ پس از دانلود، پاسخ‌ها محلی هم ذخیره می‌شوند.":"اینترنت قطع است؛ اگر بسته قبلاً دانلود شده باشد آزمون می‌تواند محلی ادامه پیدا کند.",blocking:false});
    if(navigator.getBattery){
      try{const b=await navigator.getBattery();const pct=Math.round(Number(b.level||0)*100);checks.push({id:"battery",ok:b.charging||pct>=20,label:"باتری دستگاه",detail:b.charging?`در حال شارژ · ${fa(pct)}٪`: `${fa(pct)}٪${pct<20?" · بهتر است قبل از شروع شارژ شود":""}`,blocking:false});}catch(_){}
    }
    const narrow=Math.min(window.innerWidth||9999,window.innerHeight||9999)<320;
    checks.push({id:"viewport",ok:!narrow,label:"نمایش صفحه",detail:narrow?"فضای نمایش بسیار محدود است؛ چرخش صفحه یا دستگاه بزرگ‌تر پیشنهاد می‌شود.":"اندازه صفحه برای اجرای آزمون مناسب است.",blocking:false});
    return checks;
  }
  function v73Icon(c){return c.ok?"✓":c.blocking?"×":"!";}
  async function v73ShowReadiness(exam){
    const checks=await v73Readiness(exam),blocked=checks.some(c=>c.blocking&&!c.ok),warnings=checks.filter(c=>!c.ok&&!c.blocking).length;
    openModal(`<div class="modal-head"><div><h3>بررسی آمادگی قبل از شروع</h3><small class="muted">${esc(exam.title)}</small></div><button class="close-btn" data-close>×</button></div>
      <div class="v73-ready-list">${checks.map(c=>`<article class="${c.ok?"ok":c.blocking?"bad":"warn"}"><span>${v73Icon(c)}</span><div><b>${esc(c.label)}</b><small>${esc(c.detail)}</small></div></article>`).join("")}</div>
      ${blocked?'<div class="notice warn"><b>شروع آزمون مسدود است.</b> حداقل یک مورد ضروری آماده نیست و Attempt نباید شروع شود.</div>':warnings?'<div class="notice info">موارد هشدار مانع شروع نیستند، اما بهتر است قبل از آزمون بررسی شوند.</div>':'<div class="sync-banner">دستگاه برای شروع آزمون آماده است.</div>'}
      <button id="v73ReadyContinue" class="btn primary mt">${blocked?"بررسی دوباره آمادگی":"ادامه به صفحه شروع آزمون"}</button>
      <button class="btn secondary mt" data-close>انصراف</button>`);
    const btn=document.getElementById("v73ReadyContinue");
    if(btn)btn.onclick=()=>{closeModal();blocked?v73ShowReadiness(exam):openExamIntroBeforeV73(exam);};
  }

  const openExamIntroBeforeV73=openExamIntro;
  openExamIntro=async function(exam){
    const draft=await storeGet(DRAFT_STORE,exam.id);
    if(draft)return openExamIntroBeforeV73(exam);
    return v73ShowReadiness(exam);
  };

  window.__MSY_V73_STUDENT_READINESS_TEST__={version:V73_STUDENT_VERSION,check:v73Readiness,show:v73ShowReadiness};


  /* ==================== MADRESEYAR v74 — SUBMISSION CONFIRMATION & RECEIPT UX ==================== */
  const V74_STUDENT_VERSION="v74-exam-submission-confirmation-receipt-ux";

  async function v74DeliverySnapshot(examId){
    const queue=(await storeAll(QUEUE_STORE)).find(x=>x.examId===examId);
    const state=await getLocalExamState(examId);
    const receipt=(await storeGet(CACHE_STORE,`receipt_${examId}`))?.data||null;
    if(queue)return {state:"pending",queue,local:state,receipt:null};
    if(receipt||state?.serverConfirmed)return {state:"confirmed",queue:null,local:state,receipt:receipt||state};
    return {state:state?.status||"unknown",queue:null,local:state,receipt:null};
  }
  function v74ReceiptTime(ts){if(!Number(ts))return "—";try{return new Date(Number(ts)).toLocaleString("fa-IR");}catch(_){return "—";}}
  async function v74OpenReceipt(examId,title="آزمون"){
    const x=await v74DeliverySnapshot(examId),confirmed=x.state==="confirmed",pending=x.state==="pending";
    const r=x.receipt||x.local||{},q=x.queue||{};
    openModal(`<div class="receipt v74-receipt"><div class="receipt-icon ${confirmed?"confirmed":pending?"pending":"unknown"}">${confirmed?"✓":pending?"↻":"!"}</div>
      <h3>${confirmed?"تحویل قطعی به مدرسه":pending?"پاسخ نهایی شده؛ در صف ارسال":"وضعیت تحویل نیاز به بررسی دارد"}</h3>
      <p class="muted">${esc(title)}</p>
      <div class="v74-state-banner ${confirmed?"ok":pending?"warn":"danger"}">${confirmed?"Server دریافت پاسخ را تأیید کرده است.":pending?"پاسخ‌ها روی همین دستگاه محفوظ و قفل شده‌اند؛ هنوز رسید قطعی Server نداریم.":"برای این آزمون نه صف ارسال فعالی پیدا شد و نه رسید قطعی Server."}</div>
      <div class="card mt v74-receipt-meta">
        <div class="row between"><span>وضعیت</span><b>${confirmed?"دریافت‌شده توسط Server":pending?"در انتظار ارسال":"نامشخص"}</b></div>
        <div class="row between"><span>زمان نهایی‌شدن</span><b>${esc(v74ReceiptTime(r.finalizedAt||q.finalizedAt||q.payload?.finalizedAt))}</b></div>
        ${confirmed?`<div class="row between"><span>زمان تحویل</span><b>${esc(v74ReceiptTime(r.submittedAt))}</b></div><div class="row between"><span>شماره رسید</span><b dir="ltr">${esc(r.receiptId||"ثبت‌شده")}</b></div>${r.receiptHash?`<div class="row between"><span>هش رسید</span><b dir="ltr">${esc(String(r.receiptHash).slice(0,24))}…</b></div>`:""}`:`<div class="row between"><span>تلاش ارسال</span><b>${fa(Number(q.retryCount||0))}</b></div>${q.lastError?`<div class="offline-banner"><b>آخرین خطا</b><br>${esc(q.lastError)}</div>`:""}`}
      </div>
      ${confirmed&&r.result?.status==="final"?`<div class="card mt"><small>تصحیح خودکار انجام شد</small><br><b>نمره نهایی: ${fa(r.result.score)} از ${fa(r.result.total)}</b>${r.result.percent!==undefined?`<br><small>${fa(r.result.percent)}٪</small>`:""}</div><button class="btn primary mt" id="v74ReportCard">مشاهده در کارنامه</button>`:""}
      ${pending?`<button class="btn primary mt" id="v74RetryNow">تلاش دوباره برای تحویل</button><button class="btn secondary mt" id="v74DeliveryCenter">مشاهده جزئیات صف ارسال</button>`:""}
      <button class="btn secondary mt" id="v74ReceiptDone">بازگشت به آزمون‌ها</button></div>`);
    if(document.getElementById("v74ReportCard"))document.getElementById("v74ReportCard").onclick=async()=>{closeModal();try{await withNetwork("receipt-results-refresh",()=>refreshResultsCacheV4517());}catch{}navigate("results");};
    if(document.getElementById("v74RetryNow"))document.getElementById("v74RetryNow").onclick=async()=>{await retryExamSubmission(examId);closeModal();await v74OpenReceipt(examId,title);};
    if(document.getElementById("v74DeliveryCenter"))document.getElementById("v74DeliveryCenter").onclick=async()=>{closeModal();await openSubmissionDiagnosticsV64();};
    document.getElementById("v74ReceiptDone").onclick=()=>{closeModal();navigate("exams");};
  }

  const showReceiptBeforeV74=showReceipt;
  showReceipt=function(exam,receipt){
    // v75 audit: every submission, including auto-graded exams, must show explicit delivery certainty.
    setTimeout(()=>v74OpenReceipt(exam.id,exam.title),0);
  };



  /* ==================== MADRESEYAR v75 — END-TO-END EXAM FLOW AUDIT ==================== */
  const V75_STUDENT_VERSION="v75-end-to-end-exam-flow-audit";
  function v75FlowContract(){
    return {
      readiness:"v73",
      resume:"v72",
      saveConfidence:"v69",
      review:"v70",
      accessibility:"v71",
      timeoutSafety:"v63",
      diagnostics:"v64",
      recovery:"v65",
      receipt:"v74",
      invariants:[
        "no-attempt-before-readiness",
        "no-resume-on-package-mismatch",
        "no-edit-after-finalize",
        "server-confirmation-distinct-from-local-queue",
        "auto-grade-does-not-bypass-delivery-receipt"
      ]
    };
  }
  window.__MSY_V75_E2E_AUDIT_TEST__={version:V75_STUDENT_VERSION,contract:v75FlowContract};


  window.__MSY_V74_RECEIPT_TEST__={version:V74_STUDENT_VERSION,snapshot:v74DeliverySnapshot,open:v74OpenReceipt};


  /* ==================== MADRESEYAR v83 — STUDENT RESULT REVISION CONSISTENCY ==================== */
  const V83_STUDENT_VERSION="v83-student-result-revision-consistency";
  window.__MSY_V83_STUDENT_RESULT_TEST__={version:V83_STUDENT_VERSION};


  /* ==================== MADRESEYAR v115 — STUDENT HOME & ACTION CENTER ==================== */
  const V115_STUDENT_VERSION="v115-student-home-action-center";
  const V115_RESULT_SEEN_KEY="v115_result_seen";

  function v115PublishedResultRows(){
    const rows=[];
    for(const attempt of dashboard?.attempts||[]){
      const exam=(dashboard?.exams||[]).find(e=>String(e.id)===String(attempt.examId));
      if(!exam)continue;
      rows.push({examId:exam.id,at:Number(attempt.resultUpdatedAt||attempt.submittedAt||0),kind:"attempt"});
    }
    for(const submission of dashboard?.submissions||[]){
      const grade=(dashboard?.grades||[]).find(g=>String(g.submissionId)===String(submission.id)&&String(g.publishStatus||"published")==="published");
      if(!grade)continue;
      rows.push({examId:submission.examId,at:Number(grade.publishedAt||grade.gradedAt||submission.submittedAt||0),kind:"grade"});
    }
    const byExam=new Map();
    for(const row of rows){
      const old=byExam.get(String(row.examId));
      if(!old||row.at>old.at)byExam.set(String(row.examId),row);
    }
    return [...byExam.values()];
  }

  async function v115HomeState(){
    const drafts=(await storeAll(DRAFT_STORE)).filter(d=>!d.finalizedAt);
    const queue=await storeAll(QUEUE_STORE);
    const appeals=(dashboard?.appeals||[]).filter(a=>["open","reviewing"].includes(a.status));
    const resultRows=v115PublishedResultRows();
    const latestResultAt=Math.max(0,...resultRows.map(r=>Number(r.at||0)));
    const seenRecord=await storeGet(CACHE_STORE,V115_RESULT_SEEN_KEY);
    let seenAt=Number(seenRecord?.data?.at||0);
    let newResults=0;
    if(!seenRecord){
      seenAt=latestResultAt;
      await storePut(CACHE_STORE,{id:V115_RESULT_SEEN_KEY,data:{at:seenAt,initializedAt:Date.now()},savedAt:Date.now()});
    }else{
      newResults=resultRows.filter(r=>Number(r.at||0)>seenAt).length;
    }

    const exams=dashboard?.exams||[];
    const queueIds=new Set(queue.map(x=>String(x.examId)));
    const active=exams.filter(e=>e.studentStatus==="available"&&!queueIds.has(String(e.id)));
    return {drafts,queue,appeals,resultRows,latestResultAt,seenAt,newResults,active};
  }

  async function v115MarkResultsSeen(){
    const rows=v115PublishedResultRows();
    const at=Math.max(Date.now(),...rows.map(r=>Number(r.at||0)));
    await storePut(CACHE_STORE,{id:V115_RESULT_SEEN_KEY,data:{at},savedAt:Date.now()});
  }

  function v115ActionCard(icon,title,count,detail,go,kind="info"){
    return `<button type="button" class="v115-action-card ${kind}" data-v115-go="${esc(go)}"><span class="v115-action-icon">${icon}</span><span class="v115-action-main"><b>${esc(title)}</b><small>${esc(detail)}</small></span><strong>${fa(count)}</strong></button>`;
  }

  // p51: یادآورهای درون‌برنامه‌ای؛ بدون ارسال اعلان سیستم و بدون تغییر داده‌های سرور.
  const P51_DEFAULTS={homework:true,exams:true,completed:true,urgent:true,days:2};
  function p51Key(){const st=dashboard?.student||{};return 'msy.student.reminders.p51.'+String(st.id||st.studentId||st.nationalId||'local');}
  function p51Settings(){try{const v=JSON.parse(localStorage.getItem(p51Key())||'{}');return {...P51_DEFAULTS,...v};}catch{return {...P51_DEFAULTS};}}
  function p51Time(v){if(!v)return null;const t=new Date(v).getTime();return Number.isFinite(t)?t:null;}
  function p51Date(t){return new Intl.DateTimeFormat('fa-IR-u-ca-persian',{month:'long',day:'numeric'}).format(new Date(t));}
  // p52: نمایش مستقل کارهای انجام‌نشده، موارد نزدیک و عقب‌افتاده.
  // تاریخ نامشخص هرگز به‌عنوان تأخیر یا یادآور فوری فرض نمی‌شود.
  function p52HomeworkDone(t){return Boolean(t && t.submission);}
  // p53: counts and lists use exactly the same task collections.
  function p52ReminderPanel(){
    const cfg=p51Settings(),now=Date.now(),day=86400000,limit=now+Number(cfg.days||2)*day;
    const tasks=Array.isArray(dashboard?.homework)?dashboard.homework:[];
    const exams=Array.isArray(dashboard?.exams)?dashboard.exams:[];
    const pending=tasks.filter(t=>t&&!p52HomeworkDone(t));
    const completed=tasks.filter(t=>t&&p52HomeworkDone(t));
    const overdue=[],upcoming=[],noDate=[];
    if(cfg.homework)for(const t of pending){
      const due=p51Time(t.dueAt);
      const entry={time:due,title:t.title||'تکلیف بدون عنوان',sub:t.subject||'درس',go:'tasks',kind:'task'};
      if(due===null)noDate.push(entry);
      else if(due<now)overdue.push({...entry,kind:'late',detail:'مهلت تحویل گذشته'});
      else if(due<=limit)upcoming.push({...entry,detail:'مهلت '+p51Date(due)});
    }
    if(cfg.exams)for(const e of exams){
      if(['submitted','completed','graded'].includes(String(e.studentStatus||'').toLowerCase()))continue;
      const start=p51Time(e.startAt),end=p51Time(e.endAt);
      if(start===null&&end===null)continue;
      if(end!==null&&end<now)continue;
      if(start!==null&&start>limit)continue;
      const time=start??end;
      if(time===null||time>limit)continue;
      upcoming.push({time,title:e.title||'آزمون',sub:e.subject||'درس',go:'exams',kind:'exam',detail:start!==null&&start>now?'شروع '+p51Date(start):'آزمون در دسترس'});
    }
    overdue.sort((a,b)=>a.time-b.time);upcoming.sort((a,b)=>a.time-b.time);
    const item=(a)=>`<button type="button" class="p52-item ${a.kind==='late'?'p52-item-late':''}" data-go="${a.go}"><span class="p52-item-icon" aria-hidden="true">${a.kind==='exam'?'◷':a.kind==='late'?'!':'✓'}</span><span class="p52-item-body"><strong>${esc(a.title)}</strong><small>${esc(a.sub)}${a.detail?' · '+esc(a.detail):''}</small></span><span class="p52-item-arrow" aria-hidden="true">‹</span></button>`;
    const group=(title,subtitle,rows,tone,empty,allLink)=>`<div class="p52-group p52-${tone}"><div class="p52-group-head"><div><h4>${title}</h4><small>${subtitle}</small></div><b class="p52-count">${fa(rows.length)}</b></div>${rows.length?`<div class="p52-list">${rows.slice(0,4).map(item).join('')}</div>${rows.length>4?`<button type="button" class="p52-more" data-go="${allLink}">مشاهده همه موارد ←</button>`:''}`:`<p class="p52-empty">${empty}</p>`}</div>`;
    const pendingRows=pending.map(t=>({title:t.title||'تکلیف بدون عنوان',sub:t.subject||'درس',go:'tasks',kind:'task',time:p51Time(t.dueAt),detail:p51Time(t.dueAt)===null?'بدون تاریخ تحویل':p51Time(t.dueAt)<now?'مهلت گذشته':'مهلت '+p51Date(p51Time(t.dueAt))}));
    const completedRows=completed.map(t=>({title:t.title||'تکلیف بدون عنوان',sub:t.subject||'درس',go:'tasks',kind:'done',time:p51Time(t.submission?.submittedAt||t.submission?.createdAt),detail:'تحویل داده شده'}));
    pendingRows.sort((a,b)=>(a.time??Infinity)-(b.time??Infinity));
    const urgentCount=overdue.length+upcoming.filter(x=>x.time!==null&&x.time<=now+day).length;
    return `<section class="p51-reminders p52-reminders" aria-label="یادآورهای من"><div class="p51-reminder-heading"><div><span class="p51-eyebrow">برنامه‌ریزی شخصی</span><h3>یادآورهای من <span aria-hidden="true">✦</span></h3><p>تکالیف باقی‌مانده، موعدهای نزدیک و کارهای عقب‌افتاده در یک نگاه</p></div><button type="button" class="p51-settings-btn" data-p51-settings>⚙ تنظیمات</button></div><div class="p52-summary"><span class="p53-pending-summary">تکالیف تحویل‌نداده‌شده <b>${fa(pendingRows.length)}</b></span>${cfg.completed?`<button type="button" class="p53-done-summary p54-open-track" data-p54-track aria-label="مشاهده وضعیت تکالیف تحویل‌داده‌شده">تکالیف تحویل‌داده‌شده <b>${fa(completedRows.length)}</b> <span aria-hidden="true">‹</span></button>`:''}${cfg.urgent?`<span>نیازمند توجه <b>${fa(urgentCount)}</b></span>`:''}</div><div class="p52-groups">${cfg.homework?group('تکالیف انجام‌نشده','همه تکالیف تحویل‌نداده، حتی بدون تاریخ',pendingRows,'pending','همه تکالیفت تحویل داده شده‌اند؛ کار باقی‌مانده‌ای نداری.','tasks'):''}${cfg.completed?group('تکالیف تحویل‌داده‌شده','تکالیفی که پاسخ آن‌ها برای معلم ارسال شده',completedRows,'done','هنوز تکلیفی تحویل نداده‌ای.','tasks'):''}${cfg.homework?group('کارهای عقب‌افتاده','تکالیفی که تاریخ تحویل آن‌ها گذشته',overdue,'overdue','کار عقب‌افتاده‌ای ثبت نشده است.','tasks'):''}${cfg.homework||cfg.exams?group('یادآورهای نزدیک',`تکالیف و آزمون‌های ${fa(cfg.days)} روز آینده`,upcoming,'upcoming','در بازه انتخاب‌شده مورد زمان‌داری وجود ندارد.','tasks'):''}</div>${cfg.homework&&noDate.length?`<p class="p52-hint">${fa(noDate.length)} تکلیف بدون تاریخ تحویل در فهرست انجام‌نشده‌ها نمایش داده شده است.</p>`:''}<small class="p51-note">این یادآورها فقط هنگام باز بودن پنل و بر اساس اطلاعات همگام‌شده نمایش داده می‌شوند.</small></section>`;
  }
  function p51ReminderPanel(){return p52ReminderPanel();}
  // p54: read-only homework submission tracking from synchronized student data.
  function p54Date(value){
    if(value===null||value===undefined||value==='')return 'ثبت نشده';
    const n=typeof value==='number'?value:Number(value);
    const t=Number.isFinite(n)&&String(value).trim()!==''?new Date(n<1e11?n*1000:n):new Date(value);
    return Number.isFinite(t.getTime())?new Intl.DateTimeFormat('fa-IR-u-ca-persian',{year:'numeric',month:'long',day:'numeric'}).format(t):String(value);
  }
  function p54TrackHomework(){
    const tasks=(Array.isArray(dashboard?.homework)?dashboard.homework:[]).filter(t=>t&&t.submission);
    const graded=tasks.filter(t=>String(t.submission?.status||'').toLowerCase()==='graded');
    const pending=tasks.filter(t=>String(t.submission?.status||'').toLowerCase()!=='graded');
    const item=t=>{
      const s=t.submission||{},isGraded=String(s.status||'').toLowerCase()==='graded';
      const score=Number(s.score),max=Number(s.maxScore||t.totalScore||20);
      const scoreText=isGraded&&s.score!==null&&s.score!==undefined&&s.score!==''&&Number.isFinite(score)?`نمره: ${fa(score)} از ${fa(Number.isFinite(max)&&max>0?max:20)}`:'نمره هنوز ثبت نشده';
      const date=p54Date(s.submittedAt??s.createdAt??s.updatedAt);
      return `<article class="p54-task" data-p55-status="${isGraded?'graded':'pending'}" data-p55-search="${esc(((t.title||'')+' '+(t.subject||'')).toLocaleLowerCase('fa'))}"><div class="p54-task-head"><div><strong>${esc(t.title||'تکلیف بدون عنوان')}</strong><small>${esc(t.subject||'درس نامشخص')}</small></div><span class="p54-status ${isGraded?'p54-graded':'p54-pending'}">${isGraded?'نمره ثبت شده':'در انتظار بررسی'}</span></div><div class="p54-task-meta"><span>تاریخ ارسال: ${esc(date)}</span><span>${scoreText}</span></div>${s.feedback?`<div class="p54-feedback"><b>بازخورد معلم</b><p>${esc(String(s.feedback))}</p></div>`:''}</article>`;
    };
    openModal(`<div class="modal-head"><div><h3>پیگیری تکالیف من</h3><small class="muted">وضعیت تکالیفی که برای معلم ارسال کرده‌ای</small></div><button class="close-btn" data-close aria-label="بستن">×</button></div><div class="p54-tracking"><div class="p54-overview"><span>کل تحویل‌شده <b>${fa(tasks.length)}</b></span><span>در انتظار بررسی <b>${fa(pending.length)}</b></span><span>نمره‌دار <b>${fa(graded.length)}</b></span></div>${tasks.length?`<div class="p55-tools"><div class="p55-tabs" role="group" aria-label="فیلتر وضعیت تکالیف"><button type="button" class="p55-filter active" data-p55-filter="all" aria-pressed="true">همه (${fa(tasks.length)})</button><button type="button" class="p55-filter" data-p55-filter="pending" aria-pressed="false">در انتظار (${fa(pending.length)})</button><button type="button" class="p55-filter" data-p55-filter="graded" aria-pressed="false">نمره‌دار (${fa(graded.length)})</button></div><label class="p55-search-label">جست‌وجوی تکلیف یا درس<input id="p55Search" class="p55-search" type="search" autocomplete="off" placeholder="نام تکلیف یا درس..."></label></div><div class="p54-task-list" id="p55TaskList">${[...pending,...graded].map(item).join('')}</div><p id="p55Empty" class="p54-empty" hidden>موردی با این فیلتر پیدا نشد.</p>`:'<div class="p54-empty">هنوز تکلیفی برای معلم ارسال نکرده‌ای.</div>'}<button type="button" class="btn secondary full" id="p54OpenTasks">رفتن به صفحه تکالیف</button><p class="p54-footnote">این اطلاعات از آخرین همگام‌سازی پنل خوانده می‌شود.</p></div>`);
    // p55: filters act only on displayed, already synchronized homework data.
    const filters=[...document.querySelectorAll('[data-p55-filter]')],search=document.getElementById('p55Search');
    const apply=()=>{
      const active=filters.find(b=>b.getAttribute('aria-pressed')==='true')?.dataset.p55Filter||'all';
      const q=(search?.value||'').trim().toLocaleLowerCase('fa');let visible=0;
      document.querySelectorAll('#p55TaskList .p54-task').forEach(card=>{
        const show=(active==='all'||card.dataset.p55Status===active)&&(!q||(card.dataset.p55Search||'').includes(q));
        card.hidden=!show;if(show)visible++;
      });
      const empty=document.getElementById('p55Empty');if(empty)empty.hidden=visible>0;
    };
    filters.forEach(b=>b.addEventListener('click',()=>{filters.forEach(x=>{const on=x===b;x.setAttribute('aria-pressed',String(on));x.classList.toggle('active',on);});apply();}));
    if(search)search.addEventListener('input',apply);
    const go=document.getElementById('p54OpenTasks');if(go)go.onclick=()=>{closeModal();navigate('tasks');};
  }
  document.addEventListener('click',e=>{if(e.target.closest('[data-p54-track]'))p54TrackHomework();});
  function p51OpenSettings(){
    const c=p51Settings();
    const toggle=(key,label)=>`<label class="p51-setting"><span>${label}</span><input type="checkbox" data-p51-opt="${key}" ${c[key]?'checked':''}></label>`;
    openModal(`<div class="modal-head"><h3>تنظیمات یادآورها</h3><button class="close-btn" data-close>×</button></div><div class="p51-setting-list">${toggle('homework','یادآوری تکالیف')}${toggle('exams','یادآوری آزمون‌ها')}${toggle('completed','نمایش تکالیف تحویل‌شده')}${toggle('urgent','نمایش شمارنده موارد مهم')}<label class="p51-setting"><span>چند روز آینده؟</span><select id="p51Days"><option value="1" ${c.days===1?'selected':''}>۱ روز</option><option value="2" ${c.days===2?'selected':''}>۲ روز</option><option value="3" ${c.days===3?'selected':''}>۳ روز</option><option value="7" ${c.days===7?'selected':''}>۷ روز</option></select></label></div><button type="button" class="btn primary full" id="p51Save">ذخیره تنظیمات</button><p class="p51-note">تنظیمات فقط روی همین دستگاه ذخیره می‌شود؛ اعلان گوشی در پس‌زمینه ارسال نمی‌شود.</p>`);
    document.getElementById('p51Save').onclick=()=>{const next={...c};document.querySelectorAll('[data-p51-opt]').forEach(el=>{next[el.dataset.p51Opt]=el.checked;});next.days=Number(document.getElementById('p51Days').value);try{localStorage.setItem(p51Key(),JSON.stringify(next));}catch{}closeModal();navigate('home');toast('تنظیمات یادآوری ذخیره شد.','ok');};
  }
  document.addEventListener('click',e=>{if(e.target.closest('[data-p51-settings]'))p51OpenSettings();});

  const renderHomeBeforeV115=renderHome;
  renderHome=async function(){
    const s=dashboard?.student||{},state=await v115HomeState();
    const report=dashboard?.report||[];
    const average=report.length?Math.round(report.reduce((a,b)=>a+Number(b.percent||0),0)/report.length):0;
    const homeworkPending=(dashboard?.homework||[]).filter(t=>!t.submission).length;
    const announcements=[...(dashboard?.announcements||[]).map(a=>({...a,at:a.createdAt,schoolAnnouncement:true})),...(dashboard?.notifications||[])];
    const urgent=announcements.filter(n=>n.priority==="urgent"||(!n.schoolAnnouncement&&!n.read));

    $("page").innerHTML=`
      <section class="hero v115-hero">
        <div class="student-hero-photo-p25" id="studentHeroPhotoP25">${esc((s.firstName||"د").slice(0,1))}</div>
        <div>
          <h2>سلام ${esc(s.firstName||"دانش‌آموز")} 👋</h2>
          <p>${esc(s.schoolName||"مدرسه")} · ${esc(s.className||"کلاس")}</p>
        </div>
        <div class="v115-home-status"><span>میانگین ${fa(average)}٪</span><span>${navigator.onLine?"آنلاین":"حالت محلی"}</span></div>
      </section>

      ${p48TodayPanel(state.active)}
      ${p51ReminderPanel()}

      <section class="student-p27-shortcuts" aria-label="دسترسی سریع دانش‌آموز">
        <button class="student-p27-shortcut" data-v115-go="schedule"><span class="student-p27-icon">▦</span><b>برنامه درسی</b><small>برنامه هفتگی</small></button>
        <button class="student-p27-shortcut" data-v115-go="exams"><span class="student-p27-icon">✎</span><b>آزمون‌ها</b><small>آزمون‌های من</small></button>
        <button class="student-p27-shortcut" data-v115-go="tasks"><span class="student-p27-icon">✓</span><b>تکالیف</b><small>پیگیری تکالیف</small></button>
        <button class="student-p27-shortcut" data-v115-go="results"><span class="student-p27-icon">▤</span><b>کارنامه</b><small>نمرات و نتایج</small></button>
      </section>

      <section class="v115-action-center" aria-labelledby="v115ActionTitle">
        <div class="section-title"><div><h3 id="v115ActionTitle">کارهای مهم من</h3><small class="muted">مواردی که نیاز به توجه یا پیگیری دارند.</small></div></div>
        <div class="v115-action-grid">
          ${v115ActionCard("▶","آزمون نیمه‌کاره",state.drafts.length,state.drafts.length?"برای ادامه پاسخ‌گویی آماده است":"Draft بازی وجود ندارد","exams",state.drafts.length?"warn":"ok")}
          ${v115ActionCard("↻","پاسخ در انتظار ارسال",state.queue.length,state.queue.length?"روی گوشی محفوظ است؛ هنوز رسید قطعی نداریم":"همه پاسخ‌ها تعیین‌تکلیف شده‌اند","exams",state.queue.length?"danger":"ok")}
          ${v115ActionCard("★","نتیجه تازه",state.newResults,state.newResults?"نتیجه جدید یا بازبینی‌شده داری":"نتیجه تازه‌ای از آخرین مشاهده نیست","results",state.newResults?"info":"ok")}
          ${v115ActionCard("⚖","اعتراض در حال پیگیری",state.appeals.length,state.appeals.length?"پرونده باز یا در حال بررسی":"اعتراض بازی نداری","appeals",state.appeals.length?"warn":"ok")}
        </div>
      </section>

      ${todayScheduleCardV79()}
      ${onlineTodayCardV74()}
      ${academicCalendarCardV76()}

      <div class="grid v115-today-grid">
        <article class="card stat-card"><div class="stat-icon">📝</div><b>${fa(state.active.length)}</b><small>آزمون آماده</small></article>
        <article class="card stat-card"><div class="stat-icon">✓</div><b>${fa(homeworkPending)}</b><small>تکلیف انجام‌نشده</small></article>
        <article class="card stat-card"><div class="stat-icon">⏳</div><b>${fa(pendingGradeCount())}</b><small>در انتظار نمره</small></article>
        <article class="card stat-card"><div class="stat-icon">🔔</div><b>${fa(urgent.length)}</b><small>اعلان نیازمند توجه</small></article>
      </div>

      <div class="section-title"><h3>آزمون‌های آماده</h3><button data-v115-go="exams">مشاهده همه</button></div>
      <div class="list">${state.active.length?state.active.slice(0,2).map(exam=>examMini(exam)).join(""):'<div class="card empty"><b>آزمون آماده‌ای نداری</b><small>آزمون‌های جدید پس از دریافت اینجا دیده می‌شوند.</small></div>'}</div>

      <div class="section-title"><h3>آخرین اعلان‌ها</h3><button id="v115AllNotifications">همه اعلان‌ها</button></div>
      <div class="list">${announcements.slice(0,2).map(n=>`<div class="list-item ${n.priority==="urgent"?"urgent-announcement":""}"><div class="list-icon">${n.priority==="urgent"?"🚨":"🔔"}</div><div class="list-main"><b>${esc(n.title)}</b><small>${esc(n.body)} · ${esc(n.at||"")}</small></div>${n.priority==="urgent"?'<span class="chip danger">فوری</span>':""}</div>`).join("")||'<div class="card empty">اعلان جدیدی وجود ندارد.</div>'}</div>`;

    refreshSchoolPhotoP25().catch(()=>{});
    bindExamMini(); bindOnlineJoinV74();
    document.querySelectorAll("[data-go]").forEach(b=>b.onclick=()=>navigate(b.dataset.go));
    document.querySelectorAll("[data-v115-go]").forEach(b=>b.onclick=async()=>{
      const target=b.dataset.v115Go;
      if(target==="results")await v115MarkResultsSeen();
      navigate(target);
    });
    const all=document.getElementById("v115AllNotifications");if(all)all.onclick=showNotifications;
  };

  window.__MSY_V115_STUDENT_HOME_TEST__={
    version:V115_STUDENT_VERSION,
    state:v115HomeState,
    results:v115PublishedResultRows,
    markResultsSeen:v115MarkResultsSeen
  };
  window.__MSY_V135_STUDENT_AUDIT_TEST__={
    version:"72.35-p1",
    safeResourceUrl:safeResourceUrlV135,
    homeCards:["todayScheduleCardV79","onlineTodayCardV74","academicCalendarCardV76"],
    consentPolicy:"guardian-only",
    resultsRefresh:"explicit-network"
  };


})();


/* MADRESEYAR v84 — Student respects held/published result visibility. */


/* ==================== MADRESEYAR v117 — STUDENT EXAM CENTER CLEANUP & CONSOLIDATION ==================== */
window.__MSY_V117_STUDENT_EXAM_CENTER_TEST__={
  version:"v117-student-exam-center-cleanup-consolidation",
  canonicalRenderer:"renderExams",
  removedLegacyRenderer:"MadreseyarStudentExamsV45298",
  policy:"no-runtime-behavior-change"
};

/* MADRESEYAR v89 — Student appeal closure shows resolved result revision. */
