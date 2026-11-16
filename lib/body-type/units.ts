import type { ParseResult, Unit } from "./types";

/** 1 英寸对应的厘米数，项目内唯一的换算常量。 */
export const CM_PER_INCH = 2.54;

/** 公开的最小围度（厘米），用于拦截明显误输入，不是医学界限。 */
export const MIN_CM = 40;

/** 公开的最大围度（厘米），用于拦截明显误输入，不是医学界限。 */
export const MAX_CM = 200;

/** 一个数值字段公开的允许范围，单位为厘米。 */
export interface MeasurementRange {
  /** 允许的最小值，厘米。 */
  minCm: number;
  /** 允许的最大值，厘米。 */
  maxCm: number;
}

/** 四项围度共用的公开输入范围。 */
export const MEASUREMENT_RANGE: MeasurementRange = { minCm: MIN_CM, maxCm: MAX_CM };

/** 各单位的显示后缀。 */
export const UNIT_LABEL: Record<Unit, string> = {
  /** 厘米。 */
  cm: "cm",
  /** 英寸。 */
  in: "in",
};

/** 把厘米值转换为指定单位下的数值。 */
export function fromCm(cm: number, unit: Unit): number {
  return unit === "cm" ? cm : cm / CM_PER_INCH;
}

/** 把指定单位下的数值换算为厘米。 */
export function toCm(value: number, unit: Unit): number {
  return unit === "cm" ? value : value * CM_PER_INCH;
}

/** 去掉多余的尾随零，保留用户可读的简短数字。 */
function trimTrailingZeros(text: string): string {
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/**
 * 把厘米值格式化为目标单位下的显示文本。
 * 厘米保留 1 位小数，英寸保留 2 位小数；仅用于单位切换时的初始回显。
 */
export function formatFromCm(cm: number, unit: Unit): string {
  return trimTrailingZeros(fromCm(cm, unit).toFixed(unit === "cm" ? 1 : 2));
}

/**
 * 解析用户输入：只接受正数文本，换算为厘米后按调用方给定的范围校验。
 * 不做任何四舍五入，避免单位切换时分类或合身参考值漂移。
 */
export function parseMeasurementInRange(
  raw: string,
  unit: Unit,
  range: MeasurementRange,
): ParseResult {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "empty" };
  // 允许 "27"、".5"、"27.20"，拒绝正负号、科学计数法、千分位与多余字符。
  if (!/^\d*\.?\d+$/.test(text)) return { ok: false, reason: "invalid" };
  const cm = toCm(Number(text), unit);
  if (!Number.isFinite(cm) || cm < range.minCm || cm > range.maxCm) {
    return { ok: false, reason: "range" };
  }
  return { ok: true, cm };
}

/** 解析四项围度输入，使用公开的围度范围。 */
export function parseMeasurement(raw: string, unit: Unit): ParseResult {
  return parseMeasurementInRange(raw, unit, MEASUREMENT_RANGE);
}

/**
 * 返回当前单位下指定范围的可读文本，用于表单提示与错误说明。
 * 英寸向外取整到可显示精度，保证提示的上下限本身一定能通过校验。
 */
export function rangeLabelFor(unit: Unit, range: MeasurementRange): string {
  const decimals = unit === "cm" ? 1 : 2;
  const factor = 10 ** decimals;
  const min = Math.ceil(fromCm(range.minCm, unit) * factor) / factor;
  const max = Math.floor(fromCm(range.maxCm, unit) * factor) / factor;
  return `${trimTrailingZeros(min.toFixed(decimals))}–${trimTrailingZeros(max.toFixed(decimals))} ${UNIT_LABEL[unit]}`;
}

/** 返回四项围度公开范围的可读文本。 */
export function rangeLabel(unit: Unit): string {
  return rangeLabelFor(unit, MEASUREMENT_RANGE);
}

/** 返回校验失败时的英文页面错误说明，范围文案由调用方提供。 */
export function parseErrorMessageInRange(
  reason: "empty" | "invalid" | "range",
  unit: Unit,
  range: MeasurementRange,
): string {
  if (reason === "empty") return "Enter a measurement.";
  if (reason === "invalid") return "Use digits only, for example 92.5.";
  return `Enter a value between ${rangeLabelFor(unit, range)}.`;
}

/** 返回四项围度校验失败的英文页面错误说明。 */
export function parseErrorMessage(reason: "empty" | "invalid" | "range", unit: Unit): string {
  return parseErrorMessageInRange(reason, unit, MEASUREMENT_RANGE);
}
