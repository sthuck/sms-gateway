import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { RequireAuth } from "./auth/RequireAuth";
import { AppLayout } from "./layout/AppLayout";
import { DevicesPage } from "./pages/DevicesPage";
import { HomePage } from "./pages/HomePage";
import { InboxPage } from "./pages/InboxPage";
import { LoginPage } from "./pages/LoginPage";
import { MessageDetailPage } from "./pages/MessageDetailPage";
import { PairingPage } from "./pages/PairingPage";
import { TokensPage } from "./pages/TokensPage";

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route element={<AppLayout />}>
              <Route index element={<HomePage />} />
              <Route path="inbox" element={<InboxPage />} />
              <Route path="inbox/:messageId" element={<MessageDetailPage />} />
              <Route path="devices" element={<DevicesPage />} />
              <Route path="devices/pair" element={<PairingPage />} />
              <Route path="tokens" element={<TokensPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
