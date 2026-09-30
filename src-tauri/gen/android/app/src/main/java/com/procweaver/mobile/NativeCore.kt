package com.procweaver.mobile

/** Only lifecycle/configuration cross JNI. Packet forwarding stays in the native core. */
object NativeCore {
    init { System.loadLibrary("procweaver_core") }
    external fun validate(home: String, config: String): String
    external fun start(home: String, config: String, fd: Int, callbacks: ProcWeaverVpnService): String
    external fun stop()
    external fun reload(config: String): String
    external fun mode(mode: String): String
    external fun stats(): String
    external fun health(home: String, args: String, network: ProbeNetwork): String
    external fun validateGeo(kind: String, path: String): String
    external fun networkChanged()
    external fun history(home: String, zone: String, action: String, start: Long, end: Long): String
}
