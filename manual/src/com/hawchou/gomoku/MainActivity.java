package com.hawchou.gomoku;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 五子棋 WebView 封装（纯前端，无原生逻辑）。
 * 游戏本体在 assets/www/ 下，通过 file:///android_asset 加载。
 *
 * 【2026-08-22 v1.1.3 自诊断版】新增：
 * - WebChromeClient.onConsoleMessage：捕获页面 JS 错误/警告 → diag.txt + logcat
 * - WebViewClient.onReceivedError / onReceivedHttpError：捕获资源/网络加载失败 → diag.txt
 * - onPageFinished：记录页面加载完成事件
 * - setWebContentsDebuggingEnabled(true)：个人侧载包常开，PC Chrome chrome://inspect 可远程调试
 * 取证路径：手机插电脑 → MTP → Android/data/com.hawchou.gomoku/files/diag.txt
 */
public class MainActivity extends Activity {

    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        diag("APP", "启动 onCreate");

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        // 【2026-08-22 禁捏合缩放·同坦克 v1.0.3】WebView 原生层彻底关闭缩放：
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        // 【GOKUP-005 v1.1.6】注入 APK 平台标记：JS 检测 UA 含 "GomokuApp" 即禁用
        // 应用内棋盘缩放（按钮/菜单/捏合/滚轮），符合 Android 官方「构建自适应
        // 游戏」理念——布局自动适配屏幕，不提供手动缩放。Web 桌面版无此标记，
        // 缩放功能保留。
        settings.setUserAgentString(settings.getUserAgentString() + " GomokuApp/1.2.9");

        // 【v1.2.6 对局强制竖屏】暴露原生桥给 JS：进入对局 → setPortrait(true)
        // 锁定竖屏；回大厅 → setPortrait(false) 恢复系统自由方向（用户拍板：仅对局锁）。
        webView.addJavascriptInterface(new GomokuBridge(), "GomokuBridge");

        // 个人侧载包常开（正式上架前应改回 BuildConfig.DEBUG 门控）
        WebView.setWebContentsDebuggingEnabled(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme();
                if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
                    diag("EXT", "外部链接交系统浏览器: " + uri);
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception e) {
                        diag("EXT", "无浏览器可处理: " + e.getMessage());
                    }
                    return true;
                }
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                diag("WVE", "加载失败 err=" + (error != null ? error.getDescription() : "?")
                        + " code=" + (error != null ? error.getErrorCode() : "?")
                        + " url=" + request.getUrl());
                super.onReceivedError(view, request, error);
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            android.webkit.WebResourceResponse errorResponse) {
                diag("WVE-HTTP", "HTTP 错误 " + (errorResponse != null ? errorResponse.getStatusCode() : "?")
                        + " url=" + request.getUrl());
                super.onReceivedHttpError(view, request, errorResponse);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                diag("PAGE", "页面加载完成: " + url);
                super.onPageFinished(view, url);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                diag("JS-" + cm.messageLevel(), cm.message()
                        + " @ " + cm.sourceId() + ":" + cm.lineNumber());
                return true;
            }
        });

        diag("APP", "开始加载 file:///android_asset/www/index.html");
        webView.loadUrl("file:///android_asset/www/index.html");
        setContentView(webView);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    /** 追加一行诊断到 diag.txt（getExternalFilesDir，MTP 可见）并同步 logcat。 */
    private void diag(String tag, String msg) {        String line = "[" + new SimpleDateFormat("HH:mm:ss", Locale.US).format(new Date())
                + "][" + tag + "] " + msg;
        Log.w("GomokuDiag", line);
        try {
            File dir = getExternalFilesDir(null);
            if (dir == null) return;
            File f = new File(dir, "diag.txt");
            FileOutputStream fos = new FileOutputStream(f, true);
            try {
                fos.write((line + "\n").getBytes("UTF-8"));
            } finally {
                fos.close();
            }
        } catch (Exception e) {
            // 诊断本身失败不阻塞运行
        }
    }

    private static final String TAG = "GomokuDiag";

    /**
     * 【v1.2.6 对局强制竖屏】JS 桥：window.GomokuBridge.setPortrait(on)。
     * - on=true  → 锁定竖屏（对局全流程：设置态 + 沉浸态）
     * - on=false → 恢复系统自由方向（回大厅）
     * 注意：Manifest 不加静态 screenOrientation 属性——方向锁完全由 JS 动态控制，
     * 大厅/历史等非对局界面仍可横竖屏自由旋转。
     */
    public class GomokuBridge {
        @JavascriptInterface
        public void setPortrait(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        setRequestedOrientation(on
                                ? ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                                : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                    } catch (Exception e) {
                        // 方向锁失败不阻塞对局（WebView 侧仍按 CSS 竖排渲染）
                    }
                }
            });
        }
    }
}
