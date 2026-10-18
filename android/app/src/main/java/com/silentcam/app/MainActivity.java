package com.silentcam.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/** 웹 앱(assets)을 WebView 로 띄우고, 볼륨 키를 가로채 JS 로 전달합니다. */
public class MainActivity extends Activity {
    private static final String URL = "https://appassets.androidplatform.net/assets/index.html";
    private WebView web;
    private boolean loaded = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        hideSystemBars();

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        web.setBackgroundColor(0xFF000000);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override public void run() { request.grant(request.getResources()); }
                });
            }
        });
        setContentView(web);

        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            load();
        } else {
            requestPermissions(new String[]{Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO}, 1);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        load(); // 거부돼도 웹 쪽에서 안내 메시지를 보여줍니다
    }

    private void load() {
        if (loaded) return;
        loaded = true;
        web.loadUrl(URL);
    }

    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    // 볼륨 업 = 사진, 볼륨 다운 = 영상 시작/종료 (시스템 볼륨 UI·소리는 막음)
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int c = e.getKeyCode();
        if (c == KeyEvent.KEYCODE_VOLUME_UP || c == KeyEvent.KEYCODE_VOLUME_DOWN) {
            if (e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0) {
                String k = c == KeyEvent.KEYCODE_VOLUME_UP ? "up" : "down";
                web.evaluateJavascript("window.nativeKey&&window.nativeKey('" + k + "')", null);
            }
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    /** JS 에서 호출하는 네이티브 기능 */
    private class Bridge {
        private final Map<String, Object[]> files = new HashMap<>();

        @JavascriptInterface
        public void setStealth(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    WindowManager.LayoutParams lp = getWindow().getAttributes();
                    lp.screenBrightness = on ? 0f : WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
                    getWindow().setAttributes(lp);
                }
            });
        }

        // 촬영한 사진/영상을 기기 갤러리(Pictures/SilentCamera, Movies/SilentCamera)에 저장
        @JavascriptInterface
        public String saveBegin(String name, String mime, String kind) {
            try {
                boolean video = "video".equals(kind);
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH,
                        (video ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES) + "/SilentCamera");
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                ContentResolver r = getContentResolver();
                Uri uri = r.insert(video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                        : MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
                if (uri == null) return "";
                OutputStream out = r.openOutputStream(uri);
                String id = UUID.randomUUID().toString();
                files.put(id, new Object[]{uri, out});
                return id;
            } catch (Exception ex) {
                return "";
            }
        }

        @JavascriptInterface
        public void saveChunk(String id, String b64) {
            try {
                Object[] f = files.get(id);
                if (f != null) ((OutputStream) f[1]).write(Base64.decode(b64, Base64.DEFAULT));
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public void saveEnd(String id) {
            try {
                Object[] f = files.remove(id);
                if (f == null) return;
                ((OutputStream) f[1]).close();
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContentResolver().update((Uri) f[0], v, null, null);
            } catch (Exception ignored) { }
        }
    }
}
