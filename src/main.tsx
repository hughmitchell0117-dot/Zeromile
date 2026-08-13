import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// Loaded last on purpose: the redesign layer re-tokenises the base system and
// owns the page shell. index.css keeps the console, map and phone working.
import './styles/redesign.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
