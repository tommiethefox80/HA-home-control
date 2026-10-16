import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './heating/styles.css';
import './lighting/styles.css';
import './cameras/styles.css';
import './shell.css';
import { Shell, startSection } from './Shell.jsx';

// Pick the section before the first paint, so neither half flashes unstyled.
// (cameras are built on the lighting look, so that section has both)
const first = startSection();
document.body.classList.add(`sec-${first}`);
if (first === 'cameras') document.body.classList.add('sec-lighting');

createRoot(document.getElementById('root')).render(<StrictMode><Shell /></StrictMode>);
