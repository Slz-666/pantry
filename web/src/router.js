/**
 * 路由与登录守卫（T3.2）。
 * token 存 localStorage；没有 token 访问任何业务页 → 去登录页并记住原地址。
 */
import { createRouter, createWebHistory } from 'vue-router';
import { store } from './store.js';

const routes = [
  { path: '/login', name: 'login', component: () => import('./views/Login.vue'), meta: { public: true } },
  { path: '/', name: 'home', component: () => import('./views/Home.vue') },
  { path: '/location/:id?', name: 'location', component: () => import('./views/Location.vue') },
  { path: '/item/:id', name: 'item', component: () => import('./views/ItemDetail.vue') },
  { path: '/add', name: 'add', component: () => import('./views/Add.vue') },
  { path: '/shopping', name: 'shopping', component: () => import('./views/Shopping.vue') },
  { path: '/alerts', name: 'alerts', component: () => import('./views/Alerts.vue') },
  { path: '/settings', name: 'settings', component: () => import('./views/Settings.vue') },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  if (!to.meta.public && !store.token) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.name === 'login' && store.token) return { name: 'home' };
  return true;
});
