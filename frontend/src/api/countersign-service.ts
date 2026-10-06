/** 会签资料包服务层：资料包下发、上传编排、逐条校验落地与版本留档。
 * 规则：
 * 1. 同一资料包编号重复上传不生成第二份验收记录（按包编号 + 内容指纹幂等）；
 * 2. 多人同时上传同一包：基线版本必须等于当前材料版本，仅一个版本落地，其余整包冲突失败；
 * 3. 逐条校验给出通过 / 退回 / 待补充，任一条不通过则整包不落地，失败包标出具体条目和原因；
 * 4. 旧版本材料按历史口径保留，可重新下载；
 * 5. 退回的验收同步把关联外出维修重开为返修事项。 */
import { listRows, saveRows } from '@/data/local-store'
import {
  checkItem,
  nextPackageCode,
  parsePackage,
  serializePackage,
  type ItemCheck,
  type PackageItem,
  type PackageRecord,
} from '@/data/countersign'
import type { EntryRow } from '@/data/types'

const PACKAGE_STORE_KEY = 'underground-pipeline-inspection:countersign-packages'
const ACCEPT_KEY = 'repair_accept'
const REPAIR_KEY = 'out_repair'

/** 验收记录上记录会签落地信息的扩展字段（不影响既有模块字段口径） */
const FIELD_VERSION = '会签版本'
const FIELD_PACKAGE_NO = '资料包编号'
const FIELD_SIGNER = '现场会签人'
const FIELD_SIGN_DATE = '会签日期'
const FIELD_LANDED_AT = '最近落地时间'

function nowStamp(): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const now = new Date()
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  )
}

