import './styles.css';
import { createApp } from './app/app';

const root = document.getElementById('app');
if (root === null) throw new Error('Missing #app root element.');
createApp(root);
