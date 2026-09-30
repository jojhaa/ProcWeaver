package com.procweaver.mobile

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class UpdateJobService : JobService() {
    companion object {
        private val worker = Executors.newSingleThreadExecutor()
        private val active = AtomicBoolean(false)
        fun schedule(context: Context) {
            val scheduler = context.getSystemService(JobScheduler::class.java)
            if (scheduler.getPendingJob(4101) != null) return
            scheduler.schedule(JobInfo.Builder(4101, ComponentName(context, UpdateJobService::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPersisted(true)
                .setPeriodic(15 * 60 * 1000L).setBackoffCriteria(15 * 60 * 1000L, JobInfo.BACKOFF_POLICY_EXPONENTIAL).build())
        }
    }
    @Volatile private var stopped = false
    override fun onStartJob(params: JobParameters): Boolean {
        if (!active.compareAndSet(false, true)) return false
        stopped = false
        worker.execute {
            var retry = false
            var phase = "assets"
            try {
                CoreAssets.prepare(this)
                phase = "runtime"
                NativeRuntime.filesDirectory = filesDir
                phase = "update"
                NativeRuntime.tick(filesDir.path)
            } catch (error: Throwable) {
                retry = true
                // Keep diagnostics useful without recording subscriptions or paths.
                android.util.Log.w("ProcWeaverJob", "后台更新失败: $phase / ${error.javaClass.simpleName}")
            }
            finally {
                getSharedPreferences("maintenance", MODE_PRIVATE).edit()
                    .putLong("checkedAt", System.currentTimeMillis())
                    .putBoolean("success", !retry && !stopped).apply()
                active.set(false); if (!stopped) jobFinished(params, retry)
            }
        }
        return true
    }
    override fun onStopJob(params: JobParameters): Boolean { stopped = true; return true }
}
