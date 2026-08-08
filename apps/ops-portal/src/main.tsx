import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { logResolvedBases } from './lib/env.js'
import './index.css'

// Says what the two edge base urls actually resolved to. Until G-6 nothing
// did, so a blank var in .env.local was indistinguishable from a down edge.
logResolvedBases()

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
)
