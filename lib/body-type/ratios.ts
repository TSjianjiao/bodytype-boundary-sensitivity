import { matchBodyType } from "./rules";
import type { BodyTypeId, MeasurementsCm, Ratios } from "./types";

/** 计算三项无量纲比例，单位在相除时抵消，cm 与 in 结果一致。 */
export function computeRatios(measurements: MeasurementsCm): Ratios {
  const { upper, waist, highHips, hips } = measurements;
  return {
    bustToHip: upper / hips,
    waistToHip: waist / hips,
    highHipToHip: highHips / hips,
  };
}

/**
 * 按比例直接判定体型标识。
 * 只做纯计算，不附带稳定半径，供算法入口与稳定半径搜索共用，避免循环依赖。
 */
export function classifyId(measurements: MeasurementsCm): BodyTypeId {
  const { bustToHip, waistToHip, highHipToHip } = computeRatios(measurements);
  return matchBodyType(bustToHip, waistToHip, highHipToHip);
}
