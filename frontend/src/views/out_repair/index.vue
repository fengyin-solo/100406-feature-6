<template>
  <section class="page" data-module="out_repair">
    <header class="page-head">
      <div>
        <h2>外出维修管理</h2>
        <p class="page-desc">维护外出维修派遣；维修验收被退回后，关联派遣会在此页自动重开为返修事项，返修完成后重新进入验收。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记外出维修</button>
        <button class="btn" type="button" @click="exportRows">导出外出维修清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item" :class="{ 'legend-alert': item.status === '返修中' }">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <div v-if="reworkRows.length" class="rework-banner">
      <strong>返修事项（由维修验收退回重开）：{{ reworkRows.length }} 项</strong>
      <ul class="rework-list">
        <li v-for="row in reworkRows" :key="String(row.id)">
          <span class="tag tag-return">返修中</span>
          {{ row['派遣编号'] }} · 来源验收 {{ row['返修来源验收'] }}
          <span class="muted-text">重开时间 {{ row['返修重开时间'] }} · {{ row['返修重开人'] }}</span>
          <div class="rework-requirement">复修要求：{{ row['返修要求'] }}</div>
        </li>
      </ul>
    </div>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>返修信息</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'row-rework': row['维修状态'] === '返修中' }">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <template v-if="row['返修来源验收']">
              <div>来源验收：{{ row['返修来源验收'] }}</div>
              <div class="muted-text">要求：{{ row['返修要求'] }}</div>
              <div class="muted-text">{{ row['返修重开时间'] }}</div>
            </template>
            <span v-else class="muted-text">—</span>
          </td>
          <td>
            {{ row.status }}
            <span v-if="row['维修状态'] === '返修中'" class="tag tag-return">返修重开</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" @click="runAction('下达派遣', row)">下达派遣</button>
            <button class="link" type="button" @click="runAction('出发维修', row)">出发维修</button>
            <button class="link" type="button" @click="runAction('返回确认', row)">返修完成返回</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无外出维修数据，可先登记外出维修</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条外出维修记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { markReworkFinished } from '@/api/countersign-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('out_repair')
const columns = ['派遣编号', '缺陷来源', '维修人员', '预计工时', '携带工具', '出发时间', '返回时间', '维修状态']
const statuses = ['待派遣', '已派遣', '维修中', '返修中', '已返回']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const reworkRows = computed(() => rows.value.filter((row) => row['维修状态'] === '返修中'))

const stats = computed(() => [
  { label: '待派遣维修', value: rows.value.filter((row) => row.status === '待派遣').length },
  { label: '维修中数量', value: rows.value.filter((row) => row.status === '维修中').length },
  { label: '返修重开事项', value: reworkRows.value.length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) =>
      status === '返修中'
        ? row['维修状态'] === '返修中'
        : String(row.status) === status && row['维修状态'] !== '返修中',
    ).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '外出维修登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  if (row['维修状态'] === '返修中' && action === '返回确认') {
    markReworkFinished(Number(row.id))
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '外出维修列表读取失败'
  }
}

onMounted(reload)
</script>
