// Manually inject XYFlow base styles during library/IIFE use so edges and handles render.
import xyflowCss from '@xyflow/react/dist/style.css?raw';

export function ensureXYFlowStyles() {
  if (typeof document === 'undefined') return;
  const styleId = 'papertrail-xyflow-style';
  if (document.getElementById(styleId)) return;
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `${xyflowCss}
.react-flow__edge-path,
.react-flow__connection-path {
  /* Allow host/theme overrides of stroke; keep rendering intact */
}
.react-flow__edges,
.react-flow__edges svg {
  overflow: visible !important;
}
.react-flow .react-flow__edges {
  inset: 0;
  width: 100% !important;
  height: 100% !important;
  z-index: 3 !important;
}
.react-flow .react-flow__edges svg {
  width: 100% !important;
  height: 100% !important;
}
`;
  document.head.appendChild(style);
}
