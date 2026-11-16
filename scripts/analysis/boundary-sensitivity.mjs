// 02 边界敏感性分析：在 Bodytype v2 的四围度规则空间内做确定性合成扫描。
// 只调用项目内规则函数，不复制判定逻辑；输出逐点 CSV、汇总 JSON、转移矩阵与图表数据。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

/** 当前工作目录；脚本固定从项目根目录运行。 */
const ROOT = process.cwd();

/** 以本地日期生成运行目录名，格式 YYYY-MM-DD。 */
const RUN_DATE = new Date().toLocaleDateString("sv-SE");

/** 本地全量输出目录；大文件不提交到站点仓库。 */
const OUTPUT_DIR = path.join(ROOT, "data", "boundary-sensitivity", "v2", RUN_DATE);

/** 站内公开样例与汇总目录。 */
const PUBLIC_DIR = path.join(
  ROOT,
  "public",
  "data",
  "research",
  "boundary-sensitivity",
  "v2",
);

/** 固定的臀围档位，厘米。 */
const HIPS = [80, 90, 100, 110, 120, 130, 140];

/** 胸臀比网格：0.900 到 1.100，步长 0.005，用千分位整数避免浮点步进误差。 */
const BUST_BP = { min: 900, max: 1100, step: 5 };

/** 腰臀比网格：0.650 到 0.950，步长 0.005。 */
const WAIST_BP = { min: 650, max: 950, step: 5 };

/** 上臀臀比网格：0.700 到 1.000，步长 0.005。 */
const HIGH_HIP_BP = { min: 700, max: 1000, step: 5 };

/** 扰动幅度，厘米。 */
const AMPLITUDES = [0.5, 1, 2];

/** 生成 CSV 时的字段顺序，与 02 工作稿的数据字典一致。 */
const CSV_COLUMNS = [
  "id",
  "hips_cm",
  "bust_cm",
  "waist_cm",
  "high_hips_cm",
  "bust_to_hip",
  "waist_to_hip",
  "high_hip_to_hip",
  "base_label",
  "stability_radius_cm",
  "neighbor_labels",
  "proximity_tier",
  "nearest_threshold",
  "nearest_threshold_distance",
  "flip_any_0_5cm",
  "flip_any_1cm",
  "flip_any_2cm",
  "flip_fields_1cm",
  "flip_labels_1cm",
  "round_0_5_label",
  "round_1cm_label",
  "round_0_1in_label",
  "unit_round_trip_label",
  "unit_round_trip_changed",
  "at_boundary",
  "skipped_out_of_range",
];

/** 体型标识的固定排序，由运行时从项目 BODY_TYPE_IDS 注入，避免另建一份标签顺序。 */
let bodyTypeOrder = [];

/** 内部字段名到公开字段名的映射，用于转移矩阵与汇总。 */
const PUBLIC_FIELD = {
  upper: "bust",
  waist: "waist",
  highHips: "highHip",
  hips: "hips",
};

/**
 * 五个判定阈值，以及比例位于阈值某一侧的条件。
 * 条件与 rules.ts 的比较方向一致：bustToHip:0.95 用严格小于，
 * 其余用小于等于或大于等于；比较偏移前后的布尔值即可判断是否跨越。
 */
const THRESHOLDS = [
  {
    name: "bustToHip:0.95",
    ratio: "bustToHip",
    value: 0.95,
    test: (value) => value < 0.95,
  },
  {
    name: "bustToHip:1.05",
    ratio: "bustToHip",
    value: 1.05,
    test: (value) => value <= 1.05,
  },
  {
    name: "waistToHip:0.80",
    ratio: "waistToHip",
    value: 0.8,
    test: (value) => value <= 0.8,
  },
  {
    name: "waistToHip:0.88",
    ratio: "waistToHip",
    value: 0.88,
    test: (value) => value >= 0.88,
  },
  {
    name: "highHipToHip:0.95",
    ratio: "highHipToHip",
    value: 0.95,
    test: (value) => value <= 0.95,
  },
];

/** 把数值格式化为固定小数位，并去掉多余的尾随零。 */
function formatNumber(value, decimals = 6) {
  if (value === Infinity) return "Infinity";
  if (!Number.isFinite(value)) return String(value);
  const text = value.toFixed(decimals);
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** 转义单个 CSV 单元格，处理逗号、引号与换行。 */
function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 按固定列顺序生成 CSV 文本，使用 UTF-8 无 BOM。 */
function toCsv(columns, rows) {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** 按指定步长四舍五入，恰好半格时向上；加极小量抵消二进制浮点误差。 */
function roundHalfUp(value, step) {
  return Math.floor(value / step + 0.5 + 1e-9) * step;
}

/** 对四项测量分别应用同一个变换，保持字段名不变。 */
function mapMeasurements(point, transform) {
  return {
    upper: transform(point.upper),
    waist: transform(point.waist),
    hips: transform(point.hips),
    highHips: transform(point.highHips),
  };
}

/** 返回一次比例变化跨过的阈值名称；可能同时跨过多个阈值。 */
function crossedThresholds(before, after) {
  return THRESHOLDS.filter(
    (threshold) =>
      threshold.test(before[threshold.ratio]) !==
      threshold.test(after[threshold.ratio]),
  ).map((threshold) => threshold.name);
}

/** 计算比例到最近判定阈值的绝对距离，距离相同时按固定顺序取第一个。 */
function nearestThreshold(ratios) {
  let best = THRESHOLDS[0];
  let bestDistance = Math.abs(ratios[best.ratio] - best.value);
  for (const threshold of THRESHOLDS.slice(1)) {
    const distance = Math.abs(ratios[threshold.ratio] - threshold.value);
    if (distance < bestDistance) {
      best = threshold;
      bestDistance = distance;
    }
  }
  return { name: best.name, distance: bestDistance };
}

/** 生成比例百分数，保留一位小数。 */
function percent(numerator, denominator) {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** 生成同时包含分子、分母与一位小数百分比的率对象。 */
function makeRate(numerator, denominator) {
  return {
    numerator,
    denominator,
    rate: percent(numerator, denominator),
  };
}

/** 读取 Git 信息；失败时返回空字符串，便于在非 Git 环境复现。 */
function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** 计算文件内容的 SHA-256。 */
function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** 生成稳定主键，例如 H100_B0.960_W0.720_HH0.940。 */
function pointId(hips, bustBp, waistBp, highHipBp) {
  return `H${hips}_B${(bustBp / 1000).toFixed(3)}_W${(waistBp / 1000).toFixed(3)}_HH${(highHipBp / 1000).toFixed(3)}`;
}

/** 按基点标签与臀围分档做确定性分层抽样，保证样例覆盖所有组合。 */
function sampleRows(records, perGroup = 12) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.baseLabel}|${record.hips}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const picked = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.id.localeCompare(b.id));
    // 每个分层均匀抽取固定数量，避免只取排序后的第一段。
    const count = Math.min(perGroup, group.length);
    for (let index = 0; index < count; index += 1) {
      const position = Math.floor((index * group.length) / count);
      picked.push(group[position]);
    }
  }
  return picked.sort((a, b) => a.id.localeCompare(b.id));
}

