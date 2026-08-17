import './types/platform';

// ── Cribl platform fetch proxy ────────────────────────────────────────────────
// The Cribl iframe proxy intercepts GET /kvstore/* responses: it reads the
// body, calls JSON.parse, and creates new CapturedResponse(parsedObject).
// String(plainObject) = "[object Object]", corrupting the body.
//
// Fix: kvPut double-encodes values (JSON.stringify twice) so the stored body
// is a JSON string.  The proxy parses that string and gets back a string —
// new Response(string) preserves it correctly.  See lib/kv.ts kvPut.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.tsx';

const basename = window.CRIBL_BASE_PATH ?? '/';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
