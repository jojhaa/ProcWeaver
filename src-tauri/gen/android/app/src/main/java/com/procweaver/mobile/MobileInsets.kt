package com.procweaver.mobile

import android.app.Activity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.plugin.JSObject

object MobileInsets {
    fun read(activity: Activity): JSObject? {
        val root = ViewCompat.getRootWindowInsets(activity.window.decorView) ?: return null
        val bars = root.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val density = activity.resources.displayMetrics.density.toDouble()
        return JSObject().put("top", bars.top / density).put("right", bars.right / density)
            .put("bottom", bars.bottom / density).put("left", bars.left / density)
    }
}
