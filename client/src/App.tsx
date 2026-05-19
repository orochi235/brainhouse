import { useEffect, useState } from 'react';
import { trpc } from './trpc.ts';

export function App() {
  const [status, setStatus] = useState<'connecting' | 'live' | 'offline'>('connecting');

  useEffect(() => {
    trpc.health
      .query()
      .then(() => setStatus('live'))
      .catch(() => setStatus('offline'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui', padding: '2rem' }}>
      <h1 style={{ margin: 0 }}>brainhouse</h1>
      <p style={{ color: '#888' }}>server status: {status}</p>
    </main>
  );
}
