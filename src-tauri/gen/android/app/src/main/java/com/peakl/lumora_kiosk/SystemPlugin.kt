package com.peakl.lumora_kiosk

import android.Manifest
import android.app.Activity
import android.app.AlarmManager
import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.media.AudioManager
import android.net.wifi.SupplicantState
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import android.net.wifi.WifiNetworkSuggestion
import android.os.Build
import android.os.LocaleList
import android.os.ParcelUuid
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The Android side of the kiosk's system commands (src/android_system.rs).
 * On Linux the same commands shell out to nmcli, timedatectl, wpctl, etc.
 *
 * Most of this only works fully when Solora is the device owner
 * (SoloraAdminReceiver): Android lets the device owner join Wi-Fi, set the
 * time zone, change system brightness, sleep the screen and reboot. Without
 * it, Wi-Fi falls back to Android's own "add network" prompt and brightness
 * to this window only; the rest says it needs device owner.
 *
 * Every command resolves `{ value }`; android_system.rs unwraps it.
 */
@InvokeArg class WifiConnectArgs { lateinit var ssid: String; var password: String? = null }
@InvokeArg class LangArgs { lateinit var lang: String }
@InvokeArg class TimezoneArgs { lateinit var timezone: String }
@InvokeArg class RotationArgs { lateinit var rotation: String }
@InvokeArg class VolumeArgs { var volume: Int = 0 }
@InvokeArg class MuteArgs { var muted: Boolean = false }
@InvokeArg class LevelArgs { var level: Int = 0 }
@InvokeArg class PowerArgs { lateinit var action: String }
@InvokeArg class BeaconArgs { lateinit var tag: String }

@TauriPlugin
class SystemPlugin(private val activity: Activity) : Plugin(activity) {
  /** One at a time, off the main thread: Wi-Fi joins wait up to 25 s. */
  private val worker = Executors.newSingleThreadExecutor()
  private val wifi get() = activity.applicationContext.getSystemService(WifiManager::class.java)
  private val audio get() = activity.getSystemService(AudioManager::class.java)
  private val dpm get() = activity.getSystemService(DevicePolicyManager::class.java)
  private val admin get() = SoloraAdminReceiver.component(activity)
  private val isOwner get() = dpm.isDeviceOwnerApp(activity.packageName)

  override fun load(webView: WebView) {
    super.load(webView)
    if (isOwner) SoloraAdminReceiver.applyPolicies(activity)
  }

  private fun ok(invoke: Invoke, value: Any? = null) =
    invoke.resolve(JSObject().put("value", value ?: JSONObject.NULL))

  private fun background(invoke: Invoke, block: () -> Any?) = worker.execute {
    try {
      ok(invoke, block())
    } catch (e: Exception) {
      invoke.reject(e.message ?: e.toString())
    }
  }

  private fun onUi(invoke: Invoke, block: () -> Any?) = activity.runOnUiThread {
    try {
      ok(invoke, block())
    } catch (e: Exception) {
      invoke.reject(e.message ?: e.toString())
    }
  }

  private fun needsOwner(what: String): Nothing =
    throw IllegalStateException("$what needs Solora set up as this device's owner")

  // ── Wi-Fi ──────────────────────────────────────────────────────────────────

