import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { ActivityPage } from './pages/Activity';
import { DashboardPage } from './pages/Dashboard';
import { DockerPage } from './pages/Docker';
import { KafkaPage } from './pages/Kafka';
import { KubernetesPage } from './pages/Kubernetes';
import { LoginPage } from './pages/Login';
import { ProcessesPage } from './pages/Processes';
import { RequestsPage } from './pages/Requests';
import { ServicesPage } from './pages/Services';

export function App() {
  const { username, ready } = useAuth();

  if (!ready) return <Spinner label="Starting…" />;
  if (!username) return <LoginPage />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="services" element={<ServicesPage />} />
        <Route path="docker" element={<DockerPage />} />
        <Route path="kubernetes" element={<KubernetesPage />} />
        <Route path="requests" element={<RequestsPage />} />
        <Route path="kafka" element={<KafkaPage />} />
        <Route path="processes" element={<ProcessesPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