function fingerprint(items: PackageItem[]): string {
  const body = items
    .map((item) =>
      [
        item.packageNo,
        item.acceptanceNo,
        item.conclusion,
        item.signer,
        item.signDate,
      ].join('|'),
    )
    .sort()
    .join('||')
  let hash = 0
  for (let i = 0; i < body.length; i += 1) {
    hash = (hash * 31 + body.charCodeAt(i)) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function loadPackages(): PackageRecord[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  try {
    return JSON.parse(window.localStorage.getItem(PACKAGE_STORE_KEY) ?? '[]') as PackageRecord[]
  } catch {
    return []
  }
}

function persistPackages(records: PackageRecord[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(PACKAGE_STORE_KEY, JSON.stringify(records))
  }
}

function findAcceptance(rows: EntryRow[], code: string): EntryRow | undefined {
  return rows.find((row) => String(row['验收编号'] ?? '') === code)
}

/** 找关联外出维修：验收记录的「关联维修」字段与派遣编号精确匹配 */
function findRepair(repairs: EntryRow[], relatedRepair: string): EntryRow | undefined {
  return repairs.find((row) => String(row['派遣编号'] ?? '') === relatedRepair)
}

export type IssuePackageInput = {
  packageNo?: string
  acceptanceIds: number[]
}

/** 下发资料包：按选中验收记录打包当前的验收编号、关联维修、维修质量、复修要求 */
export function issuePackage(input: IssuePackageInput): { filename: string; content: string; packageNo: string } {
  const rows = listRows(ACCEPT_KEY)
  const targets = rows.filter((row) => input.acceptanceIds.includes(Number(row.id)))
  if (!targets.length) {
    throw new Error('请先勾选要打包的验收记录')
  }
  const records = loadPackages()
  const packageNo = input.packageNo?.trim() || nextPackageCode(records.length)
  const items: PackageItem[] = targets.map((row) => ({
    packageNo,
    baseVersion: Number(row[FIELD_VERSION] ?? 0),
    acceptanceNo: String(row['验收编号'] ?? ''),
    relatedRepair: String(row['关联维修'] ?? ''),
    quality: String(row['维修质量'] ?? ''),
    repairRequirement: String(row['复修要求'] ?? ''),
    conclusion: '',
    signer: '',
    signDate: '',
  }))
  return {
    filename: `维修验收会签资料包-${packageNo}.csv`,
    content: serializePackage(items),
    packageNo,
  }
}

function summarize(checks: ItemCheck[]): {
  pass: number
  returned: number
  supplement: number
  reject: number
} {
  return checks.reduce(
    (sum, check) => {
      if (check.verdict === 'pass') sum.pass += 1
      else if (check.verdict === 'return') sum.returned += 1
      else if (check.verdict === 'reject') sum.reject += 1
      else sum.supplement += 1
      return sum
    },
    { pass: 0, returned: 0, supplement: 0, reject: 0 },
  )
}

export type UploadResult = {
  ok: boolean
  record: PackageRecord
}

/** 上传资料包：解析 → 幂等判重 → 版本冲突检查 → 逐条校验 → 整包落地（含返修重开） */
export function uploadPackage(content: string, submittedBy: string = '现场人员'): UploadResult {
  const records = loadPackages()

  let items: PackageItem[]
  try {
    items = parsePackage(content)
  } catch (error) {
    const record: PackageRecord = {
      id: records.length + 1,
      packageNo: '未知资料包',
      version: 0,
      acceptanceNos: [],
      submittedAt: nowStamp(),
      submittedBy,
      landed: false,
      outcome: 'invalid',
      message: error instanceof Error ? error.message : '资料包解析失败',
      items: [],
      snapshot: [],
    }
    records.push(record)
    persistPackages(records)
    return { ok: false, record }
  }

  const packageNo = items[0]?.packageNo || '未命名资料包'
  const finger = fingerprint(items)
  const acceptanceRows = listRows(ACCEPT_KEY)

  const buildRecord = (partial: Partial<PackageRecord>): PackageRecord => ({
    id: records.length + 1,
    packageNo,
    version: 0,
    acceptanceNos: items.map((item) => item.acceptanceNo),
    submittedAt: nowStamp(),
    submittedBy,
    landed: false,
    outcome: 'invalid',
    message: '',
    items: [],
    snapshot: items,
    ...partial,
  })

  // 规则一：同一资料包同一填写内容重复上传，不生成第二份验收记录，直接回指首次落地版本
  const landedBefore = records.find(
    (record) =>
      record.landed &&
      record.packageNo === packageNo &&
      fingerprint(record.snapshot) === finger,
  )
  if (landedBefore) {
    const record = buildRecord({
      version: landedBefore.version,
      landed: false,
      outcome: 'duplicate',
      message: `资料包 ${packageNo} 内容与已落地的第 ${landedBefore.version} 版完全一致，未重复生成验收记录`,
      items: landedBefore.items,
    })
    records.push(record)
    persistPackages(records)
    return { ok: false, record }
  }

  // 规则二：多人同时上传同一包——基线版本必须全部等于当前材料版本，否则只有一个版本能落地
  const stale: ItemCheck[] = []
  for (const item of items) {
    const acceptance = findAcceptance(acceptanceRows, item.acceptanceNo)
    if (acceptance && Number(acceptance[FIELD_VERSION] ?? 0) !== item.baseVersion) {
      stale.push({
        acceptanceNo: item.acceptanceNo,
        relatedRepair: item.relatedRepair,
        verdict: 'reject',
        reasons: [
          `基线版本为 v${item.baseVersion}，系统当前已是 v${Number(
            acceptance[FIELD_VERSION] ?? 0,
          )}，已有其他人员的版本先行落地`,
        ],
        item,
      })
    }
  }
  if (stale.length) {
    const record = buildRecord({
      landed: false,
      outcome: 'conflict',
      message: `资料包版本冲突：${stale.length} 个条目已被他人先行上传，本包整包未落地，请重新下载最新资料包`,
      items: stale,
    })
    records.push(record)
    persistPackages(records)
    return { ok: false, record }
  }

  // 规则三：逐条校验
  const checks = items.map((item) =>
    checkItem(item, findAcceptance(acceptanceRows, item.acceptanceNo)),
  )
  const stats = summarize(checks)
  const structural = checks.filter((check) => check.verdict === 'reject')
  if (structural.length) {
    const record = buildRecord({
      landed: false,
      outcome: 'structure',
      message: `资料包含 ${structural.length} 个无效条目（编号不存在或关联维修不符），整包未落地`,
      items: checks,
    })
    records.push(record)
    persistPackages(records)
    return { ok: false, record }
  }

  if (stats.supplement > 0 || stats.returned > 0) {
    const outcome = stats.supplement > 0 ? 'supplement' : 'returned'
    const parts: string[] = []
    if (stats.supplement > 0) parts.push(`${stats.supplement} 条待补充`)
    if (stats.returned > 0) parts.push(`${stats.returned} 条退回返修`)
    if (stats.pass > 0) parts.push(`${stats.pass} 条校验通过`)
    const record = buildRecord({
      landed: false,
      outcome,
      message: `整包暂不落地：${parts.join('，')}，请按条目原因处理后重新上传`,
      items: checks,
    })
    records.push(record)
    persistPackages(records)
    return { ok: false, record }
  }

  // 全部通过：唯一版本落地。写回验收记录（同一条验收不会因重复上传产生第二份记录）
  const stamp = nowStamp()
  const nextVersion = Math.max(0, ...checks.map((check) => check.item.baseVersion)) + 1
  const nextAcceptance = [...acceptanceRows]
  for (const check of checks) {
    const index = nextAcceptance.findIndex(
      (row) => String(row['验收编号'] ?? '') === check.acceptanceNo,
    )
    if (index < 0) {
      continue
    }
    const current = nextAcceptance[index]
    nextAcceptance[index] = {
      ...current,
      status: '已通过',
      pending: false,
      abnormal: false,
      验收结论: '合格',
      [FIELD_SIGNER]: check.item.signer,
      [FIELD_SIGN_DATE]: check.item.signDate,
      [FIELD_VERSION]: nextVersion,
      [FIELD_PACKAGE_NO]: packageNo,
      [FIELD_LANDED_AT]: stamp,
    }
  }
  saveRows(ACCEPT_KEY, nextAcceptance)

  const record = buildRecord({
    version: nextVersion,
    landed: true,
    outcome: 'passed',
    message: `资料包 ${packageNo} 全部 ${checks.length} 条校验通过，已按第 ${nextVersion} 版落地，未产生重复验收记录`,
    items: checks,
  })
  records.push(record)
  persistPackages(records)
  return { ok: true, record }
}

/**
 * 验收退回入口（单条退回或资料包退回的统一收口）：
 * 验收置为「需返修」，并把关联的外出维修重开为返修事项。
 * 已通过后再次退回的，会签材料版本继续保留，按历史口径可查。
 */
export function rejectAcceptance(
  acceptanceIds: number[],
  requirement: string,
  operator: string = '值班管理员',
): { ok: boolean; message: string } {
  const acceptanceRows = [...listRows(ACCEPT_KEY)]
  const repairRows = [...listRows(REPAIR_KEY)]
  const reopened: string[] = []

  for (const id of acceptanceIds) {
    const index = acceptanceRows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      continue
    }
    const current = acceptanceRows[index]
    acceptanceRows[index] = {
      ...current,
      status: '需返修',
      pending: true,
      abnormal: true,
      验收结论: '不合格',
      复修要求: requirement.trim() || String(current['复修要求'] ?? ''),
      [FIELD_LANDED_AT]: nowStamp(),
    }

    // 验收退回后，外出维修页重开返修事项：回到「维修中」并带上返修标记
    const relatedRepair = String(current['关联维修'] ?? '')
    const repairIndex = repairRows.findIndex(
      (row) => String(row['派遣编号'] ?? '') === relatedRepair,
    )
    if (repairIndex >= 0) {
      const repair = repairRows[repairIndex]
      repairRows[repairIndex] = {
        ...repair,
        status: '维修中',
        pending: true,
        abnormal: true,
        维修状态: '返修中',
        返修来源验收: String(current['验收编号'] ?? ''),
        返修要求: requirement.trim() || String(current['复修要求'] ?? ''),
        返修重开时间: nowStamp(),
        返修重开人: operator,
      }
      reopened.push(relatedRepair)
    }
  }

  saveRows(ACCEPT_KEY, acceptanceRows)
  saveRows(REPAIR_KEY, repairRows)
  return {
    ok: true,
    message: reopened.length
      ? `已退回 ${acceptanceIds.length} 条验收，并在外出维修页重开 ${reopened.length} 个返修事项（${reopened.join('、')}）`
      : `已退回 ${acceptanceIds.length} 条验收；未匹配到关联派遣，未重开返修事项`,
  }
}

export function listPackages(): PackageRecord[] {
  return loadPackages().sort((a, b) => b.id - a.id)
}

/** 返修事项完成返回：退出「返修中」，返修来源与要求按历史口径保留备查 */
export function markReworkFinished(repairId: number): void {
  const repairRows = [...listRows(REPAIR_KEY)]
  const index = repairRows.findIndex((row) => Number(row.id) === repairId)
  if (index < 0) {
    return
  }
  repairRows[index] = {
    ...repairRows[index],
    维修状态: '返修完成',
    abnormal: false,
    返修完成时间: nowStamp(),
  }
  saveRows(REPAIR_KEY, repairRows)
}

export function downloadPackage(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function packageRecordFilename(record: PackageRecord): string {
  const tag = record.landed ? `v${record.version}-已落地` : '未落地'
  return `会签资料包-${record.packageNo}-${tag}-${record.id}.csv`
}
