import { classifyId, computeRatios } from "./ratios";
import { findNearestShift } from "./stability";
import { ALGORITHM_VERSION } from "./thresholds";
import type { Classification, MeasurementsCm } from "./types";

export { ALGORITHM_VERSION };
export { classifyId, computeRatios };

/** 把比例格式化为百分比文本，保留一位小数。 */
function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * 根据比例判定体型。
 * 主结果只由规则表决定；稳定半径与可达分类作为附加几何信息返回，不参与判定。
 */
export function classify(measurements: MeasurementsCm): Classification {
  return {
    id: classifyId(measurements),
    ratios: computeRatios(measurements),
    nearestShift: findNearestShift(measurements),
  };
}

/** 返回四项输入之间明显不一致时的提示，结果卡与导出图片共用同一份文案。 */
export function measurementWarnings(measurements: MeasurementsCm): string[] {
  const warnings: string[] = [];
  if (measurements.highHips > measurements.hips) {
    warnings.push(
      "Your high hip is larger than your full hip. High hip is measured midway between the waist and hip levels, so check the tape height; the result uses the values as entered.",
    );
  }
  if (measurements.highHips <= measurements.waist) {
    warnings.push(
      "Your high hip is not larger than your waist. Check that the tape is between the waist and hip levels, not at the waist; the result uses the values as entered.",
    );
  }
  return warnings;
}

/** 生成一句话判定依据，说明本次命中的比例关系。 */
export function classificationBasis(classification: Classification): string {
  const { bustToHip, waistToHip, highHipToHip } = classification.ratios;
  return `Bust is ${percent(bustToHip)} of hips, waist is ${percent(waistToHip)} of hips, and high hip is ${percent(highHipToHip)} of hips.`;
}
