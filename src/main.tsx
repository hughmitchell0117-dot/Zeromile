import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// Loaded last on purpose: the redesign layer re-tokenises the base system and
// owns the page shell. index.css keeps the console, map and phone working.
import './styles/redesign.css'
// The agent floats above everything and borrows the redesign layer's tokens.
import './styles/agent.css'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
