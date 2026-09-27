// Vue Router with nested children, a redirect and a catch-all.
import { createApp, h } from 'vue';
import { createRouter, createWebHistory, RouterView } from 'vue-router';

const page = (title) => ({ render: () => h('h1', title) });

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: page('Home') },
    { path: '/old-home', redirect: '/' },
    {
      path: '/account',
      component: { render: () => h(RouterView) },
      children: [
        { path: '', component: page('Account') },
        { path: 'orders/:orderId(\\d+)', component: page('Order') },
      ],
    },
    { path: '/:pathMatch(.*)*', component: page('Not found') },
  ],
});

createApp({ render: () => h(RouterView) }).use(router).mount('#app');
