package com.solora.kiosk

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * Keeps the household hub serving while the wall display sleeps.
 *
 * The hub itself runs in this process (src/hub.rs, the solora-hub crate); this
 * service only keeps the process important to Android and the radio awake:
 *   - a foreground service, so Android doesn't stop the app when the screen is off
 *   - a partial wake lock, so the CPU keeps answering phones (the panel is on mains)
 *   - a Wi-Fi lock, so Wi-Fi doesn't drop into power save with the screen off
 *   - a multicast lock, so mDNS queries from phones (_solora._tcp) reach the hub
 */
class SoloraHubService : Service() {
  private var wake: PowerManager.WakeLock? = null
  private var wifi: WifiManager.WifiLock? = null
  private var multicast: WifiManager.MulticastLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    val notification = notification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    wake = getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "solora:hub")
      .apply { setReferenceCounted(false); acquire() }
    val wifiManager = applicationContext.getSystemService(WifiManager::class.java)
    @Suppress("DEPRECATION") // HIGH_PERF is the mode that holds with the screen off
    wifi = wifiManager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "solora:hub")
      .apply { setReferenceCounted(false); acquire() }
    multicast = wifiManager.createMulticastLock("solora:mdns")
      .apply { setReferenceCounted(false); acquire() }
  }

  /** Android restarts it if it ever has to stop it. */
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY

  override fun onDestroy() {
    multicast?.release()
    wifi?.release()
    wake?.release()
    super.onDestroy()
  }

  /** Required for a foreground service; the panel has no status bar, so nobody sees it. */
  private fun notification(): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "Household hub", NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) },
      )
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
    return builder
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle("Solora hub")
      .setContentText("Serving your family's phones")
      .setOngoing(true)
      .build()
  }

  companion object {
    private const val CHANNEL = "solora-hub"
    private const val NOTIFICATION_ID = 4000

    fun start(context: Context) {
      val intent = Intent(context, SoloraHubService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
    }
  }
}