/** 启动 Vite SSR 加载器，读取项目 TypeScript 规则模块。 */
async function loadRules() {
  const server = await createServer({
    configFile: false,
    root: ROOT,
    appType: "custom",
    logLevel: "error",
    // 关闭文件监听，避免写输出文件时触发 HMR 回调与服务器关闭竞争。
    server: { middlewareMode: true, watch: null },
  });
  const { classifyId, computeRatios } = await server.ssrLoadModule(
    "/lib/body-type/ratios.ts",
  );
  const { measurementWarnings } = await server.ssrLoadModule(
    "/lib/body-type/algorithm.ts",
  );
  const { findNearestShift } = await server.ssrLoadModule("/lib/body-type/stability.ts");
  const { ALGORITHM_VERSION } = await server.ssrLoadModule("/lib/body-type/thresholds.ts");
  const { BODY_TYPE_IDS, FIELD_ORDER } = await server.ssrLoadModule("/lib/body-type/types.ts");
  const { MIN_CM, MAX_CM, CM_PER_INCH } = await server.ssrLoadModule("/lib/body-type/units.ts");
  return {
    server,
    classifyId,
    computeRatios,
    measurementWarnings,
    findNearestShift,
    ALGORITHM_VERSION,
    BODY_TYPE_IDS,
    FIELD_ORDER,
    MIN_CM,
    MAX_CM,
    CM_PER_INCH,
  };
}

/** 扫描主网格并返回逐点记录、计数与检查结果。 */
function scanGrid(rules) {
  const {
    classifyId,
    computeRatios,
    findNearestShift,
    BODY_TYPE_IDS,
    FIELD_ORDER,
    MIN_CM,
    MAX_CM,
    CM_PER_INCH,
  } = rules;
  const records = [];
  const seenIds = new Set();
  let expectedPairs = 0;
  let allValuesInRange = true;

  // 独立计算有序比例对数量，作为网格完整性检查的期望值。
  for (let waistBp = WAIST_BP.min; waistBp <= WAIST_BP.max; waistBp += WAIST_BP.step) {
    for (
      let highHipBp = HIGH_HIP_BP.min;
      highHipBp <= HIGH_HIP_BP.max;
      highHipBp += HIGH_HIP_BP.step
    ) {
      if (waistBp < highHipBp && highHipBp < 1000) expectedPairs += 1;
    }
  }

  /** 胸臀比档位数量，期望总数还要乘以该档位数与臀围档位数。 */
  const bustCount = Math.floor((BUST_BP.max - BUST_BP.min) / BUST_BP.step) + 1;

  for (const hips of HIPS) {
    for (let bustBp = BUST_BP.min; bustBp <= BUST_BP.max; bustBp += BUST_BP.step) {
      for (let waistBp = WAIST_BP.min; waistBp <= WAIST_BP.max; waistBp += WAIST_BP.step) {
        for (
          let highHipBp = HIGH_HIP_BP.min;
          highHipBp <= HIGH_HIP_BP.max;
          highHipBp += HIGH_HIP_BP.step
        ) {
          // 主网格只保留“腰围 < 上臀围 < 臀围”的有序组合。
          if (!(waistBp < highHipBp && highHipBp < 1000)) continue;
          const point = {
            upper: (bustBp / 1000) * hips,
            waist: (waistBp / 1000) * hips,
            hips,
            highHips: (highHipBp / 1000) * hips,
          };
          for (const value of Object.values(point)) {
            if (value < MIN_CM || value > MAX_CM) allValuesInRange = false;
          }
          const id = pointId(hips, bustBp, waistBp, highHipBp);
          if (seenIds.has(id)) throw new Error(`主键重复：${id}`);
          seenIds.add(id);

          const baseLabel = classifyId(point);
          const stability = findNearestShift(point);
          const ratios = computeRatios(point);
          const threshold = nearestThreshold(ratios);
          const atBoundary = stability.radius === 0;
          const proximityTier =
            stability.radius < 1 ? "very-close" : stability.radius < 3 ? "close" : "hidden";

          const fieldFlip = {};
          const directionFlip = {};
          const flipAny = {};
          for (const amplitude of AMPLITUDES) {
            fieldFlip[amplitude] = Object.fromEntries(FIELD_ORDER.map((field) => [field, false]));
            directionFlip[amplitude] = { plus: false, minus: false };
            flipAny[amplitude] = false;
          }
          const flipEvents = [];
          let skippedOutOfRange = false;

          for (const amplitude of AMPLITUDES) {
            for (const field of FIELD_ORDER) {
              for (const direction of [-1, 1]) {
                const value = point[field] + direction * amplitude;
                // 偏移越出公开范围时跳过该组合，不制造非法测试点。
                if (value < MIN_CM || value > MAX_CM) {
                  skippedOutOfRange = true;
                  continue;
                }
                const shiftedLabel = classifyId({ ...point, [field]: value });
                if (shiftedLabel === baseLabel) continue;
                flipAny[amplitude] = true;
                fieldFlip[amplitude][field] = true;
                directionFlip[amplitude][direction > 0 ? "plus" : "minus"] = true;
                if (amplitude === 1) {
                  const shiftedRatios = computeRatios({ ...point, [field]: value });
                  flipEvents.push({
                    field: PUBLIC_FIELD[field],
                    direction: direction > 0 ? 1 : -1,
                    target: shiftedLabel,
                    crossedThresholds: crossedThresholds(ratios, shiftedRatios),
                  });
                }
              }
            }
          }

          const roundedHalfLabel = classifyId(
            mapMeasurements(point, (value) => roundHalfUp(value, 0.5)),
          );
          const roundedOneLabel = classifyId(
            mapMeasurements(point, (value) => roundHalfUp(value, 1)),
          );
          const roundedInchLabel = classifyId(
            mapMeasurements(
              point,
              (value) => roundHalfUp(value / CM_PER_INCH, 0.1) * CM_PER_INCH,
            ),
          );
          const unitRoundTripLabel = classifyId(
            mapMeasurements(point, (value) => (value / CM_PER_INCH) * CM_PER_INCH),
          );

          records.push({
            id,
            hips,
            upper: point.upper,
            waist: point.waist,
            highHips: point.highHips,
            bustToHip: ratios.bustToHip,
            waistToHip: ratios.waistToHip,
            highHipToHip: ratios.highHipToHip,
            baseLabel,
            radius: stability.radius,
            neighbors: stability.neighbors,
            proximityTier,
            nearestThreshold: threshold.name,
            nearestThresholdDistance: threshold.distance,
            atBoundary,
            skippedOutOfRange,
            flipAny,
            fieldFlip,
            directionFlip,
            flipEvents,
            roundedHalfLabel,
            roundedOneLabel,
            roundedInchLabel,
            unitRoundTripLabel,
            allNeighborsValid: stability.neighbors.every((label) =>
              BODY_TYPE_IDS.includes(label),
            ),
          });
        }
      }
    }
  }

  return {
    records,
    expectedTotal: expectedPairs * bustCount * HIPS.length,
    allValuesInRange,
  };
}

