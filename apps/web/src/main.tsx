import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { AuthProvider } from "./hooks/auth";
import { AdminShell, RequireAuth } from "./components/shell";
import { Spinner } from "./components/ui";
import { LoginPage, ForgotPasswordPage, ResetPasswordPage } from "./pages/auth/Auth";
import "./styles.css";

const Dashboard = lazy(() => import("./pages/admin/Dashboard"));
const Studio = lazy(() => import("./pages/admin/Studio"));
const Schedule = lazy(() => import("./pages/admin/Schedule"));
const Playlists = lazy(() => import("./pages/admin/Playlists"));
const MediaLibrary = lazy(() => import("./pages/admin/Media"));
const Requests = lazy(() => import("./pages/admin/Requests"));
const Events = lazy(() => import("./pages/admin/Events"));
const Stats = lazy(() => import("./pages/admin/Stats"));
const Users = lazy(() => import("./pages/admin/Users"));
const Settings = lazy(() => import("./pages/admin/Settings"));
const Alerts = lazy(() => import("./pages/admin/Alerts"));
const Account = lazy(() => import("./pages/admin/Account"));
const Listen = lazy(() => import("./pages/listen/Listen"));
const PublicSchedule = lazy(() => import("./pages/listen/PublicSchedule"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
});

const fallback = (
  <div className="p-8">
    <Spinner />
  </div>
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Suspense fallback={fallback}>
            <Routes>
              <Route path="/" element={<Navigate to="/listen" replace />} />
              <Route path="/listen" element={<Listen />} />
              <Route path="/listen/schedule" element={<PublicSchedule />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route
                path="/admin"
                element={
                  <RequireAuth>
                    <AdminShell />
                  </RequireAuth>
                }
              >
                <Route index element={<Dashboard />} />
                <Route path="studio" element={<Studio />} />
                {/* The old Playout and Live studio pages are combined into the Studio. */}
                <Route path="playout" element={<Navigate to="/admin/studio" replace />} />
                <Route path="live" element={<Navigate to="/admin/studio" replace />} />
                <Route path="schedule" element={<Schedule />} />
                <Route path="playlists" element={<Playlists />} />
                <Route path="media" element={<MediaLibrary />} />
                <Route path="requests" element={<Requests />} />
                <Route path="events" element={<Events />} />
                <Route path="stats" element={<Stats />} />
                <Route path="users" element={<Users />} />
                <Route path="settings" element={<Settings />} />
                <Route path="alerts" element={<Alerts />} />
                <Route path="account" element={<Account />} />
              </Route>
              <Route path="*" element={<Navigate to="/listen" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{
            style: { background: "#252931", border: "1px solid #3a3f49", color: "#e6e3dc" },
          }}
        />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
