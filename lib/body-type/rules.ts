import {
  BUST_BALANCE,
  HIGH_HIP_CURVE,
  WAIST_DEFINED,
  WAIST_UNDEFINED,
} from "./thresholds";
import type { BodyTypeId } from "./types";

/** 胸围与臀围的均衡判定方式。 */
export type BalanceTest =
  /** 比例高于上限，胸围相对臀围更大。 */
  | "above"
  /** 比例低于下限，胸围相对臀围更小。 */
  | "below"
  /** 比例落在上下限之间，视为胸臀均衡。 */
  | "within"
  /** 不检查胸臀均衡，作为兜底规则。 */
  | "any";

/** 单条分类规则的结构化定义，是算法、页面表格与文案的唯一来源。 */
export interface ClassificationRule {
  /** 命中的体型标识。 */
  id: BodyTypeId;
  /** 胸臀关系判定方式。 */
  balance: BalanceTest;
  /** 腰臀比下界，含等号；null 表示不约束。 */
  waistMin: number | null;
  /** 腰臀比上界，含等号；null 表示不约束。 */
  waistMax: number | null;
  /** 上臀臀比上界，含等号；null 表示不约束。 */
  highHipMax: number | null;
}

/**
 * 五条分类规则，数组顺序即判定优先级，命中即停止。
 * 最后一条为兜底规则，必然命中，因此分类结果唯一且完备。
 */
export const CLASSIFICATION_RULES: readonly ClassificationRule[] = [
  {
    id: "inverted-triangle",
    balance: "above",
    waistMin: null,
    waistMax: null,
    highHipMax: null,
  },
  {
    id: "pear",
    balance: "below",
    waistMin: null,
    waistMax: null,
    highHipMax: null,
  },
  {
    id: "apple",
    balance: "within",
    waistMin: WAIST_UNDEFINED,
    waistMax: null,
    highHipMax: null,
  },
  {
    id: "hourglass",
    balance: "within",
    waistMin: null,
    waistMax: WAIST_DEFINED,
    highHipMax: HIGH_HIP_CURVE,
  },
  {
    id: "rectangle",
    balance: "any",
    waistMin: null,
    waistMax: null,
    highHipMax: null,
  },
];

/** 判断给定比例是否命中单条规则；比较方向与等号归属由规则字段决定。 */
export function matchesRule(
  rule: ClassificationRule,
  bustToHip: number,
  waistToHip: number,
  highHipToHip: number,
): boolean {
  if (rule.balance === "above" && !(bustToHip > 1 + BUST_BALANCE)) return false;
  if (rule.balance === "below" && !(bustToHip < 1 - BUST_BALANCE)) return false;
  if (
    rule.balance === "within" &&
    !(bustToHip >= 1 - BUST_BALANCE && bustToHip <= 1 + BUST_BALANCE)
  ) {
    return false;
  }
  if (rule.waistMin !== null && !(waistToHip >= rule.waistMin)) return false;
  if (rule.waistMax !== null && !(waistToHip <= rule.waistMax)) return false;
  if (rule.highHipMax !== null && !(highHipToHip <= rule.highHipMax)) return false;
  return true;
}

/** 按规则表顺序返回首个命中的体型标识。 */
export function matchBodyType(
  bustToHip: number,
  waistToHip: number,
  highHipToHip: number,
): BodyTypeId {
  for (const rule of CLASSIFICATION_RULES) {
    if (matchesRule(rule, bustToHip, waistToHip, highHipToHip)) return rule.id;
  }
  // 规则表最后一条是 any 兜底规则，理论上不可达。
  return "rectangle";
}