/**
 * 生成输入一致性警告的补充测试点。
 * 只覆盖 highHips ≥ hips 或 highHips ≤ waist 的情形，不并入主网格的分母。
 */
function scanWarningCases(rules) {
  const { classifyId, measurementWarnings, BODY_TYPE_IDS, MIN_CM, MAX_CM } = rules;
  const warningHips = [80, 100, 120];
  const bustRatios = [0.9, 1.0, 1.1];
  const waistRatios = [0.7, 0.8, 0.88, 0.95];
  const highHipRatios = [0.7, 0.8, 0.88, 0.95, 1.0, 1.05, 1.1];
  const cases = [];
  const seen = new Set();

  for (const hips of warningHips) {
    for (const bustRatio of bustRatios) {
      for (const waistRatio of waistRatios) {
        for (const highHipRatio of highHipRatios) {
          // 只保留会触发“上臀围不小于臀围”或“上臀围不大于腰围”的点。
          const highHips = highHipRatio * hips;
          if (!(highHips >= hips || highHips <= waistRatio * hips)) continue;
          const point = {
            upper: bustRatio * hips,
            waist: waistRatio * hips,
            hips,
            highHips,
          };
          if (Object.values(point).some((value) => value < MIN_CM || value > MAX_CM)) {
            continue;
          }
          const id = `W${hips}_B${bustRatio.toFixed(2)}_W${waistRatio.toFixed(2)}_HH${highHipRatio.toFixed(2)}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const warnings = measurementWarnings(point);
          cases.push({
            id,
            hips,
            upper: point.upper,
            waist: point.waist,
            highHips: point.highHips,
            baseLabel: classifyId(point),
            highHipAboveHips: highHips > hips,
            highHipAtHips: highHips === hips,
            highHipAtOrBelowWaist: highHips <= point.waist,
            warnings,
          });
        }
      }
    }
  }

  const warningCounts = new Map();
  for (const item of cases) {
    for (const warning of item.warnings) {
      warningCounts.set(warning, (warningCounts.get(warning) ?? 0) + 1);
    }
  }

  return {
    cases,
    summary: {
      total: cases.length,
      highHipAboveHips: cases.filter((item) => item.highHipAboveHips).length,
      highHipAtHips: cases.filter((item) => item.highHipAtHips).length,
      highHipAtOrBelowWaist: cases.filter((item) => item.highHipAtOrBelowWaist).length,
      both: cases.filter(
        (item) => item.highHipAboveHips && item.highHipAtOrBelowWaist,
      ).length,
      withWarnings: cases.filter((item) => item.warnings.length > 0).length,
      withoutWarnings: cases.filter((item) => item.warnings.length === 0).length,
      equalityWithoutWarning: cases.filter(
        (item) => item.highHipAtHips && item.warnings.length === 0,
      ).length,
      warningCounts: Object.fromEntries(warningCounts),
      allLabelsValid: cases.every((item) => BODY_TYPE_IDS.includes(item.baseLabel)),
    },
  };
}

/** 生成补充集 CSV 行。 */
function warningCaseRows(cases) {
  return cases.map((item) => ({
    id: item.id,
    hips_cm: formatNumber(item.hips),
    bust_cm: formatNumber(item.upper),
    waist_cm: formatNumber(item.waist),
    high_hips_cm: formatNumber(item.highHips),
    base_label: item.baseLabel,
    high_hip_above_hips: item.highHipAboveHips,
    high_hip_at_hips: item.highHipAtHips,
    high_hip_at_or_below_waist: item.highHipAtOrBelowWaist,
    warnings: item.warnings.join(" | "),
  }));
}

/** 基于逐点记录计算汇总统计。 */
function summarize(records, rules) {
  const { BODY_TYPE_IDS } = rules;
  const total = records.length;
  const countByLabel = Object.fromEntries(BODY_TYPE_IDS.map((label) => [label, 0]));
  const countByHips = Object.fromEntries(HIPS.map((hips) => [String(hips), 0]));
  const flipAny = { "0.5": 0, 1: 0, 2: 0 };
  const flipField = {};
  const flipDirection = {};
  for (const amplitude of AMPLITUDES) {
    flipField[amplitude] = Object.fromEntries(
      ["upper", "waist", "hips", "highHips"].map((field) => [PUBLIC_FIELD[field], 0]),
    );
    flipDirection[amplitude] = { plus: 0, minus: 0 };
  }
  const stability = { lt1cm: 0, oneTo3cm: 0, gte3cmFinite: 0, infinity: 0, atBoundary: 0 };
  const rounding = {
    halfCm: { changed: 0, denominator: total },
    oneCm: { changed: 0, denominator: total },
    pointOneIn: { changed: 0, denominator: total },
  };
  const unitRoundTrip = {
    changed: 0,
    denominator: total,
    changedAtBoundary: 0,
    changedNotAtBoundary: 0,
    changedByBaseLabel: Object.fromEntries(BODY_TYPE_IDS.map((label) => [label, 0])),
    changedByNearestThreshold: Object.fromEntries(
      THRESHOLDS.map((threshold) => [threshold.name, 0]),
    ),
  };
  const thresholdGroups = Object.fromEntries(
    THRESHOLDS.map((threshold) => [threshold.name, { points: 0, flipAny1cm: 0 }]),
  );
  const hipsGroups = Object.fromEntries(
    HIPS.map((hips) => [String(hips), { points: 0, flipAny1cm: 0 }]),
  );
  const byLabel = Object.fromEntries(
    BODY_TYPE_IDS.map((label) => [
      label,
      {
        points: 0,
        flipAny1cm: 0,
        flipByField1cm: Object.fromEntries(
          ["upper", "waist", "hips", "highHips"].map((field) => [PUBLIC_FIELD[field], 0]),
        ),
        stability: { lt1cm: 0, oneTo3cm: 0, gte3cmFinite: 0, infinity: 0, atBoundary: 0 },
      },
    ]),
  );
  const transition = new Map();
  const transitionByField = new Map();
  const thresholdCrossings = Object.fromEntries(
    THRESHOLDS.map((threshold) => [threshold.name, 0]),
  );
  let totalFlipEvents = 0;
  let eventsWithMultipleThresholds = 0;
  let eventsWithNoThreshold = 0;

  for (const record of records) {
    countByLabel[record.baseLabel] += 1;
    countByHips[String(record.hips)] += 1;
    for (const amplitude of AMPLITUDES) {
      if (record.flipAny[amplitude]) flipAny[amplitude] += 1;
      for (const field of Object.keys(record.fieldFlip[amplitude])) {
        if (record.fieldFlip[amplitude][field]) {
          flipField[amplitude][PUBLIC_FIELD[field]] += 1;
        }
      }
      for (const direction of ["plus", "minus"]) {
        if (record.directionFlip[amplitude][direction]) {
          flipDirection[amplitude][direction] += 1;
        }
      }
    }

    // 稳定半径分档：边界点计入 <1 cm，同时单独计数；Infinity 单列。
    if (record.radius === Infinity) stability.infinity += 1;
    else if (record.radius < 1) stability.lt1cm += 1;
    else if (record.radius < 3) stability.oneTo3cm += 1;
    else stability.gte3cmFinite += 1;
    if (record.atBoundary) stability.atBoundary += 1;

    if (record.roundedHalfLabel !== record.baseLabel) rounding.halfCm.changed += 1;
    if (record.roundedOneLabel !== record.baseLabel) rounding.oneCm.changed += 1;
    if (record.roundedInchLabel !== record.baseLabel) rounding.pointOneIn.changed += 1;
    if (record.unitRoundTripLabel !== record.baseLabel) {
      unitRoundTrip.changed += 1;
      if (record.atBoundary) unitRoundTrip.changedAtBoundary += 1;
      else unitRoundTrip.changedNotAtBoundary += 1;
      unitRoundTrip.changedByBaseLabel[record.baseLabel] += 1;
      unitRoundTrip.changedByNearestThreshold[record.nearestThreshold] += 1;
    }

    thresholdGroups[record.nearestThreshold].points += 1;
    if (record.flipAny[1]) thresholdGroups[record.nearestThreshold].flipAny1cm += 1;
    hipsGroups[String(record.hips)].points += 1;
    if (record.flipAny[1]) hipsGroups[String(record.hips)].flipAny1cm += 1;

    const labelStats = byLabel[record.baseLabel];
    labelStats.points += 1;
    if (record.flipAny[1]) labelStats.flipAny1cm += 1;
    for (const field of ["upper", "waist", "hips", "highHips"]) {
      if (record.fieldFlip[1][field]) labelStats.flipByField1cm[PUBLIC_FIELD[field]] += 1;
    }
    if (record.radius === Infinity) labelStats.stability.infinity += 1;
    else if (record.radius < 1) labelStats.stability.lt1cm += 1;
    else if (record.radius < 3) labelStats.stability.oneTo3cm += 1;
    else labelStats.stability.gte3cmFinite += 1;
    if (record.atBoundary) labelStats.stability.atBoundary += 1;

    for (const event of record.flipEvents) {
      totalFlipEvents += 1;
      if (event.crossedThresholds.length === 0) eventsWithNoThreshold += 1;
      if (event.crossedThresholds.length > 1) eventsWithMultipleThresholds += 1;
      for (const name of event.crossedThresholds) thresholdCrossings[name] += 1;
      const key = `${record.baseLabel}|${event.target}`;
      transition.set(key, (transition.get(key) ?? 0) + 1);
      const crossed = event.crossedThresholds.join("+") || "none";
      const fieldKey = `${record.baseLabel}|${event.target}|${event.field}|${event.direction > 0 ? "+" : "-"}|${crossed}`;
      transitionByField.set(fieldKey, (transitionByField.get(fieldKey) ?? 0) + 1);
    }
  }

  const rateFor = (value, denominator = total) => makeRate(value, denominator);
  const byBaseLabel = Object.fromEntries(
    BODY_TYPE_IDS.map((label) => {
      const stats = byLabel[label];
      return [
        label,
        {
          points: stats.points,
          sharePercent: percent(stats.points, total),
          flipAny1cm: rateFor(stats.flipAny1cm, stats.points),
          flipByField1cm: Object.fromEntries(
            Object.entries(stats.flipByField1cm).map(([field, value]) => [
              field,
              rateFor(value, stats.points),
            ]),
          ),
          stability: {
            ...stats.stability,
            sharePercent: {
              lt1cm: percent(stats.stability.lt1cm, stats.points),
              oneTo3cm: percent(stats.stability.oneTo3cm, stats.points),
              gte3cmFinite: percent(stats.stability.gte3cmFinite, stats.points),
              infinity: percent(stats.stability.infinity, stats.points),
              atBoundary: percent(stats.stability.atBoundary, stats.points),
            },
          },
        },
      ];
    }),
  );

  return {
    total,
    counts: {
      total,
      byBaseLabel: Object.fromEntries(
        BODY_TYPE_IDS.map((label) => [
          label,
          {
            count: countByLabel[label],
            sharePercent: percent(countByLabel[label], total),
          },
        ]),
      ),
      byHipsCm: Object.fromEntries(
        HIPS.map((hips) => [
          String(hips),
          {
            count: countByHips[String(hips)],
            sharePercent: percent(countByHips[String(hips)], total),
          },
        ]),
      ),
    },
    flipRates: {
      any_0_5cm: rateFor(flipAny["0.5"]),
      any_1cm: rateFor(flipAny[1]),
      any_2cm: rateFor(flipAny[2]),
      byField_1cm: Object.fromEntries(
        Object.entries(flipField[1]).map(([field, value]) => [field, rateFor(value)]),
      ),
      byField_0_5cm: Object.fromEntries(
        Object.entries(flipField["0.5"]).map(([field, value]) => [field, rateFor(value)]),
      ),
      byField_2cm: Object.fromEntries(
        Object.entries(flipField[2]).map(([field, value]) => [field, rateFor(value)]),
      ),
      byDirection_1cm: {
        plus: rateFor(flipDirection[1].plus),
        minus: rateFor(flipDirection[1].minus),
      },
      skippedOutOfRangePerturbations: records.filter((record) => record.skippedOutOfRange).length,
    },
    stability: {
      ...stability,
      sharePercent: {
        lt1cm: percent(stability.lt1cm, total),
        oneTo3cm: percent(stability.oneTo3cm, total),
        gte3cmFinite: percent(stability.gte3cmFinite, total),
        infinity: percent(stability.infinity, total),
        atBoundary: percent(stability.atBoundary, total),
      },
      note:
        "边界点（半径 0）计入 <1 cm，同时单独列出；Infinity 不并入有限半径分档。",
    },
    rounding: Object.fromEntries(
      Object.entries(rounding).map(([key, value]) => [
        key,
        {
          ...value,
          rate: percent(value.changed, value.denominator),
        },
      ]),
    ),
    unitRoundTrip: {
      ...unitRoundTrip,
      rate: percent(unitRoundTrip.changed, unitRoundTrip.denominator),
      changedAtBoundarySharePercent: percent(
        unitRoundTrip.changedAtBoundary,
        unitRoundTrip.changed,
      ),
      changedNotAtBoundarySharePercent: percent(
        unitRoundTrip.changedNotAtBoundary,
        unitRoundTrip.changed,
      ),
      note:
        "仅做 cm→in→cm 精确换算的 sanity check，不引入中间舍入；边界点指稳定半径 0 的点。",
    },
    byBaseLabel,
    thresholdGroups: Object.fromEntries(
      Object.entries(thresholdGroups).map(([name, stats]) => [
        name,
        {
          points: stats.points,
          sharePercent: percent(stats.points, total),
          flipAny1cm: rateFor(stats.flipAny1cm, stats.points),
        },
      ]),
    ),
    hipsGroups: Object.fromEntries(
      Object.entries(hipsGroups).map(([hips, stats]) => [
        hips,
        {
          points: stats.points,
          flipAny1cm: rateFor(stats.flipAny1cm, stats.points),
        },
      ]),
    ),
    transitionMatrix: Object.fromEntries(transition),
    transitionByField: Object.fromEntries(transitionByField),
    thresholdCrossings: {
      totalFlipEvents,
      eventsWithMultipleThresholds,
      eventsWithNoThreshold,
      byThreshold: Object.fromEntries(
        Object.entries(thresholdCrossings).map(([name, events]) => [
          name,
          {
            events,
            shareOfFlipEvents: percent(events, totalFlipEvents),
          },
        ]),
      ),
    },
  };
}

/** 生成逐点 CSV 行，所有数值在写盘时格式化，不改变计算精度。 */
function toCsvRows(records) {
  return records.map((record) => ({
    id: record.id,
    hips_cm: formatNumber(record.hips),
    bust_cm: formatNumber(record.upper),
    waist_cm: formatNumber(record.waist),
    high_hips_cm: formatNumber(record.highHips),
    bust_to_hip: formatNumber(record.bustToHip),
    waist_to_hip: formatNumber(record.waistToHip),
    high_hip_to_hip: formatNumber(record.highHipToHip),
    base_label: record.baseLabel,
    stability_radius_cm: formatNumber(record.radius),
    neighbor_labels: record.neighbors.join("|"),
    proximity_tier: record.proximityTier,
    nearest_threshold: record.nearestThreshold,
    nearest_threshold_distance: formatNumber(record.nearestThresholdDistance),
    flip_any_0_5cm: record.flipAny["0.5"],
    flip_any_1cm: record.flipAny[1],
    flip_any_2cm: record.flipAny[2],
    flip_fields_1cm: record.flipEvents
      .map((event) => `${event.field}:${event.direction > 0 ? "+" : "-"}1`)
      .join("|"),
    flip_labels_1cm: [...new Set(record.flipEvents.map((event) => event.target))]
      .sort((a, b) => rulesOrder(a) - rulesOrder(b))
      .join("|"),
    round_0_5_label: record.roundedHalfLabel,
    round_1cm_label: record.roundedOneLabel,
    round_0_1in_label: record.roundedInchLabel,
    unit_round_trip_label: record.unitRoundTripLabel,
    unit_round_trip_changed: record.unitRoundTripLabel !== record.baseLabel,
    at_boundary: record.atBoundary,
    skipped_out_of_range: record.skippedOutOfRange,
  }));
}

/** 体型标识的固定排序，用于标签列表去重后的稳定顺序。 */
function rulesOrder(label) {
  return bodyTypeOrder.indexOf(label);
}

/** 生成标签转移矩阵 CSV：按基点标签与偏移后标签汇总 ±1 cm 翻转事件。 */
function transitionRows(summary) {
  return Object.entries(summary.transitionMatrix)
    .map(([key, events]) => {
      const [baseLabel, targetLabel] = key.split("|");
      return {
        base_label: baseLabel,
        target_label: targetLabel,
        flip_events: events,
        share_of_base_points: formatNumber(
          percent(events, summary.counts.byBaseLabel[baseLabel].count) ?? 0,
        ),
      };
    })
    .sort(
      (a, b) =>
        rulesOrder(a.base_label) - rulesOrder(b.base_label) ||
        rulesOrder(a.target_label) - rulesOrder(b.target_label),
    );
}

/** 生成按字段与方向拆分的转移矩阵 CSV。 */
function transitionByFieldRows(summary) {
  return Object.entries(summary.transitionByField)
    .map(([key, events]) => {
      const [baseLabel, targetLabel, field, direction, crossed] = key.split("|");
      return {
        base_label: baseLabel,
        target_label: targetLabel,
        field,
        direction,
        crossed_thresholds: crossed === "none" ? "" : crossed.replaceAll("+", "|"),
        flip_events: events,
      };
    })
    .sort(
      (a, b) =>
        rulesOrder(a.base_label) - rulesOrder(b.base_label) ||
        rulesOrder(a.target_label) - rulesOrder(b.target_label) ||
        a.field.localeCompare(b.field) ||
        a.direction.localeCompare(b.direction) ||
        a.crossed_thresholds.localeCompare(b.crossed_thresholds),
    );
}

/** 生成按阈值汇总的跨越事件数据，直接回答“哪个阈值最容易被跨过”。 */
function thresholdCrossingsRows(summary) {
  return Object.entries(summary.thresholdCrossings.byThreshold).map(([name, stats]) => ({
    threshold: name,
    flip_events: stats.events,
    share_of_flip_events_percent: formatNumber(stats.shareOfFlipEvents ?? 0),
  }));
}

/** 生成稳定半径累积分布数据，供后续图表直接读取。 */
function stabilityCdfRows(records) {
  const finiteRadii = records
    .map((record) => record.radius)
    .filter((radius) => Number.isFinite(radius))
    .sort((a, b) => a - b);
  const total = records.length;
  const rows = [];
  let index = 0;
  while (index < finiteRadii.length) {
    const radius = finiteRadii[index];
    let next = index;
    while (next < finiteRadii.length && finiteRadii[next] === radius) next += 1;
    rows.push({
      radius_cm: formatNumber(radius),
      points_at_or_below: next,
      share_percent: formatNumber(percent(next, total) ?? 0),
    });
    index = next;
  }
  return rows;
}

/** 生成按臀围档位的 ±1 cm 翻转率数据，供后续图表直接读取。 */
function flipByHipsRows(summary) {
  return HIPS.map((hips) => {
    const stats = summary.hipsGroups[String(hips)];
    return {
      hips_cm: hips,
      points: stats.points,
      flip_any_1cm: stats.flipAny1cm.numerator,
      rate_percent: formatNumber(stats.flipAny1cm.rate ?? 0),
    };
  });
}

/** 生成按最近阈值分组的翻转率数据。 */
function thresholdGroupRows(summary) {
  return Object.entries(summary.thresholdGroups).map(([name, stats]) => ({
    nearest_threshold: name,
    points: stats.points,
    share_percent: formatNumber(stats.sharePercent ?? 0),
    flip_any_1cm: stats.flipAny1cm.numerator,
    rate_percent: formatNumber(stats.flipAny1cm.rate ?? 0),
  }));
}

/** 生成方法快照，记录运行参数、检查结果与输出清单。 */
function buildMethod(context) {
  const {
    commit,
    workingTreeDirty,
    ruleFilesDirty,
    nodeVersion,
    algorithmVersion,
    expectedTotal,
    summary,
    checks,
    outputHashes,
  } = context;
  const lines = [
    "# 边界敏感性分析：方法快照",
    "",
    `- 运行日期：${RUN_DATE}`,
    `- 算法版本：v${algorithmVersion}`,
    `- Git 提交：${commit || "未知"}`,
    `- 工作区是否有未提交改动：${workingTreeDirty ? "是" : "否"}`,
    `- 规则相关文件是否有未提交改动：${ruleFilesDirty ? "是" : "否"}`,
    `- Node.js：${nodeVersion}`,
    "",
    "## 一、规则来源",
    "",
    "- 只调用 `lib/body-type/ratios.ts` 的 `classifyId`、`computeRatios`，`lib/body-type/stability.ts` 的 `findNearestShift`，以及 `lib/body-type/thresholds.ts`、`lib/body-type/types.ts`、`lib/body-type/units.ts` 中的常量。",
    "- 没有复制判定逻辑，也没有为分析另设阈值。",
    "",
    "## 二、网格参数",
    "",
    `- 臀围：${HIPS.join("、")} cm，共 ${HIPS.length} 档。`,
    `- 胸臀比：${BUST_BP.min / 1000} 到 ${BUST_BP.max / 1000}，步长 ${BUST_BP.step / 1000}。`,
    `- 腰臀比：${WAIST_BP.min / 1000} 到 ${WAIST_BP.max / 1000}，步长 ${WAIST_BP.step / 1000}。`,
    `- 上臀臀比：${HIGH_HIP_BP.min / 1000} 到 ${HIGH_HIP_BP.max / 1000}，步长 ${HIGH_HIP_BP.step / 1000}。`,
    "- 有序约束：腰臀比 < 上臀臀比 < 1，即腰围 < 上臀围 < 臀围。",
    `- 期望测试点数：${expectedTotal}；实际记录数：${summary.total}。`,
    "- 比例由千分位整数生成，避免浮点步进误差；厘米值不预先四舍五入。",
    "- 补充集：另生成 highHips ≥ hips 或 highHips ≤ waist 的警告情形，单独输出 `warning-cases.csv`，不并入主网格分母。",
    "",
    "## 三、扰动与舍入",
    "",
    "- 单字段扰动：胸围、腰围、上臀围、臀围分别 ±0.5、±1、±2 cm，每次只改一个字段。",
    "- 偏移后越出 40–200 cm 的组合跳过，并记录 `skipped_out_of_range`。",
    "- 翻转定义：偏移后的 `classifyId` 与基点不同。",
    "- 舍入：0.5 cm、1 cm 按半格向上；0.1 in 先按 1 in = 2.54 cm 转英寸，四舍五入到 0.1 in，再换回厘米。",
    "- 单位一致性：厘米精确转英寸再转回厘米，只作 sanity check，不引入中间舍入。",
    "",
    "## 四、稳定半径与分母",
    "",
    "- 稳定半径由项目 `findNearestShift` 二分求得，量化到 0.01 cm；0 表示输入在边界上，Infinity 表示 60 cm 搜索上限内不可达其他分类。",
    "- 所有比例的分母是参与该指标计算的测试点数，不是人群数量。",
    "- 转移矩阵按 ±1 cm 的单字段、单方向翻转事件计数；同一点翻到同一标签的多个事件会分别计数。",
    "",
    "## 五、检查结果",
    "",
    `- 主键唯一：${checks.uniqueIds ? "通过" : "失败"}`,
    `- 全部基础测量值在 40–200 cm：${checks.allValuesInRange ? "通过" : "失败"}`,
    `- 网格数量与独立计数一致：${checks.gridCountMatches ? "通过" : "失败"}`,
    `- 稳定半径分档与半径一致：${checks.tierMatchesRadius ? "通过" : "失败"}`,
    `- 可达分类均在已定义集合内：${checks.neighborsValid ? "通过" : "失败"}`,
    `- 基点分类可重复：${checks.deterministic ? "通过" : "失败"}`,
    `- 标签顺序与项目定义一致：${checks.labelOrderMatches ? "通过" : "失败"}`,
    `- 精确 cm→in→cm 标签改变数：${checks.unitRoundTripChanges} / ${checks.total}；其中边界点 ${checks.unitRoundTripChangesAtBoundary}，非边界点 ${checks.unitRoundTripChangesNotAtBoundary}`,
    `- 转移矩阵事件总数：${checks.transitionEvents}；±1 cm 翻转事件明细总数：${checks.flipEvents}；一致：${checks.transitionEventsMatch ? "是" : "否"}`,
    `- 每个 ±1 cm 翻转事件都跨过至少一个阈值：${checks.allFlipEventsCrossThreshold ? "通过" : "失败"}`,
    `- 同时跨过多个阈值的翻转事件：${checks.eventsWithMultipleThresholds}`,
    `- 未跨过任何阈值的翻转事件：${checks.eventsWithNoThreshold}`,
    `- 输入一致性补充集：${checks.warningCasesTotal} 个点；产生提示 ${checks.warningCasesWithWarnings} 个，未产生提示 ${checks.warningCasesWithoutWarnings} 个（其中 highHips = hips 的等号点 ${checks.warningCasesEqualityWithoutWarning} 个）；标签均在已定义集合内：${checks.warningCasesAllLabelsValid ? "通过" : "失败"}`,
    "",
    "## 六、输出文件",
    "",
    ...Object.keys(outputHashes).map((file) => `- \`${file}\`：SHA-256 \`${outputHashes[file]}\``),
    "",
    "## 七、复现",
    "",
    "```bash",
    "pnpm analysis:boundary",
    "```",
    "",
    "脚本只读取项目内规则函数；不同提交或不同 Node 版本可能产生不同的结果文件。全量 CSV 留在本地 `data/boundary-sensitivity/v2/`，不提交到站点仓库。",
    "",
  ];
  return `${lines.join("\n")}\n`;
}

/** 主流程：加载规则、扫描网格、写文件并打印中文摘要。 */
async function main() {
  const rules = await loadRules();
  bodyTypeOrder = [...rules.BODY_TYPE_IDS];
  try {
    console.log("开始扫描 Bodytype v2 边界敏感性网格……");
    const { records, expectedTotal, allValuesInRange } = scanGrid(rules);
    const summary = summarize(records, rules);
    const warningScan = scanWarningCases(rules);
    const warningCsv = toCsv(
      [
        "id",
        "hips_cm",
        "bust_cm",
        "waist_cm",
        "high_hips_cm",
        "base_label",
        "high_hip_above_hips",
        "high_hip_at_hips",
        "high_hip_at_or_below_waist",
        "warnings",
      ],
      warningCaseRows(warningScan.cases),
    );
    const csvRows = toCsvRows(records);
    const sample = sampleRows(records, 12);
    const sampleCsv = toCsv(CSV_COLUMNS, toCsvRows(sample));
    const gridCsv = toCsv(CSV_COLUMNS, csvRows);
    const transitionCsv = toCsv(
      ["base_label", "target_label", "flip_events", "share_of_base_points"],
      transitionRows(summary),
    );
    const transitionFieldCsv = toCsv(
      [
        "base_label",
        "target_label",
        "field",
        "direction",
        "crossed_thresholds",
        "flip_events",
      ],
      transitionByFieldRows(summary),
    );
    const thresholdCrossingsCsv = toCsv(
      ["threshold", "flip_events", "share_of_flip_events_percent"],
      thresholdCrossingsRows(summary),
    );
    const cdfCsv = toCsv(
      ["radius_cm", "points_at_or_below", "share_percent"],
      stabilityCdfRows(records),
    );
    const hipsCsv = toCsv(
      ["hips_cm", "points", "flip_any_1cm", "rate_percent"],
      flipByHipsRows(summary),
    );
    const thresholdCsv = toCsv(
      ["nearest_threshold", "points", "share_percent", "flip_any_1cm", "rate_percent"],
      thresholdGroupRows(summary),
    );

    const commit = git(["rev-parse", "HEAD"]);
    const ruleFilesDirty =
      git([
        "status",
        "--porcelain",
        "--",
        "lib/body-type/rules.ts",
        "lib/body-type/ratios.ts",
        "lib/body-type/stability.ts",
        "lib/body-type/thresholds.ts",
        "lib/body-type/types.ts",
        "lib/body-type/units.ts",
      ]).length > 0;
    const workingTreeDirty = git(["status", "--porcelain"]).length > 0;

    const checks = {
      uniqueIds: new Set(records.map((record) => record.id)).size === records.length,
      allValuesInRange,
      gridCountMatches: records.length === expectedTotal,
      tierMatchesRadius: records.every(
        (record) =>
          record.proximityTier ===
          (record.radius < 1 ? "very-close" : record.radius < 3 ? "close" : "hidden"),
      ),
      neighborsValid: records.every((record) => record.allNeighborsValid),
      deterministic: records.every(
        (record) =>
          rules.classifyId({
            upper: record.upper,
            waist: record.waist,
            hips: record.hips,
            highHips: record.highHips,
          }) === record.baseLabel,
      ),
      unitRoundTripChanges: summary.unitRoundTrip.changed,
      unitRoundTripChangesAtBoundary: summary.unitRoundTrip.changedAtBoundary,
      unitRoundTripChangesNotAtBoundary: summary.unitRoundTrip.changedNotAtBoundary,
      total: records.length,
      transitionEvents: Object.values(summary.transitionMatrix).reduce(
        (sum, value) => sum + value,
        0,
      ),
      flipEvents: records.reduce((sum, record) => sum + record.flipEvents.length, 0),
    };
    checks.transitionEventsMatch = checks.transitionEvents === checks.flipEvents;
    checks.labelOrderMatches =
      bodyTypeOrder.join("|") === rules.BODY_TYPE_IDS.join("|");
    checks.allFlipEventsCrossThreshold =
      summary.thresholdCrossings.eventsWithNoThreshold === 0;
    checks.eventsWithMultipleThresholds =
      summary.thresholdCrossings.eventsWithMultipleThresholds;
    checks.eventsWithNoThreshold = summary.thresholdCrossings.eventsWithNoThreshold;
    checks.warningCasesAllLabelsValid = warningScan.summary.allLabelsValid;
    checks.warningCasesTotal = warningScan.summary.total;
    checks.warningCasesWithWarnings = warningScan.summary.withWarnings;
    checks.warningCasesWithoutWarnings = warningScan.summary.withoutWarnings;
    checks.warningCasesEqualityWithoutWarning = warningScan.summary.equalityWithoutWarning;

    const summaryJson = {
      algorithmVersion: rules.ALGORITHM_VERSION,
      generatedAt: RUN_DATE,
      commit,
      workingTreeDirty,
      ruleFilesDirty,
      nodeVersion: process.version,
      grid: {
        hipsCm: HIPS,
        bustToHip: {
          min: BUST_BP.min / 1000,
          max: BUST_BP.max / 1000,
          step: BUST_BP.step / 1000,
        },
        waistToHip: {
          min: WAIST_BP.min / 1000,
          max: WAIST_BP.max / 1000,
          step: WAIST_BP.step / 1000,
        },
        highHipToHip: {
          min: HIGH_HIP_BP.min / 1000,
          max: HIGH_HIP_BP.max / 1000,
          step: HIGH_HIP_BP.step / 1000,
        },
        constraint: "waist < high hip < hips",
        expectedTotal,
      },
      counts: summary.counts,
      flipRates: summary.flipRates,
      stability: summary.stability,
      rounding: summary.rounding,
      unitRoundTrip: summary.unitRoundTrip,
      byBaseLabel: summary.byBaseLabel,
      thresholdGroups: summary.thresholdGroups,
      hipsGroups: summary.hipsGroups,
      transitionMatrix: summary.transitionMatrix,
      transitionByField: summary.transitionByField,
      thresholdCrossings: summary.thresholdCrossings,
      warningCases: warningScan.summary,
      checks,
      outputs: {
        fullGrid: "grid.csv",
        sample: "grid-sample.csv",
        summary: "summary.json",
        transitionMatrix: "transition-matrix.csv",
        transitionMatrixByField: "transition-matrix-by-field.csv",
        thresholdCrossings: "threshold-crossings.csv",
        stabilityCdf: "figure-1-stability-cdf.csv",
        flipByHips: "figure-2-flip-by-hips.csv",
        thresholdGroups: "threshold-groups.csv",
        warningCases: "warning-cases.csv",
        method: "METHOD.md",
        note: "全量 parquet 待发布阶段由 grid.csv 转换；本次只生成本地全量 CSV。",
      },
    };
    const summaryText = `${JSON.stringify(summaryJson, null, 2)}\n`;

    await mkdir(OUTPUT_DIR, { recursive: true });
    await mkdir(PUBLIC_DIR, { recursive: true });
    const files = {
      "grid.csv": gridCsv,
      "grid-sample.csv": sampleCsv,
      "summary.json": summaryText,
      "transition-matrix.csv": transitionCsv,
      "transition-matrix-by-field.csv": transitionFieldCsv,
      "threshold-crossings.csv": thresholdCrossingsCsv,
      "figure-1-stability-cdf.csv": cdfCsv,
      "figure-2-flip-by-hips.csv": hipsCsv,
      "threshold-groups.csv": thresholdCsv,
      "warning-cases.csv": warningCsv,
    };
    const outputHashes = Object.fromEntries(
      Object.entries(files).map(([name, content]) => [name, sha256(content)]),
    );
    const methodText = buildMethod({
      commit,
      workingTreeDirty,
      ruleFilesDirty,
      nodeVersion: process.version,
      algorithmVersion: rules.ALGORITHM_VERSION,
      expectedTotal,
      summary,
      checks,
      outputHashes,
    });
    files["METHOD.md"] = methodText;
    outputHashes["METHOD.md"] = sha256(methodText);
    const sumsText = Object.entries(outputHashes)
      .map(([name, hash]) => `${hash}  ${name}`)
      .join("\n");
    files["SHA256SUMS"] = `${sumsText}\n`;

    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(OUTPUT_DIR, name), content, "utf8");
    }
    // 站内只公开样例、汇总与关键表，全量 grid.csv 不进入站点仓库。
    for (const name of [
      "grid-sample.csv",
      "summary.json",
      "transition-matrix.csv",
      "threshold-crossings.csv",
      "figure-1-stability-cdf.csv",
      "figure-2-flip-by-hips.csv",
      "threshold-groups.csv",
      "warning-cases.csv",
    ]) {
      await writeFile(path.join(PUBLIC_DIR, name), files[name], "utf8");
    }

    console.log(`完成：${records.length} 个测试点。`);
    console.log(`全量输出：${path.relative(ROOT, OUTPUT_DIR)}`);
    console.log(`站内公开：${path.relative(ROOT, PUBLIC_DIR)}`);
    console.log(
      `±1 cm 任一字段翻转：${summary.flipRates.any_1cm.numerator}/${summary.flipRates.any_1cm.denominator}（${summary.flipRates.any_1cm.rate}%）`,
    );
    console.log(
      `稳定半径 <1 cm：${summary.stability.lt1cm}/${summary.total}（${summary.stability.sharePercent.lt1cm}%）；1–3 cm：${summary.stability.oneTo3cm}；≥3 cm：${summary.stability.gte3cmFinite}；Infinity：${summary.stability.infinity}`,
    );
    console.log(
      `舍入标签改变：0.5 cm ${summary.rounding.halfCm.changed}；1 cm ${summary.rounding.oneCm.changed}；0.1 in ${summary.rounding.pointOneIn.changed}`,
    );
    console.log(`检查：${checks.uniqueIds && checks.gridCountMatches && checks.deterministic ? "通过" : "存在失败项"}。`);
  } finally {
    await rules.server.close();
  }
}

main().catch((error) => {
  console.error("边界敏感性分析失败：", error);
  process.exitCode = 1;
});
