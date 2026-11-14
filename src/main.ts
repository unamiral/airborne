import './styles.css';
import welcomeImage from './assets/welcome-artwork.png';
import { createApp } from './app/app';

const root = document.getElementById('app');
if (root === null) throw new Error('Missing #app root element.');

const splash = document.createElement('button');
splash.type = 'button';
splash.className = 'welcome-screen';
splash.setAttribute('aria-label', 'Click to continue to Air Whiteboard');
const image = document.createElement('img');
image.src = welcomeImage;
image.alt = '';
const prompt = document.createElement('span');
prompt.className = 'welcome-screen-prompt';
prompt.textContent = 'Click to continue';
splash.append(image, prompt);
root.append(splash);
splash.focus({ preventScroll: true });
splash.addEventListener('click', () => {
  splash.disabled = true;
  splash.classList.add('leaving');
  let entered = false;
  const enter = (): void => {
    if (entered) return;
    entered = true;
    splash.remove();
    createApp(root);
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) enter();
  else {
    splash.addEventListener('transitionend', enter, { once: true });
    window.setTimeout(enter, 800);
  }
}, { once: true });

