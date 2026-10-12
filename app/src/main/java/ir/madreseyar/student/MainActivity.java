package ir.madreseyar.student;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

import org.json.JSONObject;
import java.util.UUID;

/** Thin native shell around the existing, authoritative school student portal.
 * No local copies of live student records are bundled in the APK.
 * Existing IndexedDB and Service Worker caching stay under the verified HTTPS origin. */
public final class MainActivity extends Activity {
    private static final String EXPECTED_HOST = "scooljavanrood.ir";
    private static final String TOKEN_KEY = "msy.v13.token";
    private static final int NOTIFICATION_PERMISSION_REQUEST = 901;
    private static final int FILE_REQUEST = 902;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView web;
    private ValueCallback<Uri[]> uploadCallback;
    private String pushToken = "";
    private String destination = "";
    private boolean webReady = false;
    private final Runnable refreshBinding = new Runnable() {
        @Override public void run() {
            tryRegisterPush();
            handler.postDelayed(this, 18000);
        }
    };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(246,240,255));
        getWindow().setNavigationBarColor(Color.rgb(252,249,255));
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        NotificationHelper.createChannel(this);
        destination = getIntent().getStringExtra("screen");
        buildLayout();
        askNotificationPermission();
        connectFirebaseIfConfigured();
        web.loadUrl(BuildConfig.STUDENT_URL);
        handler.postDelayed(refreshBinding, 7000);
    }

    private int dp(float x) { return Math.round(x * getResources().getDisplayMetrics().density); }

    private void buildLayout() {
        // The previous version duplicated the site's toolbar; keep a single coherent UI.
        FrameLayout root = new FrameLayout(this);
        root.setFitsSystemWindows(true);
        root.setBackgroundColor(Color.rgb(252,249,255));
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(-1,-1));
        setContentView(root);
        setupWeb();
    }

    private String readAsset(String filename) throws java.io.IOException {
        try (java.io.InputStream input = getAssets().open(filename);
             java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream()) {
            byte[] buf = new byte[8192]; int n;
            while ((n = input.read(buf)) >= 0) output.write(buf, 0, n);
            return new String(output.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }
    private void installStudentDesign() {
        if (!webReady) return;
        try {
            String css = readAsset("girl-dashboard.css");
            String js = readAsset("girl-dashboard.js");
            byte[] illustration;
            try (java.io.InputStream input=getAssets().open("hero-girl.png");
                 java.io.ByteArrayOutputStream out=new java.io.ByteArrayOutputStream()) {
                byte[] buf=new byte[8192]; int n;
                while((n=input.read(buf))>=0)out.write(buf,0,n);
                illustration=out.toByteArray();
            }
            String image = "data:image/png;base64," + android.util.Base64.encodeToString(illustration,android.util.Base64.NO_WRAP);
            // Same-origin WebView javascript; never expose native bridges or school tokens to external URLs.
            web.evaluateJavascript("(function(){var s=document.getElementById('msyNativeStyle');"+
                "if(!s){s=document.createElement('style');s.id='msyNativeStyle';document.head.appendChild(s);}"+
                "s.textContent="+JSONObject.quote(css)+";window.__msyGirlArtData="+JSONObject.quote(image)+";})()", null);
            web.evaluateJavascript(js, null);
        } catch (Exception ex) {
            android.util.Log.e("Madreseyar", "Student theme could not be loaded", ex);
        }
    }

    private View action(String symbol, String label, Runnable click) {
        TextView b = new TextView(this);
        b.setText(symbol); b.setTextSize(23); b.setGravity(Gravity.CENTER);
        b.setTextColor(Color.rgb(103,58,183)); b.setContentDescription(label);
        b.setBackgroundResource(R.drawable.round_button);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(dp(44),dp(42));
        p.setMarginStart(dp(6)); b.setLayoutParams(p);
        b.setOnClickListener(v -> click.run());
        return b;
    }

    private void setupWeb() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true); // Android's system document picker returns content: URIs.
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT); // Respect site's Service Worker/IndexedDB.
        web.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (isSafeStudentUrl(url)) return false;
                if ("https".equalsIgnoreCase(url.getScheme())) {
                    openExternal(url); return true;
                }
                return true; // Block file:, javascript:, intent:, content:, and insecure HTTP.
            }
            @Override public void onPageFinished(WebView v, String url) {
                webReady = isSafeStudentUrl(Uri.parse(url));
                if(webReady) {
                    installStudentDesign();
                    tryRegisterPush();
                    handler.postDelayed(() -> navigatePending(), 1100);
                }
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest request,
                                                     android.webkit.WebResourceError error) {
                if(request.isForMainFrame()) Toast.makeText(MainActivity.this,
                    "اتصال برقرار نیست؛ اطلاعات ذخیره‌شده در صورت وجود نمایش داده می‌شوند.", Toast.LENGTH_LONG).show();
            }
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public boolean onShowFileChooser(WebView w, ValueCallback<Uri[]> callback, FileChooserParams p) {
                if(uploadCallback!=null) uploadCallback.onReceiveValue(null);
                uploadCallback=callback;
                try {
                    Intent picker = p.createIntent();
                    picker.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(picker,FILE_REQUEST);
                    return true;
                } catch(Exception e) {
                    uploadCallback=null;callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this,"انتخاب فایل در دسترس نیست",Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                Uri uri = Uri.parse(url);
                if (!"https".equalsIgnoreCase(uri.getScheme()) || !EXPECTED_HOST.equalsIgnoreCase(uri.getHost())) {
                    Toast.makeText(this,"این دانلود باید از وب‌سایت معتبر مدرسه انجام شود",Toast.LENGTH_LONG).show();return;
                }
                String name = android.webkit.URLUtil.guessFileName(url,contentDisposition,mimeType);
                DownloadManager.Request req = new DownloadManager.Request(uri);
                req.setTitle(name); req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalFilesDir(this,Environment.DIRECTORY_DOWNLOADS,name);
                req.addRequestHeader("Cookie",CookieManager.getInstance().getCookie(url)==null?"":CookieManager.getInstance().getCookie(url));
                ((DownloadManager)getSystemService(DOWNLOAD_SERVICE)).enqueue(req);
                Toast.makeText(this,"دریافت فایل شروع شد",Toast.LENGTH_SHORT).show();
            } catch(Exception e) { Toast.makeText(this,"دانلود ممکن نیست: "+e.getMessage(),Toast.LENGTH_LONG).show(); }
        });
    }

    private boolean isSafeStudentUrl(Uri u) {
        return u!=null && "https".equalsIgnoreCase(u.getScheme()) && EXPECTED_HOST.equalsIgnoreCase(u.getHost())
            && u.getPath()!=null && u.getPath().startsWith("/app/student/");
    }
    private void openExternal(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW,u)); }
        catch(ActivityNotFoundException e) { Toast.makeText(this,"مرورگر برای باز کردن لینک یافت نشد",Toast.LENGTH_SHORT).show(); }
    }
    private void runJS(String script) {
        if(webReady && isSafeStudentUrl(Uri.parse(web.getUrl()))) web.evaluateJavascript(script,null);
    }
    private void navigate(String screen) {
        if (!webReady) { destination=screen; return; }
        String js;
        switch (screen) {
            case "chat": js="document.getElementById('p58Launch')?.click()"; break;
            case "notifications": js="document.getElementById('notificationsBtn')?.click()"; break;
            case "tasks": case "exams": case "home": case "results": case "more":
                js="document.querySelector('#bottomNav [data-page="+JSONObject.quote(screen)+"]')?.click()"; break;
            default: return;
        }
        runJS(js);
    }
    private void navigatePending() {
        if(!webReady || destination==null || destination.isEmpty()) return;
        web.evaluateJavascript("(function(){var v=document.getElementById('appView');return Boolean(v&&!v.classList.contains('hidden'));})()", value->{
            if("true".equals(value)) {String screen=destination;destination="";navigate(screen);}
            else if(destination!=null&&!destination.isEmpty()) handler.postDelayed(this::navigatePending,2000);
        });
    }
    private boolean hasInternet() {
        ConnectivityManager cm=(ConnectivityManager)getSystemService(CONNECTIVITY_SERVICE);
        NetworkCapabilities c=cm==null?null:cm.getNetworkCapabilities(cm.getActiveNetwork());
        return c!=null && c.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }
    private void updateNow() {
        if(!hasInternet()) { Toast.makeText(this,"اینترنت لازم است؛ داده‌های قبلی حذف نمی‌شوند",Toast.LENGTH_LONG).show();return; }
        // Trigger the REAL existing web app's manual sync, not an unrelated webview refresh.
        runJS("(function(){if(document.getElementById('examTimer')){alert('هنگام آزمون، صفحه را تغییر ندهید؛ پاسخ شما حفظ می‌شود.');return;}"+
            "var b=document.querySelector('#bottomNav [data-page=\"more\"]');if(b)b.click();"+
            "setTimeout(function(){var s=document.getElementById('manualSyncBtn');if(s)s.click();},180);})()");
    }
    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT>=33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
    }
    private String deviceId() {
        SharedPreferences p=getSharedPreferences("mobile-install",MODE_PRIVATE);
        String id=p.getString("id","");
        if(id.isEmpty()){id=UUID.randomUUID().toString();p.edit().putString("id",id).apply();}
        return id;
    }
    private void connectFirebaseIfConfigured() {
        // FirebaseApp is created from google-services.json automatically when configured.
        if (FirebaseApp.getApps(this).isEmpty()) {
            Toast.makeText(this,"Push غیرفعال است: تنظیمات Firebase نصب نشده",Toast.LENGTH_LONG).show();
            return;
        }
        FirebaseMessaging.getInstance().getToken().addOnSuccessListener(t -> {pushToken=t;tryRegisterPush();})
            .addOnFailureListener(e->Toast.makeText(this,"دریافت شناسه اعلان ناموفق بود",Toast.LENGTH_LONG).show());
    }
    /** Register FCM token only from authenticated HTTPS origin. Do NOT expose a JS interface to websites. */
    private void tryRegisterPush() {
        if(!webReady || pushToken.isEmpty() || !hasInternet()) return;
        String fcm=JSONObject.quote(pushToken), id=JSONObject.quote(deviceId());
        String script="(function(){var bearer=localStorage.getItem('"+TOKEN_KEY+"');if(!bearer)return;"+
            "var key=bearer.slice(-24)+'|'+"+fcm+";if(window.__msyPushLinked===key)return;"+
            "if(window.__msyPushBusy)return;window.__msyPushBusy=true;"+
            "localStorage.setItem('msy.nativePush.deviceId',"+id+");"+
            "fetch('/app/api/student/mobile-push/register',{method:'POST',headers:{'Authorization':'Bearer '+bearer,'Content-Type':'application/json'},"+
            "body:JSON.stringify({deviceId:"+id+",token:"+fcm+"})})"+
            ".then(function(r){if(!r.ok)throw Error('FCM registration '+r.status);return r.json()})"+
            ".then(function(d){if(d.enabled)window.__msyPushLinked=key;})"+
            ".catch(function(){/* remains pending until backend and credentials are configured */})"+
            ".finally(function(){window.__msyPushBusy=false});})();";
        runJS(script);
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent);
        destination=intent.getStringExtra("screen");
        handler.postDelayed(this::navigatePending,700);
    }
    @Override protected void onResume() {
        super.onResume(); if(web!=null){web.onResume();handler.postDelayed(this::tryRegisterPush,1000);}
    }
    @Override protected void onPause() { if(web!=null)web.onPause();super.onPause(); }
    @Override protected void onDestroy() {handler.removeCallbacksAndMessages(null);if(web!=null)web.destroy();super.onDestroy();}
    @Override public void onBackPressed() {
        if(web!=null&&web.canGoBack())web.goBack();else super.onBackPressed();
    }
    @Override protected void onActivityResult(int requestCode,int resultCode,Intent data) {
        super.onActivityResult(requestCode,resultCode,data);
        if(requestCode!=FILE_REQUEST||uploadCallback==null)return;
        Uri[] result = null;
        if(resultCode==RESULT_OK && data!=null){
            if(data.getClipData()!=null){int n=data.getClipData().getItemCount();result=new Uri[n];for(int i=0;i<n;i++)result[i]=data.getClipData().getItemAt(i).getUri();}
            else if(data.getData()!=null)result=new Uri[]{data.getData()};
        }
        uploadCallback.onReceiveValue(result);uploadCallback=null;
    }
}
