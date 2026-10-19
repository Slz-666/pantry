<script setup>
/** 登录页：只有账号密码，不做注册（自用单租户）。 */
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { post } from '../api.js';
import { setToken } from '../store.js';
import Field from '../components/Field.vue';

const route = useRoute();
const router = useRouter();

const username = ref('admin');
const password = ref('');
const errorText = ref('');
const loading = ref(false);

async function submit() {
  if (loading.value) return;
  errorText.value = '';
  if (!username.value.trim() || !password.value) {
    errorText.value = '账号和密码都要填';
    return;
  }
  loading.value = true;
  try {
    // 登录失败要自己显示错误文案，所以 silent 掉全局提示
    const res = await post('/auth/login', { username: username.value.trim(), password: password.value }, { silent: true });
    setToken(res.token);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    router.replace(redirect);
  } catch (err) {
    errorText.value = err.message || '登录失败';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-card">
    <span class="login-card__brand" aria-hidden="true">🥫</span>
    <h1 class="login-card__title">家里有什么</h1>
    <p class="login-card__sub">家庭物资与效期管理 · 自用版</p>

    <form class="form" @submit.prevent="submit">
      <Field v-model="username" label="账号" autocomplete="username" />
      <Field v-model="password" label="密码" type="password" autocomplete="current-password" />
      <p v-if="errorText" class="login-card__error">{{ errorText }}</p>
      <button class="btn btn--primary btn--block" type="submit" :disabled="loading">
        {{ loading ? '登录中…' : '登录' }}
      </button>
    </form>
  </div>
</template>
