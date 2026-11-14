import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import PupApp from '../../components/pup/PupApp';
import styles from '../../components/pup/styles.css?raw';

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
  // 浏览器的「强制暗色 / 自动深色」会压暗背景却保留文字色，浮窗会变成黑底暗字；
  // 声明只支持亮色可以让这类自动改色跳过浮窗。内联一份，兼容只检查宿主元素的实现。
  host.style.colorScheme = 'only light';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = styles;
  const container = document.createElement('div');
  container.style.colorScheme = 'only light';
  shadow.append(style, container);
  document.documentElement.appendChild(host);

  const root: Root = createRoot(container);
  root.render(<React.StrictMode><PupApp /></React.StrictMode>);

  const onMessage = (message: { type?: string }) => {
    if (message?.type === 'page-pup:unmount') window.__pagePupUnmount?.();
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

export default defineContentScript({
  matches: ['https://*/*', 'http://*/*'],
  registration: 'runtime',
  main() {
    mountPup();
  },
});
