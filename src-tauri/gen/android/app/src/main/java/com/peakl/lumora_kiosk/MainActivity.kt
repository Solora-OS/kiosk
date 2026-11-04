package com.peakl.lumora_kiosk

import android.app.ActivityManager
import android.app.admin.DevicePolicyManager
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  private val rehide = Runnable { hideSystemBars() }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // The hub in this process (src/hub.rs) keeps serving phones with the screen off.
    SoloraHubService.start(this)
    // The wall display decides when the screen sleeps (system_display_sleep),
    // not Android's timeout, and wakes straight into Solora.
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    setShowWhenLocked(true)
    setTurnScreenOn(true)
    hideSystemBars()
    // Android brings the bars back on its own (a focused text field does it);
    // put them away again.
    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { view, insets ->
      if (insets.isVisible(WindowInsetsCompat.Type.systemBars())) {
        view.removeCallbacks(rehide)
        view.postDelayed(rehide, 300)
      }
      ViewCompat.onApplyWindowInsets(view, insets)
    }
    // Solora has its own navigation; Android's Back does nothing here.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {}
    })
  }

  override fun onResume() {
    super.onResume()
    lockToSolora()
  }

  /** As device owner, pin Solora (lock task mode; SoloraAdminReceiver.applyPolicies allows it). */
  private fun lockToSolora() {
    val dpm = getSystemService(DevicePolicyManager::class.java)
    if (!dpm.isDeviceOwnerApp(packageName) || !dpm.isLockTaskPermitted(packageName)) return
    if (getSystemService(ActivityManager::class.java).lockTaskModeState == ActivityManager.LOCK_TASK_MODE_NONE) {
      startLockTask()
    }
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) hideSystemBars()
  }

  /** Full screen: no status or navigation bar (a swipe from the edge shows them briefly). */
  private fun hideSystemBars() {
    WindowCompat.getInsetsController(window, window.decorView).apply {
      systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      hide(WindowInsetsCompat.Type.systemBars())
    }
  }
}
