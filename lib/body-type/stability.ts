import { classifyId } from "./ratios";
import { MAX_STABILITY_CM, RADIUS_PRECISION_CM } from "./thresholds";
import { BODY_TYPE_IDS, FIELD_ORDER, type BodyTypeId, type MeasurementsCm, type NearestShift } from "./types";
import { MAX_CM, MIN_CM } from "./units";

/**
 * 判断四项测量各偏移不超过 d 时分类是否会改变。
 * 谓词对 d 单调，因此可以二分求稳定半径。
 */
function changesWithin(measurements: MeasurementsCm, d: number): boolean {
  const base = classifyId(measurements);
  for (const field of FIELD_ORDER) {
    for (const direction of [-1, 1]) {
      const shifted = { ...measurements, [field]: measurements[field] + direction * d };
      // 偏移越出公开范围时不参与比较，避免用非法值制造假的稳定性。
      if (shifted[field] < MIN_CM || shifted[field] > MAX_CM) continue;
      if (classifyId(shifted) !== base) return true;
    }
  }
  return false;
}

/** 把稳定半径量化到固定精度；小于半个精度视为 0，表示输入本身落在边界上。 */
function quantizeRadius(raw: number): number {
  if (!Number.isFinite(raw)) return raw;
  const half = RADIUS_PRECISION_CM / 2;
  if (raw < half) return 0;
  return Math.round(raw / RADIUS_PRECISION_CM) * RADIUS_PRECISION_CM;
}

/** 二分求稳定半径：单项测量偏差小于该值时分类不变。 */
function stabilityRadius(measurements: MeasurementsCm): number {
  if (!changesWithin(measurements, MAX_STABILITY_CM)) return Infinity;
  let low = 0;
  let high = MAX_STABILITY_CM;
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) / 2;
    if (changesWithin(measurements, mid)) high = mid;
    else low = mid;
  }
  return quantizeRadius(high);
}

/**
 * 收集在稳定半径处可达的其他分类。
 * 半径量化后可能有多个分类同时可达（例如输入同时压在两个阈值上），因此返回数组。
 */
function collectNeighbors(measurements: MeasurementsCm, radius: number): BodyTypeId[] {
  const base = classifyId(measurements);
  // 半径为 0 时没有可展示的正距离，用一个最小可分辨偏移探测边界另一侧。
  const probe = radius === Infinity ? MAX_STABILITY_CM : Math.max(radius, RADIUS_PRECISION_CM) + 1e-9;
  const found = new Set<BodyTypeId>();
  for (const field of FIELD_ORDER) {
    for (const direction of [-1, 1]) {
      const value = measurements[field] + direction * probe;
      if (value < MIN_CM || value > MAX_CM) continue;
      const id = classifyId({ ...measurements, [field]: value });
      if (id !== base) found.add(id);
    }
  }
  // 按声明顺序归一化，保证同一输入顺序稳定，测试可用 deepEqual 断言。
  return BODY_TYPE_IDS.filter((id) => found.has(id));
}

/** 计算稳定半径与可达分类，供结果卡与导出图片共用的几何信息。 */
export function findNearestShift(measurements: MeasurementsCm): NearestShift {
  const radius = stabilityRadius(measurements);
  if (radius === Infinity) return { radius, neighbors: [] };
  return { radius, neighbors: collectNeighbors(measurements, radius) };
}
