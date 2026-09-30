package com.procweaver.mobile

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.PermissionState
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.util.concurrent.Executors

private data class InstalledAppRow(
    val info: android.content.pm.ApplicationInfo,
    val label: String,
    val launchable: Boolean,
    val systemApp: Boolean,
)

@InvokeArg
class CoreArgs {
    var config: String = ""
    var ipv6: Boolean = false
    var mode: String = ""
}

@InvokeArg
class HealthArgs { var payload: String = "" }

@TauriPlugin(permissions = [Permission(strings = [android.Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")])
class VpnPlugin(private val activity: Activity) : Plugin(activity) {
    private val io = Executors.newFixedThreadPool(2)
    private val probes = Executors.newFixedThreadPool(4)
    private val probeNetwork = ProbeNetwork(activity.applicationContext)

    @Command
    fun healthProbe(invoke: Invoke) {
        val args = invoke.parseArgs(HealthArgs::class.java)
        val task = Runnable {
            try {
                val result = JSObject(NativeCore.health(File(activity.filesDir, "core_data").path, args.payload, probeNetwork))
                if (result.optString("error").isNotEmpty()) invoke.reject(result.getString("error")) else invoke.resolve(result)
            } catch (_: Throwable) { invoke.reject("Android 节点检测失败") }
        }
        // Cancellation must not queue behind the requests it is cancelling.
        if (runCatching { org.json.JSONObject(args.payload).optString("action") }.getOrNull() == "end") io.execute(task) else probes.execute(task)
    }

    @Command
    fun installUpdate(invoke: Invoke) {
        val args = invoke.parseArgs(MobileArgs::class.java)
        io.execute {
            try {
                val archive = File(args.path).canonicalFile
                check(archive.parentFile == File(activity.filesDir, ".update_cache").canonicalFile && archive.extension == "apk" && archive.isFile) { "更新包路径无效" }
                val pm = activity.packageManager
                val candidate = pm.getPackageArchiveInfo(archive.path, android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES) ?: error("APK 格式无效")
                val installed = pm.getPackageInfo(activity.packageName, android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES)
                check(candidate.packageName == activity.packageName && candidate.longVersionCode > installed.longVersionCode) { "更新包不属于本应用或版本未递增" }
                val before = installed.signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet()
                val after = candidate.signingInfo?.apkContentsSigners?.map { it.toCharsString() }?.toSet()
                check(!before.isNullOrEmpty() && before == after) { "更新包签名与已安装版本不一致" }
                activity.runOnUiThread {
                    try {
                        if (!pm.canRequestPackageInstalls()) {
                            activity.startActivity(Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, android.net.Uri.parse("package:${activity.packageName}")))
                            invoke.reject("请允许此应用安装更新，然后再次点击安装")
                        } else {
                            val uri = androidx.core.content.FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", archive)
                            activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                            invoke.resolve(JSObject())
                        }
                    } catch (_: Exception) { invoke.reject("无法打开系统安装界面") }
                }
            } catch (error: Exception) { invoke.reject(error.message ?: "更新包验证失败") }
        }
    }

    @Command
    fun mobileAction(invoke: Invoke) {
        val args = invoke.parseArgs(MobileArgs::class.java)
        try {
            when (args.action) {
                "windowInsets" -> activity.runOnUiThread {
                    val insets = MobileInsets.read(activity)
                    if (insets != null) invoke.resolve(insets) else invoke.reject("系统窗口尚未就绪")
                }
                "appearance" -> {
                    check(args.page == "light" || args.page == "dark") { "主题无效" }
                    activity.runOnUiThread {
                        try {
                            val bars = androidx.core.view.WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                            bars.isAppearanceLightStatusBars = args.page == "light"
                            bars.isAppearanceLightNavigationBars = args.page == "light"
                            invoke.resolve(JSObject())
                        } catch (_: Exception) { invoke.reject("同步系统栏主题失败") }
                    }
                }
                "networkInfo" -> io.execute { try { invoke.resolve(MobileSystem.networkInfo(activity)) } catch (_: Exception) { invoke.reject("读取网络信息失败") } }
                "trafficHistory" -> io.execute { try { invoke.resolve(TrafficHistory.query(activity, args.start, args.end)) } catch (_: Exception) { invoke.reject("读取系统流量历史失败，请检查使用情况访问权限") } }
                "proxyHistory", "clearProxyHistory" -> io.execute {
                    try {
                        val result = JSObject(NativeCore.history(File(activity.filesDir, "core_data").path, java.util.TimeZone.getDefault().id,
                            if (args.action == "proxyHistory") "query" else "clear", args.start, args.end))
                        if (result.optString("error").isNotEmpty()) invoke.reject(result.getString("error")) else invoke.resolve(result)
                    } catch (_: Exception) { invoke.reject("读取代理历史失败，请检查应用存储空间") }
                }
                "addVpnTile" -> {
                    if (android.os.Build.VERSION.SDK_INT >= 33) {
                        activity.getSystemService(android.app.StatusBarManager::class.java).requestAddTileService(
                            android.content.ComponentName(activity, VpnTileService::class.java), "ProcWeaver",
                            android.graphics.drawable.Icon.createWithResource(activity, R.drawable.ic_vpn), activity.mainExecutor
                        ) { code -> invoke.resolve(JSObject().put("added", code == android.app.StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ADDED || code == android.app.StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ALREADY_ADDED)) }
                    } else invoke.resolve(JSObject().put("manual", true))
                }
                "openSettings" -> { MobileSystem.openSettings(activity, args.page); invoke.resolve(JSObject()) }
                "takeImport" -> invoke.resolve(SharedImports.take())
                "readDocument" -> startActivityForResult(invoke, Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"), "readDocumentResult")
                "readQrImage" -> startActivityForResult(invoke, Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*"), "readQrImageResult")
                "scanQr" -> {
                    val options = com.journeyapps.barcodescanner.ScanOptions().setDesiredBarcodeFormats(com.journeyapps.barcodescanner.ScanOptions.QR_CODE)
                        .setPrompt("扫描订阅二维码").setBeepEnabled(false).setOrientationLocked(false)
                    startActivityForResult(invoke, com.journeyapps.barcodescanner.ScanContract().createIntent(activity, options), "scanResult")
                }
                else -> invoke.reject("未知手机操作")
            }
        } catch (_: Exception) { invoke.reject("系统无法处理此操作") }
    }

    @ActivityCallback
    fun readQrImageResult(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) { invoke.resolve(JSObject().put("cancelled", true)); return }
        io.execute {
            try { invoke.resolve(JSObject().put("content", QrImages.read(activity, uri)).put("cancelled", false)) }
            catch (_: Exception) { invoke.reject("未识别到二维码，请选择清晰且不超过 8 MB 的图片") }
        }
    }

    @ActivityCallback
    fun readDocumentResult(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) { invoke.resolve(JSObject().put("cancelled", true)); return }
        io.execute {
            try { invoke.resolve(JSObject().put("content", SharedImports.read(activity, uri)).put("cancelled", false)) }
            catch (_: Exception) { invoke.reject("读取文件失败，请选择不超过 8 MB 的文本配置") }
        }
    }

    @ActivityCallback
    fun scanResult(invoke: Invoke, result: ActivityResult) {
        val scan = com.journeyapps.barcodescanner.ScanContract().parseResult(result.resultCode, result.data)
        invoke.resolve(JSObject().put("content", scan.contents ?: "").put("cancelled", scan.contents == null))
    }

    @Command
    fun validateGeo(invoke: Invoke) {
        val args = invoke.parseArgs(MobileArgs::class.java)
        io.execute {
            try {
                val path = File(args.path).canonicalFile
                check(path == File(activity.filesDir, "core_data/.geo-candidate").canonicalFile)
                check(NativeCore.validateGeo(args.kind, path.path).isEmpty())
                invoke.resolve(JSObject())
            } catch (_: Throwable) { invoke.reject("Geo 数据库校验失败，旧文件保持不变") }
        }
    }

    @Command
    fun saveDocument(invoke: Invoke) {
        val args = invoke.parseArgs(DocumentArgs::class.java)
        if (args.content.toByteArray(Charsets.UTF_8).size > 8 * 1024 * 1024 ||
            args.filename.isBlank() || args.filename.length > 240 || args.filename.contains('/') || args.filename.contains('\\')) {
            invoke.reject("导出文件名无效或内容超过 8 MB"); return
        }
        val mime = if (args.mime in listOf("application/json", "application/x-yaml", "text/plain")) args.mime else "text/plain"
        startActivityForResult(invoke, Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime).putExtra(Intent.EXTRA_TITLE, args.filename), "documentResult")
    }

    @ActivityCallback
    fun documentResult(invoke: Invoke, result: ActivityResult) {
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) { invoke.resolve(JSObject().put("saved", false)); return }
        val args = invoke.parseArgs(DocumentArgs::class.java)
        io.execute {
            try {
                val stream = activity.contentResolver.openOutputStream(uri, "wt") ?: error("无法打开文件")
                stream.use { it.write(args.content.toByteArray(Charsets.UTF_8)) }
                invoke.resolve(JSObject().put("saved", true))
            } catch (_: Exception) { invoke.reject("保存文件失败，请重新选择位置") }
        }
    }

    @Command
    fun start(invoke: Invoke) {
        val preferences = activity.getSharedPreferences("vpn", Activity.MODE_PRIVATE)
        if (android.os.Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED &&
            !preferences.getBoolean("notificationAsked", false)) {
            preferences.edit().putBoolean("notificationAsked", true).apply()
            requestPermissionForAlias("notifications", invoke, "notificationResult")
            return
        }
        prepareVpn(invoke)
    }

    @PermissionCallback
    fun notificationResult(invoke: Invoke) { prepareVpn(invoke) }

    private fun prepareVpn(invoke: Invoke) {
        val intent = VpnService.prepare(activity)
        if (intent == null) launch(invoke)
        else startActivityForResult(invoke, intent, "permissionResult")
    }

    @ActivityCallback
    fun permissionResult(invoke: Invoke, result: ActivityResult) {
        if (result.resultCode == Activity.RESULT_OK) launch(invoke)
        else invoke.reject("VPN 授权被取消，未启动代理")
    }

    private fun launch(invoke: Invoke) {
        val args = invoke.parseArgs(CoreArgs::class.java)
        val home = File(activity.filesDir, "core_data")
        val config = File(args.config).canonicalFile
        if (config != File(home, "config.yaml").canonicalFile) {
            invoke.reject("VPN 配置路径无效"); return
        }
        val pending = ProcWeaverVpnService.requestStart()
        try { activity.startForegroundService(Intent(activity, ProcWeaverVpnService::class.java)
            .setAction(ProcWeaverVpnService.START)
            .putExtra("generation", pending.generation)
            .putExtra("ipv6", args.ipv6)) }
        catch (_: Exception) {
            io.execute { runCatching { ProcWeaverVpnService.stopCore() } }
            invoke.reject("系统拒绝启动 VPN，请回到应用前台重试"); return
        }
        io.execute {
            try { pending.completion.get(45, java.util.concurrent.TimeUnit.SECONDS); invoke.resolve(ProcWeaverVpnService.snapshot()) }
            catch (_: java.util.concurrent.TimeoutException) {
                runCatching { ProcWeaverVpnService.cancelStart(pending.generation) }
                invoke.reject("VPN 启动超时，连接请求已取消")
            }
            catch (_: Exception) { invoke.reject(ProcWeaverVpnService.lastError.ifBlank { "VPN 启动失败" }) }
        }
    }

    @Command
    fun status(invoke: Invoke) { invoke.resolve(ProcWeaverVpnService.snapshot()) }

    @Command
    fun stats(invoke: Invoke) {
        io.execute {
            try {
                val result = JSObject(NativeCore.stats())
                result.put("epoch", ProcWeaverVpnService.snapshot().getLong("generation"))
                invoke.resolve(result)
            } catch (_: Throwable) { invoke.reject("核心统计暂不可用") }
        }
    }

    @Command
    fun reload(invoke: Invoke) {
        val args = invoke.parseArgs(CoreArgs::class.java)
        io.execute {
            try {
                val error = NativeCore.reload(args.config)
                if (error.isEmpty()) invoke.resolve(JSObject()) else invoke.reject("核心无法应用配置")
            } catch (_: Throwable) { invoke.reject("核心配置重载失败") }
        }
    }

    @Command
    fun mode(invoke: Invoke) {
        val args = invoke.parseArgs(CoreArgs::class.java)
        io.execute {
            try {
                val error = NativeCore.mode(args.mode)
                if (error.isEmpty()) invoke.resolve(JSObject()) else invoke.reject("核心无法切换模式")
            } catch (_: Throwable) { invoke.reject("核心模式切换失败") }
        }
    }

    @Command
    fun stop(invoke: Invoke) {
        io.execute {
            try { ProcWeaverVpnService.stopCore(); invoke.resolve(ProcWeaverVpnService.snapshot()) }
            catch (_: Exception) { invoke.reject("停止 VPN 失败，请重试") }
        }
    }

    @Command
    fun validate(invoke: Invoke) {
        val args = invoke.parseArgs(CoreArgs::class.java)
        io.execute {
            try {
                CoreAssets.prepare(activity)
                val error = NativeCore.validate(File(activity.filesDir, "core_data").path, args.config)
                if (error.isEmpty()) invoke.resolve(JSObject()) else invoke.reject("Mihomo 配置校验失败，原配置保持不变")
            } catch (_: Throwable) { invoke.reject("Android 核心不可用，无法校验配置") }
        }
    }

    @Command
    fun applications(invoke: Invoke) {
        io.execute {
            try {
                val pm = activity.packageManager
                val launchablePackages = pm.queryIntentActivities(
                    Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0
                ).mapTo(mutableSetOf<String>()) { it.activityInfo.packageName }
                val apps = pm.getInstalledApplications(0).asSequence()
                    .filter { it.packageName != activity.packageName }
                    .map { app -> InstalledAppRow(
                        app, pm.getApplicationLabel(app).toString(), app.packageName in launchablePackages,
                        app.flags and (android.content.pm.ApplicationInfo.FLAG_SYSTEM or
                            android.content.pm.ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
                    ) }
                    .sortedWith(compareBy<InstalledAppRow> { if (it.launchable) 0 else 1 }
                        .thenBy { if (it.systemApp) 1 else 0 }
                        .thenBy { it.label }.thenBy { it.info.packageName })
                    .toList()
                val result = org.json.JSONArray()
                apps.forEach { row -> result.put(org.json.JSONObject().put("packageName", row.info.packageName)
                    .put("label", row.label).put("uid", row.info.uid)
                    .put("sharedUid", (pm.getPackagesForUid(row.info.uid)?.size ?: 0) > 1)
                    .put("launchable", row.launchable).put("systemApp", row.systemApp)) }
                invoke.resolve(JSObject().put("applications", result))
            } catch (_: Exception) { invoke.reject("读取已安装应用失败") }
        }
    }
}

@InvokeArg
class DocumentArgs {
    var filename: String = ""
    var content: String = ""
    var mime: String = "text/plain"
}

@InvokeArg
class MobileArgs {
    var start: Long = 0
    var end: Long = 0
    var action: String = ""
    var page: String = ""
    var path: String = ""
    var kind: String = ""
}