  /** Wi-Fi names need location access on Android. The owner grants it to itself. */
  private fun requireLocation() {
    if (activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) return
    activity.requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION), 1)
    throw IllegalStateException("Allow location access so Solora can see Wi-Fi networks, then scan again")
  }

  @Suppress("DEPRECATION")
  private fun ensureWifiOn() {
    if (wifi.isWifiEnabled) return
    if (!isOwner) throw IllegalStateException("Wi-Fi is off — turn it on in Android settings")
    wifi.isWifiEnabled = true
    repeat(20) { if (wifi.isWifiEnabled) return; Thread.sleep(250) }
  }

  @Suppress("DEPRECATION")
  private fun currentSsid(): String? {
    val info = wifi.connectionInfo ?: return null
    if (info.networkId == -1 || info.supplicantState != SupplicantState.COMPLETED) return null
    val ssid = info.ssid?.removeSurrounding("\"") ?: return null
    return ssid.takeUnless { it.isEmpty() || it == WifiManager.UNKNOWN_SSID }
  }

  /** Same shape as WifiNetwork in lib.rs / src/lib/wifi-service.ts. */
  @Command
  fun wifiScan(invoke: Invoke) = background(invoke) {
    requireLocation()
    ensureWifiOn()
    val done = CountDownLatch(1)
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(c: Context, i: Intent) = done.countDown()
    }
    activity.registerReceiver(receiver, IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION))
    try {
      // Android throttles scans; when it refuses we list what it last saw.
      @Suppress("DEPRECATION")
      if (wifi.startScan()) done.await(10, TimeUnit.SECONDS)
    } finally {
      activity.unregisterReceiver(receiver)
    }
    val connected = currentSsid()
    val best = HashMap<String, Pair<Int, String>>()
    for (r in wifi.scanResults) {
      @Suppress("DEPRECATION")
      val ssid = r.SSID?.takeIf { it.isNotEmpty() } ?: continue
      val signal = ((r.level + 100) * 2).coerceIn(0, 100)
      val caps = r.capabilities.uppercase()
      val security = when {
        caps.contains("WEP") -> "wep"
        listOf("PSK", "SAE", "EAP", "OWE").any { caps.contains(it) } -> "wpa"
        else -> "open"
      }
      val prev = best[ssid]
      if (prev == null || signal > prev.first) best[ssid] = signal to security
    }
    JSONArray().apply {
      best.entries.sortedByDescending { it.value.first }.forEach { (ssid, v) ->
        put(JSONObject().put("ssid", ssid).put("signal", v.first).put("security", v.second).put("connected", ssid == connected))
      }
    }
  }

  @Command
  fun wifiConnect(invoke: Invoke) {
    val args = invoke.parseArgs(WifiConnectArgs::class.java)
    background(invoke) {
      requireLocation()
      ensureWifiOn()
      if (currentSsid() == args.ssid) return@background true
      if (isOwner) joinAsOwner(args.ssid, args.password) else joinWithPrompt(args.ssid, args.password)
      true
    }
  }

  /** Device owners may still add networks directly (deprecated for everyone else since Android 10). */
  @Suppress("DEPRECATION")
  private fun joinAsOwner(ssid: String, password: String?) {
    val quoted = "\"$ssid\""
    wifi.configuredNetworks?.filter { it.SSID == quoted }?.forEach { wifi.removeNetwork(it.networkId) }
    val conf = WifiConfiguration().apply {
      SSID = quoted
      if (password.isNullOrEmpty()) allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE)
      else preSharedKey = "\"$password\""
    }
    val id = wifi.addNetwork(conf)
    if (id == -1) throw IllegalStateException("Android refused that network. Check the name and try again.")

    var authFailed = false
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(c: Context, i: Intent) {
        if (i.getIntExtra(WifiManager.EXTRA_SUPPLICANT_ERROR, 0) == WifiManager.ERROR_AUTHENTICATING) authFailed = true
      }
    }
    activity.registerReceiver(receiver, IntentFilter(WifiManager.SUPPLICANT_STATE_CHANGED_ACTION))
    try {
      wifi.enableNetwork(id, true)
      wifi.reconnect()
      val deadline = System.currentTimeMillis() + 25_000
      while (System.currentTimeMillis() < deadline) {
        if (authFailed) {
          wifi.removeNetwork(id)
          throw IllegalStateException("Incorrect password — please try again.")
        }
        if (currentSsid() == ssid) {
          wifi.saveConfiguration()
          return
        }
        Thread.sleep(500)
      }
      wifi.removeNetwork(id)
      throw IllegalStateException("Connection timed out. Move closer to the router and try again.")
    } finally {
      activity.unregisterReceiver(receiver)
      // enableNetwork(id, true) disabled every other saved network; without
      // this a failed join leaves the panel off Wi-Fi for good (even after a reboot).
      wifi.configuredNetworks?.filter { it.networkId != id }?.forEach { wifi.enableNetwork(it.networkId, false) }
      if (currentSsid() == null) wifi.reconnect()
    }
  }

  /** Not device owner: Android shows its own "save this network?" sheet. */
  private fun joinWithPrompt(ssid: String, password: String?) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) needsOwner("Joining Wi-Fi")
    val suggestion = WifiNetworkSuggestion.Builder().setSsid(ssid).apply {
      if (!password.isNullOrEmpty()) setWpa2Passphrase(password)
    }.build()
    val intent = Intent(Settings.ACTION_WIFI_ADD_NETWORKS)
      .putParcelableArrayListExtra(Settings.EXTRA_WIFI_NETWORK_LIST, arrayListOf(suggestion))
    activity.runOnUiThread { activity.startActivity(intent) }
    val deadline = System.currentTimeMillis() + 60_000
    while (System.currentTimeMillis() < deadline) {
      if (currentSsid() == ssid) return
      Thread.sleep(500)
    }
    throw IllegalStateException("Didn't connect to $ssid. Check the password and try again.")
  }

  @Command
  fun wifiStatus(invoke: Invoke) = background(invoke) { currentSsid() }

  // ── Language & time zone ───────────────────────────────────────────────────

  @Command
  fun localeGet(invoke: Invoke) {
    val l = Locale.getDefault()
    val lang = if (l.country.isEmpty()) "${l.language}.UTF-8" else "${l.language}_${l.country}.UTF-8"
    ok(invoke, JSONObject().put("lang", lang).put("raw", l.toLanguageTag()))
  }

  /**
   * "fr_FR.UTF-8" → system language. Android only allows this for system apps
   * (CHANGE_CONFIGURATION), so it works once Solora ships in the firmware.
   */
  @Command
  fun localeSet(invoke: Invoke) {
    val args = invoke.parseArgs(LangArgs::class.java)
    background(invoke) {
      val parts = args.lang.substringBefore('.').split('_', '-')
      val locale = if (parts.size > 1) Locale(parts[0], parts[1]) else Locale(parts[0])
      try {
        val am = Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null)!!
        val config = am.javaClass.getMethod("getConfiguration").invoke(am) as Configuration
        config.setLocales(LocaleList(locale))
        Configuration::class.java.getField("userSetLocale").setBoolean(config, true)
        am.javaClass.getMethod("updatePersistentConfiguration", Configuration::class.java).invoke(am, config)
      } catch (e: Exception) {
        Log.w("SystemPlugin", "locale change refused", e)
        throw IllegalStateException("Changing the system language needs Solora installed as a system app")
      }
      true
    }
  }

  @Command
  fun timezoneGet(invoke: Invoke) {
    val tz = TimeZone.getDefault()
    val mins = tz.getOffset(System.currentTimeMillis()) / 60_000
    val offset = String.format(Locale.ROOT, "UTC%s%02d:%02d", if (mins < 0) "-" else "+", Math.abs(mins) / 60, Math.abs(mins) % 60)
    ok(invoke, JSONObject().put("timezone", tz.id).put("utc_offset", offset))
  }

  @Command
  fun timezoneSet(invoke: Invoke) {
    val args = invoke.parseArgs(TimezoneArgs::class.java)
    background(invoke) {
      if (args.timezone !in TimeZone.getAvailableIDs()) throw IllegalArgumentException("Unknown time zone: ${args.timezone}")
      if (isOwner && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        dpm.setAutoTimeZoneEnabled(admin, false)
        if (!dpm.setTimeZone(admin, args.timezone)) throw IllegalStateException("Android refused the time zone")
      } else {
        try {
          activity.getSystemService(AlarmManager::class.java).setTimeZone(args.timezone)
        } catch (e: SecurityException) {
          needsOwner("Setting the time zone")
        }
      }
      true
    }
  }

  // ── Display ────────────────────────────────────────────────────────────────

  /** Same values as screen_orientation_set on Linux; the panel's natural way up is landscape. */
  @Command
  fun orientationSet(invoke: Invoke) {
    val args = invoke.parseArgs(RotationArgs::class.java)
    onUi(invoke) {
      activity.requestedOrientation = when (args.rotation) {
        "normal" -> ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        "inverted" -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE
        "right", "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        "left" -> ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT
        else -> throw IllegalArgumentException("Invalid rotation value: ${args.rotation}")
      }
      null
    }
  }

  @Command
  fun brightnessGet(invoke: Invoke) = onUi(invoke) {
    val window = activity.window.attributes.screenBrightness
    if (window >= 0) Math.round(window * 100)
    else Math.round(Settings.System.getInt(activity.contentResolver, Settings.System.SCREEN_BRIGHTNESS, 128) * 100 / 255f)
  }

  /** Owner: the system setting. Otherwise just this window, which is all a kiosk shows anyway. */
  @Command
  fun brightnessSet(invoke: Invoke) {
    val level = invoke.parseArgs(LevelArgs::class.java).level.coerceIn(5, 100)
    onUi(invoke) {
      val attrs = activity.window.attributes
      if (isOwner) {
        dpm.setSystemSetting(admin, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL.toString())
        dpm.setSystemSetting(admin, Settings.System.SCREEN_BRIGHTNESS, Math.round(level * 255 / 100f).toString())
        attrs.screenBrightness = BRIGHTNESS_OVERRIDE_NONE
      } else {
        attrs.screenBrightness = level / 100f
      }
      activity.window.attributes = attrs
      null
    }
  }

  @Command
  fun displaySleep(invoke: Invoke) = background(invoke) {
    if (!isOwner) needsOwner("Turning the screen off")
    dpm.lockNow()
    null
  }

  @Command
  fun displayWake(invoke: Invoke) = background(invoke) {
    @Suppress("DEPRECATION")
    val lock = activity.getSystemService(PowerManager::class.java)
      .newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "solora:wake")
    lock.acquire(3_000)
    null
  }

  // ── Audio ──────────────────────────────────────────────────────────────────

  private val prefs get() = activity.getSharedPreferences("solora-system", Context.MODE_PRIVATE)

  /** Android reports a muted stream as 0; like Linux, keep the level and the mute apart. */
  @Command
  fun volumeGet(invoke: Invoke) {
    val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
    val muted = audio.isStreamMute(AudioManager.STREAM_MUSIC)
    val volume = if (muted) prefs.getInt("volume", 50) else Math.round(audio.getStreamVolume(AudioManager.STREAM_MUSIC) * 100f / max)
    ok(invoke, JSONObject().put("volume", volume).put("muted", muted))
  }

  @Command
  fun volumeSet(invoke: Invoke) {
    val v = invoke.parseArgs(VolumeArgs::class.java).volume.coerceIn(0, 100)
    val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
    audio.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(v * max / 100f), 0)
    prefs.edit().putInt("volume", v).apply()
    ok(invoke)
  }

  @Command
  fun muteSet(invoke: Invoke) {
    val muted = invoke.parseArgs(MuteArgs::class.java).muted
    if (muted && !audio.isStreamMute(AudioManager.STREAM_MUSIC)) {
      val max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC).coerceAtLeast(1)
      prefs.edit().putInt("volume", Math.round(audio.getStreamVolume(AudioManager.STREAM_MUSIC) * 100f / max)).apply()
    }
    audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, if (muted) AudioManager.ADJUST_MUTE else AudioManager.ADJUST_UNMUTE, 0)
    ok(invoke)
  }

  // ── Power ──────────────────────────────────────────────────────────────────

  @Command
  fun power(invoke: Invoke) {
    val action = invoke.parseArgs(PowerArgs::class.java).action
    background(invoke) {
      when (action) {
        "reboot" -> if (isOwner) dpm.reboot(admin) else needsOwner("Restarting")
        "poweroff" -> throw IllegalStateException("Android doesn't let apps power off — use restart instead")
        else -> throw IllegalArgumentException("Unknown power action: $action")
      }
      null
    }
  }

  // ── Wall beacon ────────────────────────────────────────────────────────────
  // Same two advertisements as beacon.rs on Linux; keep the UUID and ids in
  // sync with it.

  private val beaconCallbacks = mutableListOf<AdvertiseCallback>()

  @Command
  fun beaconStart(invoke: Invoke) {
    val hex = invoke.parseArgs(BeaconArgs::class.java).tag
    val tag = ByteArray(4) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    background(invoke) {
      val adapter = activity.getSystemService(BluetoothManager::class.java)?.adapter
        ?: throw IllegalStateException("No Bluetooth adapter")
      if (!adapter.isEnabled) {
        @Suppress("DEPRECATION", "MissingPermission")
        if (!isOwner || !adapter.enable()) throw IllegalStateException("Bluetooth is off")
        var waited = 0
        while (!adapter.isEnabled && waited < 5_000) { Thread.sleep(250); waited += 250 }
      }
      val advertiser = adapter.bluetoothLeAdvertiser ?: throw IllegalStateException("This Bluetooth adapter can't advertise")
      stopBeacon()
      val settings = AdvertiseSettings.Builder()
        .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
        .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
        .setConnectable(false)
        .setTimeout(0)
        .build()
      val wall = AdvertiseData.Builder()
        .addServiceUuid(ParcelUuid(WALL_SERVICE))
        .addManufacturerData(COMPANY_ID, tag)
        .build()
      val ibeacon = AdvertiseData.Builder().addManufacturerData(APPLE_ID, ibeaconData(tag)).build()

      val started = CountDownLatch(1)
      var failure: Int? = null
      val wallCb = object : AdvertiseCallback() {
        override fun onStartSuccess(s: AdvertiseSettings) = started.countDown()
        override fun onStartFailure(code: Int) { failure = code; started.countDown() }
      }
      // Best effort, like Linux: an adapter with one slot still runs the first.
      val ibeaconCb = object : AdvertiseCallback() {
        override fun onStartFailure(code: Int) = Log.w("SystemPlugin", "iBeacon not started ($code)").let {}
      }
      @Suppress("MissingPermission") advertiser.startAdvertising(settings, wall, wallCb)
      if (!started.await(5, TimeUnit.SECONDS)) throw IllegalStateException("The wall beacon didn't start")
      failure?.let { throw IllegalStateException("Couldn't start the wall beacon (error $it)") }
      beaconCallbacks += wallCb
      @Suppress("MissingPermission") advertiser.startAdvertising(settings, ibeacon, ibeaconCb)
      beaconCallbacks += ibeaconCb
      null
    }
  }

  @Command
  fun beaconStop(invoke: Invoke) = background(invoke) { stopBeacon(); null }

  @Suppress("MissingPermission")
  private fun stopBeacon() {
    val advertiser = activity.getSystemService(BluetoothManager::class.java)?.adapter?.bluetoothLeAdvertiser
    beaconCallbacks.forEach { advertiser?.stopAdvertising(it) }
    beaconCallbacks.clear()
  }

  private fun ibeaconData(tag: ByteArray): ByteArray {
    val uuid = java.nio.ByteBuffer.allocate(16)
      .putLong(WALL_SERVICE.mostSignificantBits).putLong(WALL_SERVICE.leastSignificantBits).array()
    return byteArrayOf(0x02, 0x15) + uuid + tag + byteArrayOf(IBEACON_POWER)
  }

  companion object {
    private val WALL_SERVICE: UUID = UUID.fromString("6C756D6F-7261-4E10-8000-696E76697465")
    private const val COMPANY_ID = 0xFFFF
    private const val APPLE_ID = 0x004C
    private const val IBEACON_POWER: Byte = -59
    private const val BRIGHTNESS_OVERRIDE_NONE = -1f
  }
}

