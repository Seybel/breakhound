import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'breakhound',
  description:
    'Find the exact width where your layout breaks, on every page of your app, then hand the fix to your coding agent.',
  // Served from GitHub Pages at seybel.github.io/breakhound.
  base: '/breakhound/',
  // The design notes are for contributors, and stay on GitHub.
  srcExclude: ['DESIGN.md'],
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', href: '/breakhound/icon.png' }],
    ['meta', { property: 'og:title', content: 'breakhound' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Every page, every width from 320 to 1920px: the exact pixel where your layout breaks, and why.',
      },
    ],
    [
      'meta',
      {
        property: 'og:image',
        content: 'https://raw.githubusercontent.com/Seybel/breakhound/main/docs/demo.gif',
      },
    ],
  ],
  themeConfig: {
    logo: '/icon.png',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/cli' },
      { text: 'Changelog', link: 'https://github.com/Seybel/breakhound/blob/main/CHANGELOG.md' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'What it checks', link: '/guide/checks' },
          { text: 'Chrome extension', link: '/guide/extension' },
          { text: 'Fix it with your coding agent', link: '/guide/agents' },
          { text: 'CI', link: '/guide/ci' },
          { text: 'Try it on an example', link: '/guide/example' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Command line', link: '/reference/cli' },
          { text: 'Configuration', link: '/reference/config' },
        ],
      },
      {
        text: 'Project',
        items: [
          {
            text: 'Contributing',
            link: 'https://github.com/Seybel/breakhound/blob/main/CONTRIBUTING.md',
          },
          { text: 'Security', link: 'https://github.com/Seybel/breakhound/blob/main/SECURITY.md' },
          { text: 'Privacy', link: 'https://github.com/Seybel/breakhound/blob/main/PRIVACY.md' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Seybel/breakhound' },
      { icon: 'npm', link: 'https://www.npmjs.com/package/@seybel/breakhound' },
    ],
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/Seybel/breakhound/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Free and open source, MIT licensed.',
      copyright: 'Made by Seybel',
    },
  },
});
