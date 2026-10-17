import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './heating/styles.css';
import './lighting/styles.css';
import './cameras/styles.css';
import './wifi/styles.css';
import './energy/styles.css';
import './shell.css';
import { Shell, startSection } from './Shell.jsx';

// Pick the section before the first paint, so neither half flashes unstyled.
// (cameras and Wi-Fi are built on the lighting look, so those sections have both)
const first = startSection();
document.body.classList.add(`sec-${first}`);
if (['cameras', 'wifi', 'energy'].includes(first)) document.body.classList.add('sec-lighting');
if (first === 'wifi' || first === 'energy') document.body.classList.add('sec-cameras');

createRoot(document.getElementById('root')).render(<StrictMode><Shell /></StrictMode>);
