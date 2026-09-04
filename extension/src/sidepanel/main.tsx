import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installOcrEngine } from '../perception/register-ocr';
import { installVisionEngine } from '../perception/register-vision';
import './styles.css';

// Install the real local engines for this document. Both are lazy: nothing heavy
// loads until the visual pipeline first analyzes a captured region.
//   installVisionEngine → local ONNX UI detector  (WHERE elements are)
//   installOcrEngine    → local Tesseract.js OCR  (WHAT the pixels say)
installVisionEngine();
installOcrEngine();

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
