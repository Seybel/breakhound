import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import CopyPage from './CopyPage.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  // Copy page, View as Markdown, and Open in ChatGPT or Claude, above each docs page.
  Layout: () => h(DefaultTheme.Layout, null, { 'doc-before': () => h(CopyPage) }),
} satisfies Theme;
