/** 维修验收「会签资料包」领域模型与纯逻辑：资料包打包、CSV 解析、逐条校验规则。
 * 资料包为 UTF-8 带 BOM 的 CSV：前四列由系统打包（现场不可改），后三列由现场人员离线填写。 */
import type { EntryRow } from './types'

/** 通过 / 退回 / 待补充：系统对资料包内每一条验收记录给出的校验结果 */
export type ItemVerdict = 'pass' | 'return' | 'supplement'

/** 资料包内的一条验收材料 */
export type PackageItem = {
  packageNo: string
  /** 下发时该验收已落地的材料版本：现场填写期间若他人已上传新版本，本基线即过期 */
  baseVersion: number
  acceptanceNo: string
  relatedRepair: string
  quality: string
  repairRequirement: string
  /** 以下三项现场离线填写 */
  conclusion: string
  signer: string
  signDate: string
}

/** 单条校验结论（reject 表示结构性拒收：编号不存在或关联维修不符） */
export type ItemCheck = {
  acceptanceNo: string
  relatedRepair: string
  verdict: ItemVerdict | 'reject'
  reasons: string[]
  item: PackageItem
}

/** 一次上传形成的资料包版本记录，无论是否落地都追加留档 */
export type PackageRecord = {
  id: number
  packageNo: string
  /** 本次落地涉及条目的最大材料版本号 */
  version: number
  acceptanceNos: string[]
  submittedAt: string
  submittedBy: string
  /** 是否成功落地：重复、冲突、结构性问题均为 false，不写入任何业务数据 */
  landed: boolean
  outcome: 'passed' | 'returned' | 'supplement' | 'duplicate' | 'conflict' | 'structure' | 'invalid'
  message: string
  items: ItemCheck[]
  /** 上传时的原始材料，旧版本材料按历史口径保留并可重新下载 */
  snapshot: PackageItem[]
}

export const PACKAGE_HEADER = [
  '资料包编号',
  '基线版本',
  '验收编号',
  '关联维修',
  '维修质量',
  '复修要求',
  '验收结论',
  '现场会签人',
  '会签日期',
] as const

const PASS_WORDS = ['合格', '通过']
const RETURN_WORDS = ['不合格', '退回', '返修']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function normalizeConclusion(raw: string): 'pass' | 'return' | null {
  const value = raw.trim()
  if (!value) {
    return null
  }
  if (PASS_WORDS.includes(value)) {
    return 'pass'
  }
  if (RETURN_WORDS.includes(value)) {
    return 'return'
  }
  return null
}

export function nextPackageCode(existingCount: number, now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const ymd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  return `CS-${ymd}-${String(existingCount + 1).padStart(3, '0')}`
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** 状态机解析 CSV，兼容引号、转义引号、字段内换行 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') {
        i += 1
      }
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  row.push(field)
  rows.push(row)
  return rows
}

export function serializePackage(items: PackageItem[]): string {
  const lines = [PACKAGE_HEADER.join(',')]
  for (const item of items) {
    lines.push(
      [
        item.packageNo,
        String(item.baseVersion),
        item.acceptanceNo,
        item.relatedRepair,
        item.quality,
        item.repairRequirement,
        item.conclusion,
        item.signer,
        item.signDate,
      ]
        .map((cell) => csvEscape(String(cell ?? '')))
        .join(','),
    )
  }
  return `\uFEFF${lines.join('\r\n')}`
}

export function parsePackage(text: string): PackageItem[] {
  const clean = text.replace(/^\uFEFF/, '').trim()
  if (!clean) {
    throw new Error('资料包内容为空')
  }
  const rows = parseCsv(clean)
  const header = (rows[0] ?? []).map((cell) => cell.trim())
  const indices = PACKAGE_HEADER.map((name) => header.indexOf(name))
  if (indices.some((index) => index < 0)) {
    throw new Error('资料包表头与系统模板不一致，请使用系统下发的资料包填写')
  }
  const items: PackageItem[] = []
  for (const cells of rows.slice(1)) {
    if (cells.every((cell) => cell.trim() === '')) {
      continue
    }
    const get = (index: number) => (cells[index] ?? '').trim()
    items.push({
      packageNo: get(indices[0]),
      baseVersion: Number(get(indices[1])) || 0,
      acceptanceNo: get(indices[2]),
      relatedRepair: get(indices[3]),
      quality: get(indices[4]),
      repairRequirement: get(indices[5]),
      conclusion: get(indices[6]),
      signer: get(indices[7]),
      signDate: get(indices[8]),
    })
  }
  if (!items.length) {
    throw new Error('资料包内没有任何验收条目')
  }
  return items
}

/** 逐条校验：先看结构性问题（整包拒收），再看现场填写完整性与结论 */
export function checkItem(item: PackageItem, acceptance: EntryRow | undefined): ItemCheck {
  const base: ItemCheck = {
    acceptanceNo: item.acceptanceNo,
    relatedRepair: item.relatedRepair,
    verdict: 'supplement',
    reasons: [],
    item,
  }
  if (!acceptance) {
    return { ...base, verdict: 'reject', reasons: ['验收编号在系统中不存在'] }
  }
  const expectedRepair = String(acceptance['关联维修'] ?? '')
  if (item.relatedRepair !== expectedRepair) {
    return {
      ...base,
      verdict: 'reject',
      reasons: [`关联维修与验收记录不符，应为「${expectedRepair}」`],
    }
  }

  const conclusion = normalizeConclusion(item.conclusion)
  if (!item.conclusion) {
    base.reasons.push('验收结论未填写')
  } else if (!conclusion) {
    base.reasons.push(`验收结论「${item.conclusion}」无法识别，请填写“合格”或“不合格”`)
  }
  if (!item.signer) {
    base.reasons.push('现场会签人未填写')
  }
  if (!item.signDate) {
    base.reasons.push('会签日期未填写')
  } else if (!DATE_RE.test(item.signDate)) {
    base.reasons.push('会签日期格式应为 YYYY-MM-DD')
  }
  if (conclusion === 'return' && !item.repairRequirement.trim()) {
    base.reasons.push('验收判定不合格，但未填写复修要求')
  }

  if (base.reasons.length > 0) {
    base.verdict = 'supplement'
  } else {
    base.verdict = conclusion === 'return' ? 'return' : 'pass'
  }
  return base
}
