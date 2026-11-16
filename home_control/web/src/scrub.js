// Reading a chart with a finger: touch and hold, or drag sideways, to move the readout along it.
// On a phone a long press would otherwise select the text around the chart (iOS) and the readout
// would vanish as soon as the finger lifts. With a mouse it follows the pointer as before.
// Give the chart's plot these handlers and the class "scrub" (shell.css: no text selection or
// callout, and sideways drags go to the chart while up and down still scroll the page).
import { useEffect, useRef } from 'react';

export function useScrub(move, clear, { keepMs = 4000 } = {}) {
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const hold = () => clearTimeout(timer.current);
  // a finger lifted: keep the readout a few seconds so it can be read
  const release = (e) => {
    if (e.pointerType === 'mouse') { hold(); clear(); return; }
    hold();
    timer.current = setTimeout(clear, keepMs);
  };
  return {
    onPointerDown: (e) => { hold(); move(e); },
    onPointerMove: (e) => { if (e.pointerType !== 'mouse' && e.buttons === 0 && e.pressure === 0) return; hold(); move(e); },
    onPointerLeave: release,
    onPointerCancel: release,
    onContextMenu: (e) => { if (e.pointerType !== 'mouse') e.preventDefault(); },
  };
}
