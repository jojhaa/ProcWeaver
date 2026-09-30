package com.procweaver.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.ConnectivityManager
import android.net.VpnService
import android.net.Network
import android.net.NetworkCapabilities
import android.os.ParcelFileDescriptor
import app.tauri.plugin.JSObject
import java.io.File
import java.net.InetSocketAddress
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

class ProcWeaverVpnService : VpnService() {
    companion object {
        const val START = "com.procweaver.mobile.START"
        const val STOP = "com.procweaver.mobile.STOP"
        private const val NOTIFICATION_ID = 1
        private val worker = Executors.newSingleThreadExecutor()
        @Volatile private var instance: ProcWeaverVpnService? = null
        @Volatile private var running = false
        @Volatile private var starting = false
        @Volatile private var startedAt = 0L
        @Volatile private var networkState = "等待网络"
        private val generation = AtomicLong(0)
        private var owner: ProcWeaverVpnService? = null // Accessed only by worker.
        @Volatile var lastError = ""
            private set
        private var pending = CompletableFuture<Unit>()
        data class StartRequest(val generation: Long, val completion: CompletableFuture<Unit>)
        @Synchronized fun requestStart(): StartRequest {
            if (running) return StartRequest(generation.get(), CompletableFuture.completedFuture(Unit))
            if (!starting) { generation.incrementAndGet(); pending = CompletableFuture(); starting = true; lastError = "" }
            return StartRequest(generation.get(), pending)
        }
        @Synchronized private fun requestFor(value: Long): StartRequest? =
            if (value == generation.get()) StartRequest(value, pending) else null
        fun snapshot(): JSObject = JSObject().put("running", running).put("starting", starting)
            .put("pid", android.os.Process.myPid()).put("startedAt", startedAt).put("generation", generation.get()).put("error", lastError).put("networkState", networkState)
        fun stopCore() {
            invalidateRequest()
            val service = instance
            val serviceStartId = service?.lastStartId
            worker.submit {
                (owner ?: service)?.stopInternal(true, serviceStartId)
            }.get(20, java.util.concurrent.TimeUnit.SECONDS)
        }
        @Synchronized private fun invalidateRequest() {
            generation.incrementAndGet()
            running = false; starting = false
            pending.completeExceptionally(IllegalStateException("VPN 已停止"))
        }
        @Synchronized fun cancelStart(requestGeneration: Long) {
            if (generation.get() != requestGeneration) return
            invalidateRequest()
            worker.execute { (owner ?: instance)?.stopInternal(true) }
        }
    }

