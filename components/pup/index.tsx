import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PupApp from './PupApp';
import styles from './styles.css?raw';

declare global {
  interface Window {
    __pagePupMounted?: boolean;
    __pagePupUnmount?: () => void;
  }
}

function mountPup() {
  if (window.__pagePupMounted || document.getElementById('page-pup-host')) return;
  window.__pagePupMounted = true;

  const host = document.createElement('div');
  host.id = 'page-pup-host';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = styles;
  const container = document.createElement('div');
  shadow.append(style, container);
  document.documentElement.appendChild(host);

  const root: Root = createRoot(container);
  root.render(<React.StrictMode><PupApp /></React.StrictMode>);

  const onMessage = (message: { type?: string }) => {
    if (message?.type !== 'page-pup:unmount') return;
    window.__pagePupUnmount?.();
  };
  chrome.runtime.onMessage.addListener(onMessage);

  window.__pagePupUnmount = () => {
    chrome.runtime.onMessage.removeListener(onMessage);
    root.unmount();
    host.remove();
    window.__pagePupMounted = false;
    window.__pagePupUnmount = undefined;
  };
}

mountPup();
