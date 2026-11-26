package ai.arena.terminal;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.View;
import android.view.Window;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * Нативная обёртка вокруг веб-терминала.
 *
 * Приложение показывает веб-интерфейс терминала в WebView и хранит адрес сервера.
 * Адрес задаётся на стартовом экране, меняется через кнопку ⚙ на странице,
 * двойное/долгое нажатие на название «Терминал» или через меню по кнопке «Назад».
 */
public class MainActivity extends Activity {

    private static final String PREFS_NAME = "arena_terminal";
    private static final String KEY_URL = "server_url";
    private static final String DEFAULT_URL = "http://192.168.1.10:3000";

    private WebView webView;
    private ProgressBar progress;
    private View setupPanel;
    private EditText urlInput;
    private TextView errorText;
    private TextView cancelButton;
    private SharedPreferences prefs;
    private String bridgeScript;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor("#0B0F0E"));
        window.setNavigationBarColor(Color.parseColor("#080B0A"));

        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

        webView = findViewById(R.id.webview);
        progress = findViewById(R.id.progress);
        setupPanel = findViewById(R.id.setup_panel);
        urlInput = findViewById(R.id.url_input);
        errorText = findViewById(R.id.error_text);
        cancelButton = findViewById(R.id.cancel_button);

        configureWebView();

        findViewById(R.id.connect_button).setOnClickListener(v -> attemptConnect());
        cancelButton.setOnClickListener(v -> hideSetup());

        urlInput.setOnEditorActionListener((v, actionId, event) -> {
            boolean isGo = actionId == EditorInfo.IME_ACTION_GO
                    || actionId == EditorInfo.IME_ACTION_DONE
                    || actionId == EditorInfo.IME_ACTION_SEND;
            if (isGo) {
                attemptConnect();
                return true;
            }
            return false;
        });

        String saved = prefs.getString(KEY_URL, "");
        if (saved.isEmpty()) {
            urlInput.setText(DEFAULT_URL);
            urlInput.setSelection(0, DEFAULT_URL.length());
            showSetup(null);
        } else {
            hideSetup();
            loadServer(saved);
        }
    }

    /* ---------------------------------------------------------------- WebView */

    @SuppressWarnings("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString() + " ArenaTerminal/1.0");

        webView.setBackgroundColor(Color.parseColor("#080B0A"));
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.addJavascriptInterface(new NativeBridge(), "ArenaAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
                injectBridgeScript();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    progress.setVisibility(View.GONE);
                    StringBuilder message = new StringBuilder(getString(R.string.error_prefix));
                    message.append('\n').append(getString(R.string.error_hint));
                    if (error != null && error.getDescription() != null) {
                        String description = error.getDescription().toString().trim();
                        if (!description.isEmpty()) {
                            message.append('\n').append(description);
                        }
                    }
                    showSetup(message.toString());
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (newProgress >= 100) {
                    progress.setVisibility(View.GONE);
                } else {
                    progress.setProgress(newProgress);
                    progress.setVisibility(View.VISIBLE);
                }
            }
        });
    }

    private void injectBridgeScript() {
        if (bridgeScript == null) {
            bridgeScript = readBridgeScript();
        }
        if (!TextUtils.isEmpty(bridgeScript)) {
            webView.evaluateJavascript(bridgeScript, null);
        }
    }

    private String readBridgeScript() {
        StringBuilder builder = new StringBuilder();
        try (InputStream input = getResources().openRawResource(R.raw.native_bridge);
             BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                builder.append(line).append('\n');
            }
        } catch (Exception ignored) {
            return "";
        }
        return builder.toString();
    }

    /** Методы, доступные странице через объект ArenaAndroid. */
    private class NativeBridge {
        @JavascriptInterface
        public void openSettings() {
            runOnUiThread(() -> showSetup(null));
        }

        @JavascriptInterface
        public void reload() {
            runOnUiThread(() -> webView.reload());
        }
    }

    /* ---------------------------------------------------------------- server */

    private void attemptConnect() {
        String normalized = normalizeUrl(urlInput.getText().toString());
        if (normalized == null) {
            errorText.setText(R.string.invalid_url);
            errorText.setVisibility(View.VISIBLE);
            return;
        }

        prefs.edit().putString(KEY_URL, normalized).apply();
        urlInput.setText(normalized);
        urlInput.setSelection(normalized.length());
        hideKeyboard();
        hideSetup();
        loadServer(normalized);
    }

    private void loadServer(String url) {
        errorText.setVisibility(View.GONE);
        progress.setProgress(0);
        progress.setVisibility(View.VISIBLE);
        webView.loadUrl(url);
    }

    private String normalizeUrl(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) {
            return null;
        }

        String lower = value.toLowerCase(Locale.ROOT);
        if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
            if (lower.contains("://")) {
                return null;
            }
            value = "http://" + value;
        }

        try {
            URI uri = new URI(value);
            String host = uri.getHost();
            String scheme = uri.getScheme();
            if (host == null || host.trim().isEmpty() || scheme == null) {
                return null;
            }
            scheme = scheme.toLowerCase(Locale.ROOT);
            if (!scheme.equals("http") && !scheme.equals("https")) {
                return null;
            }
        } catch (Exception error) {
            return null;
        }

        while (value.length() > 8 && value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        return value;
    }

    private void showSetup(String error) {
        String saved = prefs.getString(KEY_URL, "");
        if (!saved.isEmpty()) {
            urlInput.setText(saved);
            urlInput.setSelection(saved.length());
        }
        cancelButton.setVisibility(saved.isEmpty() ? View.GONE : View.VISIBLE);

        if (error != null && !error.trim().isEmpty()) {
            errorText.setText(error);
            errorText.setVisibility(View.VISIBLE);
        } else {
            errorText.setVisibility(View.GONE);
        }

        setupPanel.setVisibility(View.VISIBLE);
        setupPanel.scrollTo(0, 0);
    }

    private void hideSetup() {
        setupPanel.setVisibility(View.GONE);
        errorText.setVisibility(View.GONE);
        hideKeyboard();
    }

    private void hideKeyboard() {
        View focus = getCurrentFocus();
        if (focus != null) {
            InputMethodManager manager = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (manager != null) {
                manager.hideSoftInputFromWindow(focus.getWindowToken(), 0);
            }
            focus.clearFocus();
        }
    }

    /* ----------------------------------------------------------------- system */

    @Override
    public void onBackPressed() {
        if (setupPanel.getVisibility() == View.VISIBLE) {
            if (!prefs.getString(KEY_URL, "").isEmpty()) {
                hideSetup();
            } else {
                super.onBackPressed();
            }
            return;
        }

        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }

        new AlertDialog.Builder(this)
                .setTitle(R.string.back_title)
                .setItems(new CharSequence[]{
                        getString(R.string.back_refresh),
                        getString(R.string.back_settings),
                        getString(R.string.back_exit)
                }, (dialog, which) -> {
                    if (which == 0) {
                        webView.reload();
                    } else if (which == 1) {
                        showSetup(null);
                    } else {
                        finish();
                    }
                })
                .setNegativeButton(R.string.back_cancel, null)
                .show();
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
