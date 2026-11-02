import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from '@/app/providers';
import { connectAuthStoreToApiClient } from '@/stores/authStore';
import { App } from './App';
import { applyStoredTheme } from '@/hooks/useTheme';
import './styles/globals.css';

// Joins token ownership (the auth store) to token transmission (the API
// client) exactly once, before anything renders. Doing it here is what keeps
// `Authorization: Bearer ...` out of every feature.
applyStoredTheme();
connectAuthStoreToApiClient();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Nayaro RMS: #root container is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <AppProviders>
      <App />
    </AppProviders>
  </StrictMode>,
);
