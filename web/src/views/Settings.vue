<script setup>
/**
 * 我的：账号、提醒规则（可编辑）、阶段进度、退出登录。
 *
 * 规则编辑直接改 reminder_rule：days_before 是「提前几天」节点数组，
 * opened_days 是「开封后几天内用完」。改完只影响之后扫描出来的提醒
 * （已生成的提醒不会自己消失，见 server/src/routes/reminders.js 注释）。
 */
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { get, patch, post } from '../api.js';
import { pushToast, store, clearAuth } from '../store.js';
import Field from '../components/Field.vue';

const router = useRouter();

const rules = ref([]);
const categories = ref([]);
const busy = ref(false);
const errorText = ref('');

const draft = reactive({ category: '', daysText: '30,7,1,0', openedText: '' });

/** 把接口返回的数组映射成「文本输入框」用的行，避免在模板里做格式转换 */
function toRow(r) {
  return {
    ...r,
    daysText: (r.daysBefore || []).join(','),
    openedText: r.openedDays == null ? '' : String(r.openedDays),
  };
}

function parseDays(text) {
  return String(text)
    .split(/[,,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 365);
}

async function load() {
  errorText.value = '';
  try {
    const [list, meta] = await Promise.all([get('/reminder-rules'), get('/meta')]);
    rules.value = (list || []).map(toRow);
    categories.value = meta?.categories || [];
  } catch (err) {
    errorText.value = err.message || '加载失败';
  }
}

async function save(rule) {
  const days = parseDays(rule.daysText);
  if (!days.length) return pushToast('至少填一个提前天数，例如 30,7,1,0', 'warn');
  busy.value = true;
  try {
    await patch(`/reminder-rules/${rule.id}`, {
      daysBefore: days,
      openedDays: rule.openedText === '' ? null : Number(rule.openedText),
      enabled: rule.enabled,
    });
    pushToast(`${rule.category}的规则已保存`, 'ok');
    await load();
  } catch {
    // api.js 已提示
  } finally {
    busy.value = false;
  }
}

async function addRule() {
  if (!draft.category) return pushToast('先选一个品类', 'warn');
  const days = parseDays(draft.daysText);
  if (!days.length) return pushToast('至少填一个提前天数', 'warn');
  busy.value = true;
  try {
    await post('/reminder-rules', {
      category: draft.category,
      daysBefore: days,
      openedDays: draft.openedText === '' ? null : Number(draft.openedText),
    });
    draft.category = '';
    pushToast('规则已添加', 'ok');
    await load();
  } catch {
    // api.js 已提示
  } finally {
    busy.value = false;
  }
}

/** 立刻按当前规则扫一遍，验证规则改得对不对（不用等到早上 8 点） */
async function scanNow() {
  busy.value = true;
  try {
    const r = await post('/jobs/scan');
    pushToast(`扫描完成：新增 ${r?.created ?? 0} 条提醒`, 'ok');
  } catch {
    // api.js 已提示
  } finally {
    busy.value = false;
  }
}

function logout() {
  clearAuth();
  router.replace({ name: 'login' });
}

onMounted(load);
</script>

<template>
  <div>
    <p v-if="errorText" class="card">{{ errorText }}</p>

    <div class="card">
      <div class="section-title"><span>账号</span></div>
      <p>{{ store.member?.displayName || store.member?.username || '未登录' }}</p>
      <p class="muted">
        <template v-if="store.member?.username">账号 {{ store.member.username }} · </template>家里有什么 · 自用版
      </p>
    </div>

    <div class="card">
      <div class="section-title">
        <span>提醒规则</span>
        <button type="button" class="btn btn--sm" :disabled="busy" @click="scanNow">立即扫描</button>
      </div>
      <p class="muted">
        提前提醒按品类分开设；「开封后」留空表示不提醒。改完点保存，只影响之后扫出来的提醒。
      </p>

      <div v-for="r in rules" :key="r.id" class="rule">
        <div class="rule__head">
          <span class="row__title">{{ r.category }}</span>
          <label class="rule__toggle">
            <input v-model="r.enabled" type="checkbox" />
            启用
          </label>
          <button type="button" class="btn btn--sm" :disabled="busy" @click="save(r)">保存</button>
        </div>
        <div class="grid-2">
          <Field v-model="r.daysText" label="提前几天（逗号分隔）" placeholder="30,7,1,0" />
          <Field v-model="r.openedText" label="开封后（天）" type="number" inputmode="numeric" placeholder="留空=不提醒" />
        </div>
      </div>

      <div class="rule rule--new">
        <div class="section-title"><span>加一条品类规则</span></div>
        <label class="field">
          <span class="field__label">品类</span>
          <select v-model="draft.category" class="input">
            <option value="">请选择品类</option>
            <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
          </select>
        </label>
        <div class="grid-2">
          <Field v-model="draft.daysText" label="提前几天" placeholder="30,7,1,0" />
          <Field v-model="draft.openedText" label="开封后（天）" type="number" inputmode="numeric" placeholder="留空=不提醒" />
        </div>
        <button type="button" class="btn btn--block mt-3" :disabled="busy" @click="addRule">添加规则</button>
      </div>
    </div>

    <div class="card">
      <div class="section-title"><span>阶段进度</span></div>
      <p class="muted">0 地基 ✓ · 1 数据层 ✓ · 2 接口层 ✓ · 3 界面骨架 ✓ · 4 录入 Agent ✓ · 5 提醒与清单 ✓ · 6 离线 · 7 手机 · 8 作品集</p>
    </div>

    <button class="btn btn--block mt-3" type="button" @click="logout">退出登录</button>
  </div>
</template>
