package com.procweaver.mobile

import android.content.Context
import android.content.Intent
import android.net.Uri
import app.tauri.plugin.JSObject

object SharedImports {
    private var pending: String? = null
    @Synchronized fun put(value: String) { check(value.toByteArray(Charsets.UTF_8).size <= 8*1024*1024); pending = value }
    @Synchronized fun take(): JSObject {
        val value = pending; pending = null
        return JSObject().put("content", value ?: "").put("cancelled", value == null)
    }
    @Synchronized fun hasPending(): Boolean = pending != null
    fun read(context: Context, uri: Uri): String {
        check(uri.scheme == "content") { "只接受系统文档提供者" }
        val bytes = java.io.ByteArrayOutputStream()
        context.contentResolver.openInputStream(uri)?.use { input ->
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer); if (count < 0) break
                check(bytes.size() + count <= 8*1024*1024) { "文件超过 8 MB" }
                bytes.write(buffer, 0, count)
            }
        } ?: error("无法读取文件")
        return bytes.toString("UTF-8")
    }
    fun receive(context: Context, intent: Intent?): Boolean {
        if (intent == null) return false
        val content = when (intent.action) {
            Intent.ACTION_SEND -> {
                @Suppress("DEPRECATION") val uri = intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
                if (uri != null) read(context, uri) else intent.getStringExtra(Intent.EXTRA_TEXT) ?: return false
            }
            Intent.ACTION_VIEW -> {
                val uri = intent.data ?: return false
                if (uri.scheme == "content") read(context, uri)
                else if (uri.scheme == "procweaver" && uri.host == "import") uri.getQueryParameter("url") ?: return false
                else return false
            }
            else -> return false
        }
        put(content); return true
    }
}
