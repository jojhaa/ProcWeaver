package com.procweaver.mobile

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

object QrImages {
    fun read(context: Context, uri: Uri): String {
        check(uri.scheme == "content")
        val output = java.io.ByteArrayOutputStream()
        context.contentResolver.openInputStream(uri)?.use { input ->
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer); if (count < 0) break
                check(output.size() + count <= 8 * 1024 * 1024)
                output.write(buffer, 0, count)
            }
        } ?: error("无法读取图片")
        val bytes = output.toByteArray()
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        check(options.outWidth in 1..32768 && options.outHeight in 1..32768 && options.outWidth.toLong() * options.outHeight <= 64_000_000L)
        var sample = 1
        while (options.outWidth / sample > 2048 || options.outHeight / sample > 2048) sample *= 2
        options.inJustDecodeBounds = false; options.inSampleSize = sample
        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: error("无效图片")
        try {
            val pixels = IntArray(bitmap.width * bitmap.height)
            bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
            val source = RGBLuminanceSource(bitmap.width, bitmap.height, pixels)
            val hints = mapOf(DecodeHintType.TRY_HARDER to true, DecodeHintType.CHARACTER_SET to "UTF-8")
            val reader = QRCodeReader()
            val result = try { reader.decode(BinaryBitmap(HybridBinarizer(source)), hints) }
                catch (_: com.google.zxing.NotFoundException) { reader.decode(BinaryBitmap(HybridBinarizer(source.invert())), hints) }
            check(result.text.toByteArray(Charsets.UTF_8).size <= 8192)
            return result.text
        } finally { bitmap.recycle() }
    }
}
