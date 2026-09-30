package com.procweaver.mobile

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.ParcelFileDescriptor

/** A diagnostic socket always belongs to a physical network, even without VPN. */
class ProbeNetwork(context: Context) {
    private val connectivity = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    fun protectSocket(fd: Int): Boolean = try {
        val network = (listOfNotNull(connectivity.activeNetwork) + connectivity.allNetworks.toList()).distinct().firstOrNull {
            val caps = connectivity.getNetworkCapabilities(it)
            caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true &&
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
        }
        if (network == null) false else {
            ParcelFileDescriptor.fromFd(fd).use { network.bindSocket(it.fileDescriptor) }
            true
        }
    } catch (_: Exception) { false }
}
