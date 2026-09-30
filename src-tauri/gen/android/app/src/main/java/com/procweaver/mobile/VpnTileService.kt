package com.procweaver.mobile

import android.app.PendingIntent
import android.content.Intent
import android.net.VpnService
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

class VpnTileService : TileService() {
    override fun onTileAdded() { super.onTileAdded(); refresh() }
    override fun onStartListening() { super.onStartListening(); refresh() }
    private fun refresh() {
        val status = ProcWeaverVpnService.snapshot()
        qsTile?.let {
            it.state = when { status.optBoolean("starting") -> Tile.STATE_UNAVAILABLE; status.optBoolean("running") -> Tile.STATE_ACTIVE; else -> Tile.STATE_INACTIVE }
            it.label = "ProcWeaver"
            it.subtitle = when { status.optBoolean("starting") -> "正在连接"; status.optBoolean("running") -> "已连接"; status.optString("error").isNotEmpty() -> "连接失败，请打开应用"; else -> "已断开" }
            it.updateTile()
        }
    }
    override fun onClick() {
        super.onClick()
        if (isLocked) { unlockAndRun { toggle() } } else toggle()
    }
    private fun toggle() {
        if (ProcWeaverVpnService.snapshot().optBoolean("starting")) { refresh(); return }
        android.util.Log.d("ProcWeaverTile", "用户触发 VPN 磁贴")
        try {
        if (ProcWeaverVpnService.snapshot().optBoolean("running")) {
            startService(Intent(this, ProcWeaverVpnService::class.java).setAction(ProcWeaverVpnService.STOP))
        } else if (VpnService.prepare(this) == null) {
            try { startForegroundService(Intent(this, ProcWeaverVpnService::class.java).setAction(VpnService.SERVICE_INTERFACE)) }
            catch (_: Exception) { openApp() }
        } else openApp()
        } catch (_: Exception) { openApp() }
        refresh()
    }
    private fun openApp() {
        val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (android.os.Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this, 5, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        else { @Suppress("DEPRECATION") startActivityAndCollapse(intent) }
    }
}
