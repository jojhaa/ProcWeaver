package com.procweaver.mobile

import android.app.AppOpsManager
import android.app.usage.NetworkStats
import android.app.usage.NetworkStatsManager
import android.content.Context
import android.net.ConnectivityManager
import app.tauri.plugin.JSObject

object TrafficHistory {
    @Suppress("DEPRECATION")
    fun query(context: Context, start: Long, end: Long): JSObject {
        val access = context.getSystemService(AppOpsManager::class.java).unsafeCheckOpNoThrow(
            AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), context.packageName) == AppOpsManager.MODE_ALLOWED
        if (!access) return JSObject().put("granted", false).put("rows", org.json.JSONArray())
        check(start > 0 && end > start && end - start <= 32L * 86400000 && end <= System.currentTimeMillis() + 86400000) { "统计时间范围无效" }
        val totals = mutableMapOf<Int, LongArray>()
        val manager = context.getSystemService(NetworkStatsManager::class.java)
        for (type in listOf(ConnectivityManager.TYPE_WIFI, ConnectivityManager.TYPE_MOBILE)) {
            val stats = manager.querySummary(type, null, start, end) ?: continue
            try {
                val bucket = NetworkStats.Bucket()
                while (stats.hasNextBucket()) {
                    stats.getNextBucket(bucket)
                    val values = totals.getOrPut(bucket.uid) { longArrayOf(0, 0) }
                    values[0] += bucket.txBytes; values[1] += bucket.rxBytes
                }
            } finally { stats.close() }
        }
        val rows = org.json.JSONArray()
        totals.entries.sortedByDescending { it.value.sum() }.forEach { (uid, bytes) ->
            val packages = context.packageManager.getPackagesForUid(uid)?.toList() ?: emptyList()
            val label = packages.firstOrNull()?.let { name -> runCatching { context.packageManager.getApplicationLabel(context.packageManager.getApplicationInfo(name, 0)).toString() }.getOrNull() }
                ?: if (uid < 0) "系统汇总项 ($uid)" else "已卸载应用 / UID $uid"
            rows.put(JSObject().put("uid", uid).put("label", label).put("packages", org.json.JSONArray(packages))
                .put("upload", bytes[0]).put("download", bytes[1]))
        }
        return JSObject().put("granted", true).put("rows", rows).put("start", start).put("end", end)
    }
}
