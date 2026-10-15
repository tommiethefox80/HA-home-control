import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './heating/styles.css';
import './lighting/styles.css';
import './shell.css';
import { Shell, startSection } from './Shell.jsx';

// Pick the section before the first paint, so neither half flashes unstyled.
document.body.classList.add(`sec-${startSection()}`);

createRoot(document.getElementById('root')).render(<StrictMode><Shell /></StrictMode>);
