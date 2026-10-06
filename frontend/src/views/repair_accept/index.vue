<template>
  <section class="page" data-module="repair_accept">
    <header class="page-head">
      <div>
        <h2>维修验收管理</h2>
        <p class="page-desc">维护维修验收记录，围绕验收编号、关联维修、验收人员、验收日期做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记维修验收记录</button>
        <button class="btn" type="button" @click="exportRows">导出维修验收清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

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
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button class="link" type="button" @click="downloadPack(row)">下载会签包</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无维修验收数据，可先登记维修验收记录</td>
        </tr>
      </tbody>
    </table>

    <section class="panel">
      <h3>会签资料包</h3>
      <p class="panel-desc">
        下载资料包（含验收编号、关联维修、维修质量、复修要求）供现场离线填写，上传后系统逐条校验并给出通过、退回或待补充结论；
        重复上传与版本冲突不会生成第二份验收记录，旧版本材料按历史口径保留。
      </p>
      <div class="upload-line">
        <input ref="fileInput" type="file" accept=".json,application/json" @change="onPackageFile" />
        <button class="btn primary" type="button" :disabled="!packageFile" @click="submitPackage">
          上传会签资料包
        </button>
      </div>
      <div v-if="uploadResult" class="upload-result">
        <p class="conclusion" :class="uploadResult.ok ? 'result-ok' : 'result-bad'">
          校验结论：{{ uploadResult.结论 }} — {{ uploadResult.message }}
        </p>
        <table v-if="uploadResult.items.length" class="data-table">
          <thead>
            <tr><th>条目</th><th>校验结果</th><th>原因</th></tr>
          </thead>
          <tbody>
            <tr v-for="item in uploadResult.items" :key="item.条目">
              <td>{{ item.条目 }}</td>
              <td>{{ item.结果 }}</td>
              <td>{{ item.原因 || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>包编号</th>
            <th>验收编号</th>
            <th>版本</th>
            <th>包状态</th>
            <th>校验结果</th>
            <th>失败条目及原因</th>
            <th>上传人</th>
            <th>上传时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="pkg in packages" :key="String(pkg.id)">
            <td>{{ pkg['包编号'] }}</td>
            <td>{{ pkg['验收编号'] || '—' }}</td>
            <td>{{ pkg['版本'] ?? '—' }}</td>
            <td>{{ pkg.status }}</td>
            <td>{{ pkg['校验结果'] || '—' }}</td>
            <td>{{ pkg['失败条目'] || '—' }}</td>
            <td>{{ pkg['上传人'] || '—' }}</td>
            <td>{{ pkg['上传时间'] || '—' }}</td>
          </tr>
          <tr v-if="!packages.length">
            <td colspan="8" class="empty-state">暂无会签资料包记录，可先在列表里下载会签包</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条维修验收记录</span>
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
import {
  downloadPackage,
  listPackages,
  uploadPackage,
  type PackageUploadResult,
} from '@/api/countersign'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('repair_accept')
const columns = ["验收编号", "关联维修", "验收人员", "验收日期", "维修质量", "验收结论", "复修要求", "验收状态"]
const actions = ["发起验收", "确认通过", "退回返修"]
const statuses = ["待验收", "验收中", "已通过", "需返修"]
const stats = [{"label": "待验收记录", "value": 0}, {"label": "已通过记录", "value": 0}, {"label": "需返修记录", "value": 0}]

const store = useSessionStore()
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const packages = ref<EntryRow[]>([])
const packageFile = ref<File | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const uploadResult = ref<PackageUploadResult | null>(null)
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
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
  errorMessage.value = '维修验收记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function downloadPack(row: EntryRow) {
  downloadPackage(row)
}

function onPackageFile(event: Event) {
  const input = event.target as HTMLInputElement
  packageFile.value = input.files?.[0] ?? null
}

async function submitPackage() {
  if (!packageFile.value) {
    return
  }
  errorMessage.value = ''
  const text = await packageFile.value.text()
  uploadResult.value = uploadPackage(text, store.operator)
  packageFile.value = null
  if (fileInput.value) {
    fileInput.value.value = ''
  }
  reload()
  reloadPackages()
}

function reloadPackages() {
  packages.value = listPackages()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '维修验收列表读取失败'
  }
}

onMounted(() => {
  reload()
  reloadPackages()
})
</script>
