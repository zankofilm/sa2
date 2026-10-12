import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const js=readFileSync(new URL('app/src/main/assets/girl-dashboard.js',root),'utf8');
const css=readFileSync(new URL('app/src/main/assets/girl-dashboard.css',root),'utf8');
const native=readFileSync(new URL('app/src/main/java/ir/madreseyar/student/MainActivity.java',root),'utf8');
test('girly dashboard has eight actual navigational tiles and does not alter school data',()=>{
  for(const label of ['پیام‌ها','آزمون‌ها','تکالیف','حضور و غیاب','نمرات','برنامه هفتگی','کتابخانه دیجیتال','کارنامه'])assert.ok(js.includes(`tile('${label}'`), label);
  assert.match(js,/parseStat\('آزمون‌های فعال'\)/);
  assert.match(js,/parseStat\('تکالیف باقی‌مانده'\)/);
  assert.doesNotMatch(js, /localStorage\.setItem|fetch\(/);
});
test('login and module pages remain available while home uses chosen design',()=>{
  assert.match(js, /const active=!app\.classList\.contains\('hidden'\)/);
  assert.match(js, /msy-girl-home/);
  assert.match(css,/body\.msy-girl-home #page> :not\(#msyGirlHome\)/);
  assert.match(js,/programmaticReportNavigation/);
});
test('native double-toolbar removed and no security origin changes',()=>{
  assert.match(native,/installStudentDesign\(\);/);
  assert.doesNotMatch(native,/root\.addView\(toolbar/);
  assert.match(native,/EXPECTED_HOST = "scooljavanrood\.ir"/);
  assert.match(native,/isSafeStudentUrl\(Uri\.parse\(web\.getUrl\(\)\)\)/);
});
test('local visual assets and Firebase code still present',()=>{
  assert.ok(readFileSync(new URL('app/src/main/assets/hero-girl.png',root)).length>20000);
  assert.match(native,/tryRegisterPush\(\)/);
  assert.match(native,/connectFirebaseIfConfigured\(\)/);
});
