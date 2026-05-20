/**
 * Ladle global wrapper. Imported on every story; this is where we pull
 * in `app.css` so the stories render with the same styling the live app
 * has. Without this, the components fall back to user-agent defaults
 * and look unstyled.
 */

import type { GlobalProvider } from '@ladle/react';
// Ladle's setup uses the classic JSX runtime, which needs React in
// scope even with the modern transform; importing for the side-effect
// keeps the wrapper portable regardless of which transform vite picks.
import React from 'react';
import '../src/app.css';

void React;

export const Provider: GlobalProvider = ({ children }) => {
  // Dark is the default; the live app stamps `data-theme` on
  // documentElement and our CSS keys off `:root[data-theme="light"]`.
  // Mirror that here so stories see the same custom-property cascade
  // they would in the live app.
  if (typeof document !== 'undefined' && !document.documentElement.dataset.theme) {
    document.documentElement.dataset.theme = 'dark';
  }
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg)',
        color: 'var(--fg)',
        padding: '1rem',
      }}
    >
      {children}
    </div>
  );
};
