import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Antes del primer render: si no, el skeleton parpadea en claro para quien
// tenga el tema oscuro (TopBar aún no montó).
document.documentElement.dataset.theme = localStorage.getItem('fud-theme') || 'light'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
