package com.procweaver.mobile

/** Reuses the shared Rust compiler for system starts without creating an Activity. */
object NativeRuntime {
    init { System.loadLibrary("proc_weaver_lib") }
    external fun start(files: String, core: NativeCore, service: ProcWeaverVpnService, fd: Int)
    external fun tick(files: String)
    @Volatile var filesDirectory: java.io.File? = null

    // The job/system entry point can run before an Activity or Tauri plugin exists.
    fun command(name: String, raw: String): String {
        val args = org.json.JSONObject(if (raw == "null") "{}" else raw)
        val files = filesDirectory ?: error("后台目录未初始化")
        val coreHome = java.io.File(files, "core_data")
        when (name) {
            "status" -> return ProcWeaverVpnService.snapshot().toString()
            "validate" -> check(NativeCore.validate(coreHome.path, args.getString("config")).isEmpty())
            "validateGeo" -> {
                val path = java.io.File(args.getString("path")).canonicalFile
                check(path == java.io.File(coreHome, ".geo-candidate").canonicalFile)
                check(NativeCore.validateGeo(args.getString("kind"), path.path).isEmpty())
            }
            "reload" -> check(NativeCore.reload(args.getString("config")).isEmpty())
            "stats" -> return NativeCore.stats()
            else -> error("不支持的后台操作")
        }
        return "{}"
    }
}