/**
 * Makes Solora eligible to be the device owner, set at the factory with
 *   adb shell dpm set-device-owner com.peakl.lumora_kiosk/.SoloraAdminReceiver
 * (only on a device with no accounts).
 */
class SoloraAdminReceiver : DeviceAdminReceiver() {
  override fun onEnabled(context: Context, intent: Intent) = applyPolicies(context)

  companion object {
    fun component(context: Context) = ComponentName(context, SoloraAdminReceiver::class.java)

    /** What the owner grants itself so the system commands work without prompts. */
    fun applyPolicies(context: Context) {
      val dpm = context.getSystemService(DevicePolicyManager::class.java)
      if (!dpm.isDeviceOwnerApp(context.packageName)) return
      val admin = component(context)
      val permissions = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        permissions += listOf(Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT)
      }
      // The hub service's (hidden) notification.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) permissions += Manifest.permission.POST_NOTIFICATIONS
      for (p in permissions) {
        dpm.setPermissionGrantState(admin, context.packageName, p, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED)
      }
      // Wi-Fi scans return nothing with location off.
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) dpm.setLocationEnabled(admin, true)
      // No lock screen: displaySleep's lockNow just turns the panel off.
      dpm.setKeyguardDisabled(admin, true)
      // Kiosk lock (MainActivity starts it): no notification shade or quick
      // settings, no Home/Recents, no power menu — only Solora's own controls.
      dpm.setLockTaskPackages(admin, arrayOf(context.packageName))
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
      }
      dpm.setStatusBarDisabled(admin, true)
      // Solora is the home screen, so Android's launcher never shows.
      dpm.addPersistentPreferredActivity(
        admin,
        IntentFilter(Intent.ACTION_MAIN).apply {
          addCategory(Intent.CATEGORY_HOME)
          addCategory(Intent.CATEGORY_DEFAULT)
        },
        ComponentName(context, MainActivity::class.java),
      )
      hideOtherHomesAndKeyboards(context, dpm, admin)
      // Android shows the wallpaper for a few seconds between the boot animation
      // and Solora; make it the animation's last frame.
      try {
        val metrics = context.resources.displayMetrics
        val side = maxOf(metrics.widthPixels, metrics.heightPixels)
        val frame = android.graphics.Bitmap.createBitmap(side, side, android.graphics.Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(frame)
        canvas.drawColor(0xFF0A0A0F.toInt())
        val orbit = android.graphics.BitmapFactory.decodeResource(context.resources, R.drawable.solora_boot_orbit)
        canvas.drawBitmap(orbit, (side - orbit.width) / 2f, (side - orbit.height) / 2f, null)
        // Square and centred, so it lines up whichever way the panel is mounted.
        val wallpapers = android.app.WallpaperManager.getInstance(context)
        wallpapers.suggestDesiredDimensions(side, side)
        wallpapers.setBitmap(frame)
      } catch (e: Exception) {
        Log.w("SystemPlugin", "wallpaper not set", e)
      }
    }

    /**
     * Hides Android's own home screen (so it can't flash up at boot) and its
     * keyboards (Solora has its own, touch-keyboard.tsx). Hidden, not removed:
     * a factory reset brings them back until Solora is device owner again.
     */
    private fun hideOtherHomesAndKeyboards(context: Context, dpm: DevicePolicyManager, admin: ComponentName) {
      val pm = context.packageManager
      val homes = pm.queryIntentActivities(
        Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME), PackageManager.MATCH_DISABLED_COMPONENTS,
      ).map { it.activityInfo.packageName }
      val keyboards = context.getSystemService(android.view.inputmethod.InputMethodManager::class.java)
        .inputMethodList.map { it.packageName }
      // Settings (FallbackHome) and the system's own chooser ("android") also answer HOME but must stay.
      for (pkg in (homes + keyboards).toSet() - setOf(context.packageName, "com.android.settings", "android")) {
        try {
          if (!dpm.setApplicationHidden(admin, pkg, true)) Log.w("SystemPlugin", "Android refused to hide $pkg")
        } catch (e: Exception) {
          Log.w("SystemPlugin", "couldn't hide $pkg", e)
        }
      }
    }
  }
}
