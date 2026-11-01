import "./App.css";
import { SideNav } from "./components/ui/reusables/side-nav";
import { CalendarView } from "./app/calendar/calender";
import { ChoresView } from "./app/chores/chores";
import { ListsView } from "./app/lists/lists";
import { MealsView } from "./app/meals/meals";
import { HomeView } from "./app/home/home"
import { SettingsView } from "./app/settings/settings";
import { PhotosView } from "./app/photos/photos";
import { HeaderNav } from "./components/ui/reusables/header-nav";
import { MemberChips } from "./components/ui/reusables/member-chips";
import { StoreProvider, useStore, type TabKey } from "./lib/store";
import { AuthProvider, useAuth } from "./lib/auth";
import { AuthScreen } from "./app/auth/auth-screen";
import { kioskConfig } from "./lib/kiosk";
import { KioskRoot } from "./app/kiosk/kiosk-root";
import { Loader2 } from "lucide-react";

const todaySubtitle = new Date().toLocaleDateString(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
})

const headers: Record<TabKey, { title: string; subtitle?: string; showMembers: boolean }> = {
  home: { title: "Home", subtitle: todaySubtitle, showMembers: false },
  calendar: { title: "Calendar", subtitle: todaySubtitle, showMembers: true },
  chores: { title: "Chores", subtitle: "Keep the streak going", showMembers: true },
  rewards: { title: "Rewards", subtitle: "Points, streaks and treats", showMembers: false },
  lists: { title: "Lists", subtitle: "Shared with the family", showMembers: false },
  meals: { title: "Meals", subtitle: "Dinner plan for the week", showMembers: false },
  photos: { title: "Photos", subtitle: "Family moments on your hub", showMembers: false },
  settings: { title: "Settings", subtitle: "Manage your hub", showMembers: false },
}

function AppShell() {
  const { tab, setTab, loading } = useStore()
  const head = headers[tab]

  return (
    <div className="flex min-h-dvh bg-background">
      <SideNav active={tab} onChange={setTab} />
      
      <div className="flex flex-1 flex-col">
        <HeaderNav title={head.title} subtitle={head.subtitle} />
        {head.showMembers ? <MemberChips /> : null}

        <main className="flex-1 overflow-auto">
          {loading && tab !== "settings" ? (
            <div className="flex items-center justify-center py-24">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="mx-auto max-w-6xl px-4 py-4">
              {tab === "calendar" && <CalendarView />}
              {tab === "chores" && <ChoresView />}
              {tab === "lists" && <ListsView />}
              {tab === "meals" && <MealsView />}
              {tab === "photos" && <PhotosView />}
              {tab === "settings" && <SettingsView />}
              {tab === "home" && <HomeView />}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

function Gate() {
  const { status } = useAuth()

  if (status === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (status === "guest") {
    return <AuthScreen />
  }

  return (
    <StoreProvider>
      <AppShell />
    </StoreProvider>
  )
}

function App() {
  // Kiosk builds run the device-pairing experience (no user login). The mobile
  // app build runs the normal authenticated flow.
  if (kioskConfig.enabled) {
    return (
      <AuthProvider>
        <KioskRoot />
      </AuthProvider>
    )
  }

  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}

export default App;
