import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const script=readFileSync(new URL('../app/src/main/assets/girl-dashboard.js', import.meta.url),'utf8');
function mkText(text){return {textContent:text,innerText:text,querySelector(sel){if(sel==='b'||sel==='strong')return {textContent:this.textContent};return null}};}
test('dashboard renders with actual values, keeping original home markup',()=>{
  let html='', appended=0;const liveNav={};
  for(const p of ['home','tasks','exams','results','more'])liveNav[p]={dataset:{page:p},addEventListener(){},set innerHTML(x){this.template=x},get innerHTML(){return this.template}};
  const hero={querySelector(sel){if(sel==='h2')return mkText('سلام نازنین 👋');if(sel==='p')return mkText('مدرسه نمونه · پایه هفتم');if(sel==='.v115-home-status')return mkText('آنلاین');return null}};
  const statNames=['تکالیف باقی‌مانده','آزمون‌های فعال','کلاس‌های امروز','اعلان‌های خوانده‌نشده'];
  const stats=statNames.map((s,i)=>({textContent:s,querySelector(){return mkText(['۲','۱','۳','۱۳'][i])}}));
  const page={append(x){html=x.innerHTML;appended++},querySelector(sel){if(sel==='.v115-hero')return hero;return null},querySelectorAll(sel){if(sel==='.p48-today-stat')return stats;return []}};
  const app={classList:{contains(){return false}}};
  const bottom={querySelector(sel){for(const [k,v] of Object.entries(liveNav))if(sel.includes('"'+k+'"'))return v;return null}};
  const document={body:{classList:{toggle(){}},addEventListener(){}},querySelector(sel){if(sel==='#appView')return app;if(sel==='#page')return page;if(sel==='.v115-hero')return hero;if(sel==='#bottomNav')return bottom;if(sel==='#syncLabel')return mkText('حالت محلی');if(sel==='#p58Badge')return {hidden:false,textContent:'۴'};if(sel==='#msyGirlHome')return null;return null;},querySelectorAll(sel){if(sel==='.p48-today-stat')return stats;return []},createElement(){return {id:'',innerHTML:'',addEventListener(){},querySelectorAll(){return []}}},addEventListener(){}};
  const window={__msyGirlArtData:'data:image/png;base64,abc',addEventListener(){}};
  vm.runInNewContext(script,{document,window,navigator:{onLine:true},setTimeout:fn=>fn(),MutationObserver:class{observe(){}},Intl,Date,alert(){}});
  assert.equal(appended,1);assert.match(html,/سلام نازنین/);assert.match(html,/۲ تکلیف باقی‌مانده/);assert.match(html,/۱ آزمون فعال/);assert.match(html,/۱۳/);assert.match(html,/کارهای امروز/);assert.match(html,/data-msy-go="chat"/);assert.match(html,/data-msy-go="sync"/);
});
