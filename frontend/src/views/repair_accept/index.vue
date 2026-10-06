<template>
  <section class="page" data-module="repair_accept">
    <header class="page-head">
      <div>
        <h2>维修验收管理</h2>
        <p class="page-desc">验收编号、关联维修、维修质量与复修要求可打包为会签资料包，供现场人员离线填写后上传，系统逐条校验并给出通过、退回或待补充结果。</p>
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

    <div class="pkg-toolbar">
      <button class="btn primary" type="button" @click="issueSelected">
        下载会签资料包<span v-if="selected.size">（已选 {{ selected.size }} 条）</span>
      </button>
      <button class="btn" type="button" @click="triggerUpload">上传现场填写的资料包</button>
      <input
        ref="fileInput"
        class="hidden-file"
        type="file"
        accept=".csv,text/csv"
        @change="onUploadFile"
      />
      <span class="pkg-tip">资料包只允许在“验收结论 / 现场会签人 / 会签日期”三列离线填写，重复上传不会生成第二份验收记录。</span>
    </div>

    <div v-if="uploadResult" class="result-panel" :class="uploadResult.ok ? 'is-pass' : 'is-fail'">
      <div class="result-head">
        <strong>
          <span class="tag" :class="`tag-${uploadResult.record.outcome}`">{{ outcomeLabel(uploadResult.record.outcome) }}</span>
          {{ uploadResult.record.message }}
        </strong>
        <button class="link" type="button" @click="uploadResult = null">关闭</button>
      </div>
      <table v-if="uploadResult.record.items.length" class="data-table result-table">
        <thead>
          <tr>
            <th>验收编号</th>
            <th>关联维修</th>
            <th>现场结论</th>
            <th>会签人</th>
            <th>会签日期</th>
            <th>校验结果</th>
            <th>具体条目与原因</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="check in uploadResult.record.items" :key="check.acceptanceNo">
            <td>{{ check.acceptanceNo }}</td>
            <td>{{ check.relatedRepair }}</td>
            <td>{{ check.item.conclusion || '—' }}</td>
            <td>{{ check.item.signer || '—' }}</td>
            <td>{{ check.item.signDate || '—' }}</td>
            <td><span class="tag" :class="`tag-${check.verdict}`">{{ verdictLabel(check.verdict) }}</span></td>
            <td>
              <span v-if="!check.reasons.length" class="ok-text">符合要求</span>
              <ul v-else class="reason-list">
                <li v-for="reason in check.reasons" :key="reason">{{ reason }}</li>
              </ul>
            </td>
          </tr>
        </tbody>
      </table>
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
          <th class="col-check"><input type="checkbox" :checked="allSelected" @change="toggleAll" /></th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>资料包 / 版本</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td class="col-check">
            <input type="checkbox" :checked="selected.has(Number(row.id))" @change="toggleOne(Number(row.id))" />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <template v-if="row['资料包编号']">
              {{ row['资料包编号'] }} <span class="version-mark">v{{ row['会签版本'] }}</span>
            </template>
            <span v-else class="muted-text">未会签</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="runAction('发起验收', row)">发起验收</button>
            <button class="link" type="button" @click="runAction('确认通过', row)">确认通过</button>
            <button class="link danger" type="button" @click="openReject(row)">退回返修</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无维修验收数据，可先登记维修验收记录</td>
        </tr>
      </tbody>
    </table>

    <section v-if="packages.length" class="history-panel">
      <h3>会签资料包上传记录</h3>
      <p class="page-desc">无论是否落地均留档；旧版本材料按历史口径保留，可随时重新下载原件核对。</p>
      <div v-for="record in packages" :key="record.id" class="history-item">
        <details>
          <summary>
            <span class="tag" :class="`tag-${record.outcome}`">{{ outcomeLabel(record.outcome) }}</span>
            <strong>{{ record.packageNo }}</strong>
            <span v-if="record.version" class="version-mark">v{{ record.version }}</span>
            <span class="muted-text">{{ record.submittedAt }} · {{ record.submittedBy }}</span>
            <button class="btn small" type="button" @click.stop="redownload(record)">下载原始材料</button>
          </summary>
          <p class="history-message">{{ record.message }}</p>
          <table v-if="record.items.length" class="data-table result-table">
            <thead>
              <tr>
                <th>验收编号</th>
                <th>关联维修</th>
                <th>校验结果</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="check in record.items" :key="check.acceptanceNo">
                <td>{{ check.acceptanceNo }}</td>
                <td>{{ check.relatedRepair }}</td>
                <td><span class="tag" :class="`tag-${check.verdict}`">{{ verdictLabel(check.verdict) }}</span></td>
                <td>{{ check.reasons.join('；') || '符合要求' }}</td>
              </tr>
            </tbody>
          </table>
        </details>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条维修验收记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="rejectTarget" class="modal-mask" @click.self="rejectTarget = null">
      <div class="modal-box">
        <h3>退回返修</h3>
        <p class="page-desc">
          验收「{{ rejectTarget['验收编号'] }}」退回后，关联外出维修「{{ rejectTarget['关联维修'] }}」将在外出维修页重开为返修事项。
        </p>
        <label class="filter-item">
          <span>复修要求</span>
          <textarea v-model="rejectRequirement" rows="4" placeholder="请写明需复修的具体问题与要求"></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="rejectTarget = null">取消</button>
          <button class="btn primary" type="button" @click="confirmReject">确认退回并重开返修</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  runAction as applyAction,
} from '@/api/local-service'
import {
  downloadPackage,
  issuePackage,
  listPackages,
  packageRecordFilename,
  rejectAcceptance,
  uploadPackage,
} from '@/api/countersign-service'
import { serializePackage } from '@/data/countersign'
import { useSessionStore } from '@/stores/session'
import type { EntryRow } from '@/data/types'
import type { ItemCheck, PackageRecord } from '@/data/countersign'

