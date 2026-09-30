package com.procweaver.mobile

import android.content.Context
import java.io.File

object CoreAssets {
    @Synchronized fun prepare(context: Context) {
        val root = File(context.filesDir, "core_data").also { it.mkdirs() }
        fun copy(source: String, target: File) {
            val children = context.assets.list(source) ?: emptyArray()
            if (children.isNotEmpty()) {
                target.mkdirs()
                children.forEach { copy("$source/$it", File(target, it)) }
            } else if (!target.exists()) {
                val temporary = File(target.path + ".install")
                context.assets.open(source).use { input -> temporary.outputStream().use { input.copyTo(it) } }
                check(temporary.renameTo(target)) { "离线规则安装失败" }
            }
        }
        copy("defaults/core_data", root)
    }
}
