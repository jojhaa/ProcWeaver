package com.procweaver.mobile

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override val handleBackNavigation: Boolean = false
  private var currentWebView: android.webkit.WebView? = null
  private var foreground = false
  private var lastInsets = ""
  private fun updateInsets(force: Boolean = false) {
    val payload = MobileInsets.read(this)?.toString() ?: return
    val webView = currentWebView ?: return
    if (!force && payload == lastInsets) return
    lastInsets = payload
    webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('procweaver-window-insets',{detail:$payload}));", null)
  }
  private val importIo = java.util.concurrent.Executors.newSingleThreadExecutor()
  private fun notifyImport() {
    if (SharedImports.hasPending()) currentWebView?.evaluateJavascript("window.__PROCWEAVER_IMPORT_PENDING__=true;window.dispatchEvent(new CustomEvent('procweaver-navigate-tab',{detail:'profiles'}));window.dispatchEvent(new Event('procweaver-import-ready'));", null)
  }
  private fun receiveImport(value: android.content.Intent?) {
    importIo.execute {
      try { if (SharedImports.receive(this, value)) runOnUiThread { notifyImport() } }
      catch (_: Exception) { runOnUiThread { android.widget.Toast.makeText(this, "无法读取分享内容，请选择不超过 8 MB 的配置文件", android.widget.Toast.LENGTH_LONG).show() } }
    }
  }
  override fun onNewIntent(intent: android.content.Intent) { super.onNewIntent(intent); setIntent(intent); receiveImport(intent) }
  override fun onWebViewCreate(webView: android.webkit.WebView) {
    super.onWebViewCreate(webView)
    currentWebView = webView
    webView.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> updateInsets() }
    if (foreground) webView.onResume()
    updateVisibility()
    webView.postDelayed({ notifyImport() }, 1500)
  }
  private fun updateVisibility() {
    currentWebView?.evaluateJavascript("window.__PROCWEAVER_BACKGROUND__=${!foreground};document.dispatchEvent(new Event('visibilitychange'));", null)
  }
  override fun onResume() {
    super.onResume()
    foreground = true
    updateVisibility()
    currentWebView?.post { currentWebView?.requestLayout(); currentWebView?.invalidate(); updateInsets(true) }
  }
  override fun onPause() {
    foreground = false
    updateVisibility()
    super.onPause()
  }
  override fun onDestroy() { currentWebView = null; importIo.shutdown(); super.onDestroy() }
  private fun handleMobileBack() {
    val webView = currentWebView
    if (webView == null) { moveTaskToBack(true); return }
    webView.evaluateJavascript("(() => { const dialog = document.querySelector('dialog[open]'); if (dialog) { if (dialog.dispatchEvent(new Event('cancel', {cancelable:true}))) dialog.close(); return true; } return !window.dispatchEvent(new Event('procweaver-android-back', {cancelable:true})); })()") { handled ->
      if (handled != "true") moveTaskToBack(true)
    }
  }
  override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
    if (event.keyCode == android.view.KeyEvent.KEYCODE_BACK) {
      if (event.action == android.view.KeyEvent.ACTION_UP && !event.isCanceled) handleMobileBack()
      return true
    }
    return super.dispatchKeyEvent(event)
  }
  override fun onCreate(savedInstanceState: Bundle?) {
    val token = java.io.File(filesDir, "controller-token")
    if (!token.exists()) {
      val bytes = ByteArray(32).also { java.security.SecureRandom().nextBytes(it) }
      openFileOutput("controller-token", MODE_PRIVATE).use { it.write(bytes.joinToString("") { byte -> "%02x".format(byte) }.toByteArray()) }
    }
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
      override fun handleOnBackPressed() = handleMobileBack()
    })
    NativeRuntime.filesDirectory = filesDir
    UpdateJobService.schedule(this)
    receiveImport(intent)
  }
}