    @Volatile private var lastStartId = 0
    @Volatile private var destroyed = false
    private val networkHandler = android.os.Handler(android.os.Looper.getMainLooper())
    @Volatile private var physicalNetwork: Network? = null
    private val availableNetworks = mutableMapOf<Network, NetworkCapabilities>()
    private fun choosePhysicalNetwork() {
        if (destroyed) return
        val next = availableNetworks.maxByOrNull { (_, capabilities) ->
            (if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) 1000 else 0) +
                (if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) 30 else if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) 20 else 10)
        }?.key
        if (next == physicalNetwork) return
        physicalNetwork = next
        networkHandler.removeCallbacks(networkRecovery)
        if (next == null) {
            networkState = "等待网络恢复"
            if (running) getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification("等待网络恢复"))
        } else {
            networkState = if (running) "正在恢复网络" else "网络可用"
            if (running) networkHandler.postDelayed(networkRecovery, 1000)
        }
    }
    private val networkRecovery = Runnable {
        val current = physicalNetwork
        if (current == null || destroyed) return@Runnable
        worker.execute {
            if (owner !== this || !running || destroyed || current != physicalNetwork) return@execute
            try {
                setUnderlyingNetworks(arrayOf(current))
                NativeCore.networkChanged()
                networkState = "网络已恢复"
                getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification("VPN 已连接"))
            } catch (_: Exception) { networkState = "网络恢复失败，请重新连接" }
        }
    }
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            if (destroyed || !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)) return
            availableNetworks[network] = capabilities
            choosePhysicalNetwork()
        }
        override fun onLost(network: Network) {
            availableNetworks.remove(network)
            choosePhysicalNetwork()
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        NativeRuntime.filesDirectory = filesDir
        UpdateJobService.schedule(this)
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("vpn", "VPN 连接", NotificationManager.IMPORTANCE_LOW))
        // A default callback may follow the virtual VPN itself on vendor builds.
        // Observe physical networks explicitly; listening never requests a new radio.
        getSystemService(ConnectivityManager::class.java).registerNetworkCallback(
            android.net.NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build(), networkCallback, networkHandler)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        lastStartId = startId
        if (intent?.action == STOP) { invalidateRequest(); worker.execute { stopInternal(true, startId) }; return START_NOT_STICKY }
        val preferences = getSharedPreferences("vpn", MODE_PRIVATE)
        // Android always-on starts with SERVICE_INTERFACE; a revoked grant never restarts silently.
        if (prepare(this) != null || (intent == null && !preferences.getBoolean("desired", false))) {
            invalidateRequest(); worker.execute { stopInternal(true) }; return START_NOT_STICKY
        }
        val request = if (intent?.action == START) requestFor(intent.getLongExtra("generation", -1)) else requestStart()
        if (request == null) { stopSelfResult(startId); return START_NOT_STICKY }
        try { startForeground(NOTIFICATION_ID, notification("正在连接…")) }
        catch (_: Exception) {
            lastError = "系统拒绝启动 VPN 前台服务，请重新授权"
            starting = false; request.completion.completeExceptionally(IllegalStateException(lastError)); stopSelf()
            return START_NOT_STICKY
        }
        val ipv6 = intent?.getBooleanExtra("ipv6", preferences.getBoolean("ipv6", false))
            ?: preferences.getBoolean("ipv6", false)
        worker.execute {
            if (request.generation != generation.get()) { request.completion.completeExceptionally(IllegalStateException("连接请求已取消")); stopSelfResult(startId); return@execute }
            if (running && owner === this) { request.completion.complete(Unit); return@execute }
            owner?.stopInternal(false, if (owner === this) null else owner?.lastStartId)
            var descriptor: ParcelFileDescriptor? = null
            try {
                starting = true
                CoreAssets.prepare(this)
                check(request.generation == generation.get()) { "连接请求已取消" }
                val builder = Builder().setSession("ProcWeaver").setMtu(1500)
                    .addAddress("172.19.0.1", 30).addDnsServer("172.19.0.2").addRoute("0.0.0.0", 0)
                    .addAddress("fdfe:dcba:9876::1", 126).addRoute("::", 0)
                    .setMetered(false)
                val settingsFile = File(filesDir, "config/preferences.json")
                val appPolicy = if (settingsFile.exists()) org.json.JSONObject(settingsFile.readText()).optJSONObject("vpnApps") else null
                val appMode = appPolicy?.optString("mode", "all") ?: "all"
                val selected = appPolicy?.optJSONArray("packages") ?: org.json.JSONArray()
                if (appMode == "include") {
                    var included = 0
                    for (index in 0 until selected.length()) {
                        val name = selected.getString(index)
                        if (name != packageName) try { builder.addAllowedApplication(name); included++ } catch (_: android.content.pm.PackageManager.NameNotFoundException) { }
                    }
                    check(included > 0) { "选中的 VPN 应用均未安装，请调整应用名单" }
                } else {
                    builder.addDisallowedApplication(packageName)
                    if (appMode == "exclude") for (index in 0 until selected.length()) {
                        try { builder.addDisallowedApplication(selected.getString(index)) } catch (_: android.content.pm.PackageManager.NameNotFoundException) { }
                    }
                }
                descriptor = builder.establish() ?: error("VPN 授权已失效")
                val home = File(filesDir, "core_data")
                NativeCore.history(home.path, java.util.TimeZone.getDefault().id, "start", 0, 0)
                // Native core duplicates the descriptor. Kotlin always owns and closes its original.
                if (intent?.action == START) {
                    val error = NativeCore.start(home.path, File(home, "config.yaml").readText(), descriptor.fd, this)
                    if (error.isNotEmpty()) error("核心启动失败，请检查订阅和规则")
                } else {
                    NativeRuntime.start(filesDir.path, NativeCore, this, descriptor.fd)
                }
                owner = this
                check(!destroyed && request.generation == generation.get()) { "连接请求已取消" }
                descriptor.close(); descriptor = null
                running = true; starting = false; startedAt = System.currentTimeMillis() / 1000
                preferences.edit().putBoolean("desired", true).putBoolean("ipv6", ipv6).apply()
                getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification("VPN 已连接"))
                request.completion.complete(Unit)
                android.service.quicksettings.TileService.requestListeningState(this, android.content.ComponentName(this, VpnTileService::class.java))
            } catch (error: Throwable) {
                descriptor?.close()
                lastError = error.message ?: "VPN 启动失败"
                runCatching { NativeCore.stop() }
                owner = null
                running = false; starting = false
                request.completion.completeExceptionally(error)
                preferences.edit().putBoolean("desired", false).apply()
                stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
            }
        }
        return START_STICKY
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 1, Intent(this, ProcWeaverVpnService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, "vpn").setSmallIcon(R.drawable.ic_vpn)
            .setContentTitle("ProcWeaver").setContentText(text).setContentIntent(open).setOngoing(true)
            .addAction(Notification.Action.Builder(null, "断开", stop).build()).build()
    }

    fun protectSocket(fd: Int): Boolean = protect(fd)

    /** Called once per new flow, never per packet. Shared UIDs cannot be split reliably. */
    fun connectionPackage(protocol: Int, source: String, sourcePort: Int, destination: String, destinationPort: Int): String {
        return try {
            val uid = getSystemService(ConnectivityManager::class.java).getConnectionOwnerUid(protocol,
                InetSocketAddress(source, sourcePort), InetSocketAddress(destination, destinationPort))
            if (uid < 0) "" else packageManager.getPackagesForUid(uid)?.singleOrNull() ?: ""
        } catch (_: Exception) { "" }
    }

    private fun stopInternal(clearDesired: Boolean, serviceStartId: Int? = lastStartId) {
        if (clearDesired) getSharedPreferences("vpn", MODE_PRIVATE).edit().putBoolean("desired", false).apply()
        if (owner == null || owner === this) { NativeCore.stop(); owner = null }
        else { stopForeground(STOP_FOREGROUND_REMOVE); serviceStartId?.let { stopSelfResult(it) }; return }
        running = false; starting = false; startedAt = 0
        android.service.quicksettings.TileService.requestListeningState(this, android.content.ComponentName(this, VpnTileService::class.java))
        if (serviceStartId != null) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelfResult(serviceStartId) }
    }
    override fun onRevoke() { invalidateRequest(); worker.execute { stopInternal(true) }; super.onRevoke() }
    override fun onDestroy() {
        destroyed = true
        networkHandler.removeCallbacks(networkRecovery)
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback) }
        worker.execute {
            if (owner === this) stopInternal(false)
            if (instance === this) instance = null
        }
        super.onDestroy()
    }
}
