import { useEffect, useState } from 'react';
import LoginForm from './components/LoginForm';
import TerminalPanel from './components/TerminalPanel';
import './App.css';

type AuthState = 'loading' | 'anonymous' | 'authenticated';

function App() {
  const [authState, setAuthState] = useState<AuthState>('loading');
  const [csrfToken, setCsrfToken] = useState('');

  useEffect(() => {
    fetch('/api/session', { credentials: 'same-origin' })
      .then((res) => res.json())
      .then((data: { authenticated: boolean; csrfToken: string }) => {
        setCsrfToken(data.csrfToken);
        setAuthState(data.authenticated ? 'authenticated' : 'anonymous');
      })
      .catch(() => setAuthState('anonymous'));
  }, []);

  if (authState === 'loading') {
    return (
      <div id="root-loading">
        <p>読み込み中…</p>
      </div>
    );
  }

  if (authState === 'anonymous') {
    return (
      <LoginForm
        csrfToken={csrfToken}
        onLoginSuccess={(token) => {
          setCsrfToken(token);
          setAuthState('authenticated');
        }}
      />
    );
  }

  return (
    <div id="app-layout">
      <TerminalPanel />
    </div>
  );
}

export default App;
