/* Madreseyar Student Android V1.2 — visual shell only.
 * Reads rendered dashboard values, never invents grades or changes remote school data.
 * Original handlers, login, caching, exams, uploads and messages remain authoritative. */
(function(){
  'use strict';
  if (window.__msyGirlDashboardV12) return;
  window.__msyGirlDashboardV12 = true;
  const $ = (s,root=document)=>root.querySelector(s);
  const all = (s,root=document)=>Array.from(root.querySelectorAll(s));
  const escape = v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icons={
    home:'<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
    tasks:'<rect x="5" y="4" width="14" height="17" rx="3"/><path d="M9 3h6M9 11h6M9 15h5"/>',
    exams:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16l2 2 4-4"/>',
    chat:'<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 10 10 0 0 1-3.8-.75L3 21l1.75-5.7A8.5 8.5 0 1 1 21 11.5Z"/><path d="M8.5 11.5h.01m4 0h.01m4 0h.01"/>',
    more:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 10h18"/><path d="m9 15 2 2 4-4"/>',
    grades:'<path d="M5 19V9M11 19V4M17 19v-8"/><path d="M3 21h18"/>',
    presence:'<circle cx="10" cy="8" r="3"/><path d="M4 20v-2c0-4 12-4 12 0v2M17 15l2 2 3-4"/>',
    report:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h4M12 15l1 1.5 2-.4-1.2 1.6.7 2-2.5-1-2 1 .5-2-1-1.6Z"/>',
    library:'<path d="M4 5a2 2 0 0 1 2-2h13v17H6a2 2 0 0 1-2-2zM4 18a2 2 0 0 1 2-2h13M9 7h6"/>',
    notify:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    sync:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 9a7 7 0 0 1 12-2l2 5M18 15a7 7 0 0 1-12 2l-2-5"/>',
    clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    arrow:'<path d="m14 7-5 5 5 5"/>',
    check:'<path d="m5 12 4 4 10-10"/>',
    profile:'<circle cx="12" cy="8" r="3"/><path d="M5 21v-2c0-5 14-5 14 0v2"/>'
  };
  const svg = (name,size=25)=>`<svg aria-hidden="true" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${icons[name]||icons.library}</svg>`;
  function parseStat(which){
    const item=all('.p48-today-stat', $('#page')).find(x=>x.textContent.includes(which));
    return item?.querySelector('b')?.textContent.trim()||'۰';
  }
  let programmaticReportNavigation = false;
  function nav(page){
    if(page==='chat'){
      const launcher=$('#p58Launch');
      if(launcher)launcher.click();else alert('گفت‌وگو با معلم هنوز بارگذاری نشده است.');
      return;
    }
    if(page==='notifications'){$('#notificationsBtn')?.click();return;}
    if(page==='sync'){
      if(!navigator.onLine){alert('برای دریافت اطلاعات تازه اینترنت لازم است. داده‌های ذخیره‌شده حذف نمی‌شوند.');return;}
      $('#bottomNav [data-page="more"]')?.click();
      setTimeout(()=>{const sync=$('#manualSyncBtn'); if(sync)sync.click();else alert('دکمه همگام‌سازی در پنل بارگذاری نشده است.');},180);
      return;
    }
    if(page==='attendance'){
      $('#bottomNav [data-page="more"]')?.click();
      setTimeout(()=>{const b=$('#attendanceBtn');if(b)b.click();else alert('جزئیات حضور و غیاب در بخش بیشتر در دسترس است.');},180);
      return;
    }
    if(['home','tasks','exams','results','more'].includes(page)){
      if (page==='results') programmaticReportNavigation=true;
      try { $('#bottomNav [data-page="'+page+'"]')?.click(); }
      finally { programmaticReportNavigation=false; }
      return;
    }
    let link=$('[data-v115-go="'+page+'"]');
    if(link){link.click();return;}
    $('#bottomNav [data-page="more"]')?.click();
    setTimeout(()=>{
      const b=$('[data-more="'+page+'"]')||$('[data-go="'+page+'"]');
      if(b)b.click();
    },180);
  }
  function tile(label,sub,icon,tone,go,wide){return `<button class="msy-tile msy-${tone}${wide?' msy-tile-wide':''}" data-msy-go="${go}" type="button"><span class="msy-tile-ico">${svg(icon,28)}</span><strong>${label}</strong><small>${escape(sub)}</small><span class="msy-tile-arrow">${svg('arrow',16)}</span></button>`;}
  function taskRow(title,sub,to,kind){return `<button class="msy-today-item msy-today-${kind}" type="button" data-msy-go="${to}"><span class="msy-today-icon">${svg(kind==='exam'?'exams':kind==='message'?'chat':'tasks',22)}</span><span class="msy-today-copy"><b>${escape(title)}</b><small>${escape(sub)}</small></span><span class="msy-today-chevron">${svg('arrow',18)}</span></button>`;}
  function decorateNav(){
    const n=$('#bottomNav');if(!n)return;
    const entries={home:['home','خانه'],exams:['exams','آزمون‌ها'],tasks:['tasks','تکالیف'],results:['chat','پیام‌ها'],more:['more','بیشتر']};
    for(const [page,[symbol,label]] of Object.entries(entries)){
      const b=n.querySelector('button[data-page="'+page+'"]');if(!b||b.dataset.msySkinned)return;
      b.innerHTML='<span class="msy-nav-icon">'+svg(symbol,23)+'</span><small>'+label+'</small>';
      b.dataset.msySkinned='1';
      if(page==='results')b.addEventListener('click',e=>{if(programmaticReportNavigation)return;e.preventDefault();e.stopImmediatePropagation();nav('chat');},true);
    }
  }
  function makeHome(root){
    const hero=$('.v115-hero',root);
    if(!hero)return;
    const greeting=hero.querySelector('h2')?.textContent.replace(/👋/g,'').trim()||'سلام دانش‌آموز';
    const school=hero.querySelector('p')?.textContent.trim()||'مدرسه‌یار';
    const status=hero.querySelector('.v115-home-status')?.innerText.trim()||'';
    const tasks=parseStat('تکالیف باقی‌مانده');
    const exams=parseStat('آزمون‌های فعال');
    const notes=parseStat('اعلان‌های خوانده‌نشده');
    const lesson=parseStat('کلاس‌های امروز');
    const chatCount=$('#p58Badge')?.hidden?'':($('#p58Badge')?.textContent||'');
    const lessonDate=$('.p48-today-date',root)?.textContent.trim()||new Intl.DateTimeFormat('fa-IR',{weekday:'long',day:'numeric',month:'long'}).format(new Date());
    const list=all('.p48-today-tasks .p48-today-item',root).slice(0,2).map(x=>taskRow(x.querySelector('strong')?.textContent||'تکلیف',x.querySelector('small')?.textContent||'', 'tasks','task'));
    const nextClass=$('.p48-today-lessons .p48-today-item',root);
    if(nextClass && !/ثبت نشده/.test(nextClass.textContent))list.push(taskRow(nextClass.querySelector('strong')?.textContent||'کلاس امروز',nextClass.querySelector('small')?.textContent||'', 'schedule','exam'));
    if(!list.length)list.push(taskRow('فعلاً کار فوری نداری','تکالیف و آزمون‌ها را بررسی کن','tasks','task'));
    const alerts=all('.v115-action-card',root).map(x=>({title:x.querySelector('.v115-action-main b')?.textContent||'',count:x.querySelector('strong')?.textContent||'۰',detail:x.querySelector('small')?.textContent||'',go:x.dataset.v115Go||'more'}));
    const actions=alerts.map(x=>`<button class="msy-action-line" type="button" data-msy-go="${escape(x.go)}"><span>${escape(x.title)}</span><b>${escape(x.count)}</b></button>`).join('');
    const art=String(window.__msyGirlArtData||'');
    const block=document.createElement('div');block.id='msyGirlHome';
    block.innerHTML=`
      <section class="msy-girl-hero"><div class="msy-girl-greeting"><div class="msy-girl-heart">♥</div><h1>${escape(greeting)}</h1><p>${escape(school)}</p><div class="msy-school-status">${escape(status)}</div></div><div class="msy-girl-art">${art?'<img src="'+art+'" alt="تصویر دانش‌آموز مدرسه‌یار">':''}</div></section>
      <div class="msy-sync-row"><button type="button" class="msy-sync-button" data-msy-go="sync">${svg('sync',23)} به‌روزرسانی</button><span class="msy-sync-status">${svg('clock',16)} <span>${escape($('#syncLabel')?.textContent||'اطلاعات ذخیره‌شده')}</span></span></div>
      <div class="msy-offline-notice">اطلاعات دریافت‌شده روی گوشی می‌مانند. برای دریافت موارد جدید و ارسال قطعی پاسخ، اینترنت لازم است.</div>
      <div class="msy-feature-grid">
        ${tile('پیام‌ها',chatCount?chatCount+' پیام خوانده‌نشده':'چت با معلم','chat','rose','chat')}
        ${tile('آزمون‌ها',exams+' آزمون فعال','exams','blue','exams')}
        ${tile('تکالیف',tasks+' تکلیف باقی‌مانده','tasks','pink','tasks')}
        ${tile('حضور و غیاب','وضعیت حضور','presence','mint','attendance')}
        ${tile('نمرات','مشاهده عملکرد','grades','violet','results')}
        ${tile('برنامه هفتگی',lesson+' کلاس امروز','calendar','lilac','schedule')}
        ${tile('کتابخانه دیجیتال','جزوه و منابع درسی','library','lilac','resources',true)}
        ${tile('کارنامه','نیم‌سال اول و دوم','report','peach','results',true)}
      </div>
      <section class="msy-today"><div class="msy-section-head"><h2>کارهای امروز</h2><span>${escape(lessonDate)}</span></div>${list.join('')}</section>
      <section class="msy-actions"><div class="msy-section-head"><h2>پیگیری‌های مهم</h2><button type="button" data-msy-go="more">همه امکانات ${svg('arrow',14)}</button></div>${actions}</section>
      <div class="msy-more-row"><button type="button" data-msy-go="notifications">${svg('notify',20)} اعلان‌ها <b>${escape(notes)}</b></button><button type="button" data-msy-go="more">${svg('more',20)} همه بخش‌ها</button></div>`;
    root.append(block);
    all('[data-msy-go]',block).forEach(b=>b.addEventListener('click',()=>nav(b.dataset.msyGo)));
  }
  let lastHero=null,lastPage=null,scheduled=false;
  function inspect(){
    scheduled=false;
    const app=$('#appView'),page=$('#page');
    if(!app||!page)return;
    const active=!app.classList.contains('hidden');
    document.body.classList.toggle('msy-girl-app',active);
    const hero=active?$('.v115-hero',page):null;
    document.body.classList.toggle('msy-girl-home',Boolean(hero));
    decorateNav();
    if(!hero){lastHero=null;lastPage=null;return;}
    if(lastHero===hero&&lastPage===page&&$('#msyGirlHome'))return;
    lastHero=hero;lastPage=page;
    $('#msyGirlHome')?.remove();
    makeHome(page);
  }
  function schedule(){if(scheduled)return;scheduled=true;setTimeout(inspect,100);}
  const scope=$('#appView')||document.body;
  new MutationObserver(schedule).observe(scope,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
  window.addEventListener('online',schedule);window.addEventListener('popstate',schedule);
  document.addEventListener('click',e=>{
    if(e.target.closest('#bottomNav button'))setTimeout(schedule,150);
  });
  setTimeout(inspect,200);
})();
