package com.procweaver.mobile

import android.app.Activity
import android.content.Intent
import android.provider.Settings
import app.tauri.plugin.JSObject
import java.net.NetworkInterface

object MobileSystem {
    fun openSettings(activity: Activity, page: String) {
        val intent = when (page) {
            "vpn" -> Intent(Settings.ACTION_VPN_SETTINGS)
            "battery" -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            "usage" -> Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
            "app" -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:${activity.packageName}"))
            else -> error("未知系统设置")
        }
        activity.startActivity(intent)
    }
    fun networkInfo(context: android.content.Context): JSObject {
        val addresses = org.json.JSONArray()
        NetworkInterface.getNetworkInterfaces()?.toList()?.filter { it.isUp && !it.isLoopback && !it.name.startsWith("tun") }
            ?.forEach { iface -> iface.inetAddresses.toList().filter { it is java.net.Inet4Address && !it.isLoopbackAddress && !it.isLinkLocalAddress }
                .forEach { addresses.put(JSObject().put("interface", iface.name).put("address", it.hostAddress)) } }
        val maintenance = context.getSharedPreferences("maintenance", android.content.Context.MODE_PRIVATE)
        return JSObject().put("addresses", addresses).put("vpn", ProcWeaverVpnService.snapshot())
            .put("maintenance", JSObject().put("checkedAt", maintenance.getLong("checkedAt", 0))
                .put("success", maintenance.getBoolean("success", false)))
    }
}
