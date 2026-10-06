import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 会签资料包：验收编号、关联维修、维修质量、复修要求打包成 JSON 供现场离线填写，
// 上传后逐条校验，只有校验通过且版本未冲突的包才落地，旧版本材料转历史保留。
const PACKAGE_KEY = 'repair_accept_package'
const ACCEPT_KEY = 'repair_accept'
const REPAIR_KEY = 'out_repair'

export const PACKAGE_TYPE = '维修验收会签资料包'
export const PACKAGE_ITEMS = ['验收编号', '关联维修', '维修质量', '复修要求']
export const QUALITY_OPTIONS = ['优良', '合格', '不合格']

export type PackageItemResult = {
  条目: string
  结果: '通过' | '待补充'
  原因: string
}

export type PackageUploadResult = {
  ok: boolean
  结论: '通过' | '退回' | '待补充' | '重复上传' | '版本冲突' | '解析失败'
  message: string
  items: PackageItemResult[]
}

type ParsedPackage = {
  包编号: string
  基于版本: number
  条目: Record<string, string>
  会签信息: { 填写人: string; 填写日期: string; 会签意见: string }
}

function now(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function currentVersion(acceptRow: EntryRow | undefined): number {
  return Number(acceptRow?.['资料包版本'] ?? 0) || 0
}

/** 把一条验收记录打包成可下载的会签资料包。 */
export function buildPackage(row: EntryRow): { filename: string; content: string } {
  const 验收编号 = String(row['验收编号'] ?? '')
  const 基于版本 = currentVersion(row)
  const pack = {
    包类型: PACKAGE_TYPE,
    包编号: `PKG-${验收编号}-V${基于版本 + 1}`,
    验收编号,
    基于版本,
    生成时间: now(),
    条目: [
      { 条目: '验收编号', 值: 验收编号 },
      { 条目: '关联维修', 值: String(row['关联维修'] ?? '') },
      { 条目: '维修质量', 值: String(row['维修质量'] ?? '') },
      { 条目: '复修要求', 值: String(row['复修要求'] ?? '') },
    ],
    会签信息: { 填写人: '', 填写日期: '', 会签意见: '' },
  }
  return {
    filename: `${pack.包编号}.json`,
    content: JSON.stringify(pack, null, 2),
  }
}

export function downloadPackage(row: EntryRow): void {
  const { filename, content } = buildPackage(row)
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function listPackages(): EntryRow[] {
  return listRows(PACKAGE_KEY)
}

function recordPackage(status: string, fields: Record<string, string | number>): void {
  const rows = listRows(PACKAGE_KEY)
  const row: EntryRow = {
    id: nextId(rows),
    status,
    pending: status === '待补充',
    abnormal: status === '重复上传' || status === '版本冲突' || status === '解析失败',
    ...fields,
  }
  saveRows(PACKAGE_KEY, [...rows, row])
}

function normalize(pack: Record<string, unknown>): ParsedPackage {
  const 条目: Record<string, string> = {}
  const list = Array.isArray(pack['条目']) ? (pack['条目'] as Record<string, unknown>[]) : []
  for (const entry of list) {
    if (entry && typeof entry['条目'] === 'string') {
      条目[entry['条目']] = String(entry['值'] ?? '').trim()
    }
  }
  const 会签 = (pack['会签信息'] ?? {}) as Record<string, unknown>
  return {
    包编号: String(pack['包编号'] ?? '').trim(),
    基于版本: Number(pack['基于版本'] ?? 0) || 0,
    条目,
    会签信息: {
      填写人: String(会签['填写人'] ?? '').trim(),
      填写日期: String(会签['填写日期'] ?? '').trim(),
      会签意见: String(会签['会签意见'] ?? '').trim(),
    },
  }
}

function validateItems(
  parsed: ParsedPackage,
  acceptRow: EntryRow | undefined,
  repairRow: EntryRow | undefined,
): PackageItemResult[] {
  const items: PackageItemResult[] = []
  const values = parsed.条目
  if (!values['验收编号']) {
    items.push({ 条目: '验收编号', 结果: '待补充', 原因: '未填写验收编号' })
  } else if (!acceptRow) {
    items.push({ 条目: '验收编号', 结果: '待补充', 原因: `验收编号 ${values['验收编号']} 在维修验收里不存在` })
  } else {
    items.push({ 条目: '验收编号', 结果: '通过', 原因: '' })
  }
  if (!values['关联维修']) {
    items.push({ 条目: '关联维修', 结果: '待补充', 原因: '未填写关联维修' })
  } else if (!repairRow) {
    items.push({ 条目: '关联维修', 结果: '待补充', 原因: `外出维修里不存在派遣编号 ${values['关联维修']}` })
  } else if (acceptRow && String(acceptRow['关联维修']) !== values['关联维修']) {
    items.push({ 条目: '关联维修', 结果: '待补充', 原因: `与验收记录的关联维修 ${String(acceptRow['关联维修'])} 不一致` })
  } else {
    items.push({ 条目: '关联维修', 结果: '通过', 原因: '' })
  }
  if (!values['维修质量']) {
    items.push({ 条目: '维修质量', 结果: '待补充', 原因: '未填写维修质量' })
  } else if (!QUALITY_OPTIONS.includes(values['维修质量'])) {
    items.push({ 条目: '维修质量', 结果: '待补充', 原因: `维修质量须为 ${QUALITY_OPTIONS.join('/')} 之一` })
  } else {
    items.push({ 条目: '维修质量', 结果: '通过', 原因: '' })
  }
  if (values['维修质量'] === '不合格' && !values['复修要求']) {
    items.push({ 条目: '复修要求', 结果: '待补充', 原因: '维修质量为不合格时必须填写复修要求' })
  } else {
    items.push({ 条目: '复修要求', 结果: '通过', 原因: '' })
  }
  if (!parsed.会签信息.填写人) {
    items.push({ 条目: '会签信息', 结果: '待补充', 原因: '会签信息缺少填写人' })
  } else if (!parsed.会签信息.填写日期) {
    items.push({ 条目: '会签信息', 结果: '待补充', 原因: '会签信息缺少填写日期' })
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.会签信息.填写日期)) {
    items.push({ 条目: '会签信息', 结果: '待补充', 原因: '填写日期须为 YYYY-MM-DD 格式' })
  } else {
    items.push({ 条目: '会签信息', 结果: '通过', 原因: '' })
  }
  return items
}

/** 验收退回后重开外出维修的返修事项，返回重开的派遣编号。 */
export function reopenReworkForAcceptance(acceptRow: EntryRow): string {
  const dispatchId = String(acceptRow['关联维修'] ?? '')
  if (!dispatchId) {
    return ''
  }
  const rows = listRows(REPAIR_KEY)
  const index = rows.findIndex((row) => String(row['派遣编号']) === dispatchId)
  if (index < 0) {
    return ''
  }
  const updated: EntryRow = {
    ...rows[index],
    status: '维修中',
    pending: true,
    abnormal: true,
    返修说明: `验收 ${String(acceptRow['验收编号'] ?? '')} 退回，重开返修`,
  }
  const next = [...rows]
  next[index] = updated
  saveRows(REPAIR_KEY, next)
  return dispatchId
}

/** 上传会签资料包：逐条校验，通过/退回落地，待补充、重复、冲突只留记录不改验收。 */
export function uploadPackage(text: string, uploader: string): PackageUploadResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    recordPackage('解析失败', { 包编号: `(未识别-${now()})`, 失败条目: '整包：文件不是合法的 JSON', 上传人: uploader, 上传时间: now() })
    return {
      ok: false,
      结论: '解析失败',
      message: '文件不是合法的 JSON，无法解析',
      items: [{ 条目: '整包', 结果: '待补充', 原因: '文件不是合法的 JSON' }],
    }
  }
  const pack = raw as Record<string, unknown>
  if (pack['包类型'] !== PACKAGE_TYPE || !Array.isArray(pack['条目'])) {
    recordPackage('解析失败', { 包编号: `(未识别-${now()})`, 失败条目: '整包：文件不是会签资料包', 上传人: uploader, 上传时间: now() })
    return {
      ok: false,
      结论: '解析失败',
      message: '文件不是会签资料包，请使用系统下载的资料包填写',
      items: [{ 条目: '整包', 结果: '待补充', 原因: '包类型或条目结构不对' }],
    }
  }
  const parsed = normalize(pack)
  const base = {
    包编号: parsed.包编号 || '(缺少包编号)',
    验收编号: parsed.条目['验收编号'] ?? '',
    关联维修: parsed.条目['关联维修'] ?? '',
    基于版本: parsed.基于版本,
    上传人: uploader,
    上传时间: now(),
  }
  if (!parsed.包编号) {
    recordPackage('解析失败', { ...base, 失败条目: '整包：资料包缺少包编号' })
    return {
      ok: false,
      结论: '解析失败',
      message: '资料包缺少包编号，无法落账',
      items: [{ 条目: '整包', 结果: '待补充', 原因: '资料包缺少包编号' }],
    }
  }

  const acceptRow = listRows(ACCEPT_KEY).find((row) => String(row['验收编号']) === parsed.条目['验收编号'])
  const repairRow = listRows(REPAIR_KEY).find((row) => String(row['派遣编号']) === parsed.条目['关联维修'])
  const items = validateItems(parsed, acceptRow, repairRow)
  const failed = items.filter((item) => item.结果 === '待补充')
  if (failed.length > 0) {
    recordPackage('待补充', {
      ...base,
      校验结果: '待补充',
      失败条目: failed.map((item) => `${item.条目}：${item.原因}`).join('；'),
    })
    return {
      ok: false,
      结论: '待补充',
      message: `有 ${failed.length} 个条目待补充，本包未落地`,
      items,
    }
  }

  const landed = listRows(PACKAGE_KEY).find(
    (row) => String(row['包编号']) === parsed.包编号 && (row.status === '已落地' || row.status === '历史版本'),
  )
  if (landed) {
    recordPackage('重复上传', { ...base, 失败条目: `整包：包编号 ${parsed.包编号} 已落地` })
    return {
      ok: false,
      结论: '重复上传',
      message: '该资料包已落地，重复上传不会生成第二份验收记录',
      items,
    }
  }

  const version = currentVersion(acceptRow)
  if (parsed.基于版本 !== version) {
    recordPackage('版本冲突', {
      ...base,
      失败条目: `整包：基于版本 V${parsed.基于版本} 与当前版本 V${version} 不一致`,
    })
    return {
      ok: false,
      结论: '版本冲突',
      message: `已有其他会签版本落地（当前版本 V${version}），本包基于 V${parsed.基于版本}，未落地`,
      items,
    }
  }

  // 落地：旧版本材料转历史口径保留，本包成为唯一生效版本。
  const rejected = parsed.条目['维修质量'] === '不合格'
  const conclusion = rejected ? '退回' : '通过'
  const packages = listRows(PACKAGE_KEY).map((row) =>
    String(row['验收编号']) === base.验收编号 && row.status === '已落地'
      ? { ...row, status: '历史版本' }
      : row,
  )
  const landedRow: EntryRow = {
    id: nextId(packages),
    status: '已落地',
    pending: false,
    abnormal: false,
    ...base,
    版本: version + 1,
    校验结果: conclusion,
    失败条目: '',
    材料快照: JSON.stringify({ 条目: parsed.条目, 会签信息: parsed.会签信息 }),
  }
  saveRows(PACKAGE_KEY, [...packages, landedRow])

  const acceptRows = listRows(ACCEPT_KEY)
  const index = acceptRows.findIndex((row) => String(row['验收编号']) === base.验收编号)
  const updatedAccept: EntryRow = {
    ...acceptRows[index],
    status: rejected ? '需返修' : '已通过',
    pending: rejected,
    abnormal: false,
    维修质量: parsed.条目['维修质量'],
    复修要求: parsed.条目['复修要求'] ?? '',
    验收结论: rejected ? '会签退回' : '会签通过',
    验收人员: parsed.会签信息.填写人,
    验收日期: parsed.会签信息.填写日期,
    资料包版本: version + 1,
  }
  const nextAccept = [...acceptRows]
  nextAccept[index] = updatedAccept
  saveRows(ACCEPT_KEY, nextAccept)

  if (rejected) {
    const dispatchId = reopenReworkForAcceptance(updatedAccept)
    const reopenMsg = dispatchId ? `，外出维修 ${dispatchId} 已重开返修事项` : ''
    return { ok: true, 结论: conclusion, message: `会签退回：验收记录已转为需返修${reopenMsg}`, items }
  }
  return { ok: true, 结论: conclusion, message: '会签通过：验收记录已转为已通过', items }
}