const store = useSessionStore()
const columns = ['验收编号', '关联维修', '验收人员', '验收日期', '维修质量', '验收结论', '复修要求', '验收状态']
const statuses = ['待验收', '验收中', '已通过', '需返修']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selected = ref<Set<number>>(new Set())
const fileInput = ref<HTMLInputElement | null>(null)
const uploadResult = ref<{ ok: boolean; record: PackageRecord } | null>(null)
const packages = ref<PackageRecord[]>([])
const rejectTarget = ref<EntryRow | null>(null)
const rejectRequirement = ref('')

const stats = computed(() => [
  { label: '待验收记录', value: rows.value.filter((row) => row.status === '待验收').length },
  { label: '已通过记录', value: rows.value.filter((row) => row.status === '已通过').length },
  { label: '需返修记录', value: rows.value.filter((row) => row.status === '需返修').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const allSelected = computed(
  () => rows.value.length > 0 && rows.value.every((row) => selected.value.has(Number(row.id))),
)

const VERDICT_LABELS: Record<string, string> = {
  pass: '通过',
  return: '退回',
  supplement: '待补充',
  reject: '拒收',
  passed: '通过',
  returned: '退回',
  duplicate: '重复上传',
  conflict: '版本冲突',
  structure: '结构异常',
  invalid: '无法解析',
}

function verdictLabel(verdict: ItemCheck['verdict'] | PackageRecord['outcome']): string {
  return VERDICT_LABELS[verdict] ?? verdict
}

function outcomeLabel(outcome: PackageRecord['outcome']): string {
  return VERDICT_LABELS[outcome] ?? outcome
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('repair_accept')
}

function openCreate() {
  errorMessage.value = '维修验收记录登记入口尚未接入审批流'
}

function toggleOne(id: number) {
  const next = new Set(selected.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selected.value = next
}

function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(rows.value.map((row) => Number(row.id)))
}

function issueSelected() {
  errorMessage.value = ''
  try {
    const payload = issuePackage({ acceptanceIds: [...selected.value] })
    downloadPackage(payload.content, payload.filename)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '资料包下发失败'
  }
}

function triggerUpload() {
  fileInput.value?.click()
}

async function onUploadFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  errorMessage.value = ''
  try {
    const content = await file.text()
    uploadResult.value = uploadPackage(content, store.operator)
    reload()
    loadHistory()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '资料包读取失败'
  } finally {
    input.value = ''
  }
}

function redownload(record: PackageRecord) {
  downloadPackage(serializePackage(record.snapshot), packageRecordFilename(record))
}

function loadHistory() {
  packages.value = listPackages()
}

function openReject(row: EntryRow) {
  rejectTarget.value = row
  rejectRequirement.value = String(row['复修要求'] ?? '') === '无' ? '' : String(row['复修要求'] ?? '')
}

function confirmReject() {
  if (!rejectTarget.value) {
    return
  }
  if (!rejectRequirement.value.trim()) {
    errorMessage.value = '退回返修必须填写复修要求'
    return
  }
  const result = rejectAcceptance([Number(rejectTarget.value.id)], rejectRequirement.value, store.operator)
  errorMessage.value = result.ok ? '' : result.message
  rejectTarget.value = null
  rejectRequirement.value = ''
  reload()
}

function runAction(action: '发起验收' | '确认通过', row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction('repair_accept', Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries('repair_accept', filters.value)
    rows.value = payload.items
    total.value = payload.total
    selected.value = new Set([...selected.value].filter((id) => rows.value.some((row) => Number(row.id) === id)))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '维修验收列表读取失败'
  }
}

onMounted(() => {
  reload()
  loadHistory()
})
</script>
