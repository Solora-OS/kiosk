package com.solora.kiosk

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

/**
 * Installs a downloaded, signature-checked Solora APK over the running app
 * (src/apk_update.rs downloads and verifies it first).
 *
 * As device owner the install is silent: Android replaces the app and
 * PackageReplacedReceiver starts it again. Otherwise Android shows its own
 * install prompt and we report "needs_confirmation".
 */
@InvokeArg
class InstallArgs {
  lateinit var path: String
}

@TauriPlugin
class ApkInstallerPlugin(private val activity: Activity) : Plugin(activity) {
  companion object {
    /** The install call waiting on InstallResultReceiver. */
    @Volatile var pending: Invoke? = null
  }

  @Command
  fun install(invoke: Invoke) {
    val args = invoke.parseArgs(InstallArgs::class.java)
    try {
      val installer = activity.packageManager.packageInstaller
      val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
      params.setAppPackageName(activity.packageName)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
      }
      val sessionId = installer.createSession(params)
      installer.openSession(sessionId).use { session ->
        File(args.path).inputStream().use { input ->
          session.openWrite("solora.apk", 0, -1).use { out ->
            input.copyTo(out)
            session.fsync(out)
          }
        }
        // Mutable: the installer adds the status extras to this intent.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
          (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        val status = PendingIntent.getBroadcast(
          activity, sessionId, Intent(activity, InstallResultReceiver::class.java), flags,
        )
        pending = invoke
        session.commit(status.intentSender)
      }
    } catch (e: Exception) {
      pending = null
      invoke.reject(e.message ?: "Install failed")
    }
  }
}

class InstallResultReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val invoke = ApkInstallerPlugin.pending
    when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        @Suppress("DEPRECATION")
        val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
        confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (confirm != null) context.startActivity(confirm)
        ApkInstallerPlugin.pending = null
        invoke?.resolve(JSObject().put("status", "needs_confirmation"))
      }
      // A self-update usually kills this process before this arrives.
      PackageInstaller.STATUS_SUCCESS -> {
        ApkInstallerPlugin.pending = null
        invoke?.resolve(JSObject().put("status", "installing"))
      }
      else -> {
        ApkInstallerPlugin.pending = null
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        invoke?.reject(message ?: "Install failed (status $status)")
      }
    }
  }
}

/**
 * Brings Solora back after it updated itself. Device owner apps may start
 * activities from the background; as the home app it would return anyway.
 */
class PackageReplacedReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
  }
}
