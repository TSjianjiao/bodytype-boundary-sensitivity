/**
 * 四个围度字段的标识，顺序与页面、分享链接一致。
 * 先输入臀围再输入上臀围，用户才能按“腰与臀的中点”定位上臀围。
 */
export const FIELD_ORDER = ["upper", "waist", "hips", "highHips"] as const;

/** 单个围度字段的标识类型。 */
export type FieldId = (typeof FIELD_ORDER)[number];

/** 支持的计量单位。 */
export type Unit = "cm" | "in";

/** 以厘米表示的四个围度。 */
export type MeasurementsCm = Record<FieldId, number>;

/** 支持的体型分类标识。 */
export type BodyTypeId = "hourglass" | "pear" | "inverted-triangle" | "apple" | "rectangle";

/** 体型分类标识的完整列表，用于校验分享链接。 */
export const BODY_TYPE_IDS: readonly BodyTypeId[] = [
  "hourglass",
  "pear",
  "inverted-triangle",
  "apple",
  "rectangle",
];

/** 表单中单个围度字段的编辑状态。 */
export interface FieldState {
  /** 当前单位下用户看到的原始输入文本。 */
  text: string;
  /** 由输入文本解析出的厘米值，无法解析或超范围时为 null。 */
  cm: number | null;
  /** 各单位下已验证过的原始文本缓存，用于切换单位时保留用户写法。 */
  texts: Partial<Record<Unit, string>>;
}

/** 分类时使用的无量纲比例指标。 */
export interface Ratios {
  /** 胸围与臀围之比。 */
  bustToHip: number;
  /** 腰围与臀围之比。 */
  waistToHip: number;
  /** 上臀围与臀围之比。 */
  highHipToHip: number;
}

/**
 * 稳定半径与在该半径处可达的分类。
 * 半径小于 1 时说明结果贴近分类边界，可供结果卡提示用户复测。
 */
export interface NearestShift {
  /** 量化到 0.01 cm 的最小单字段偏移；输入本身在边界上时为 0，无解时为 Infinity。 */
  radius: number;
  /** 该半径处可达的其他分类，按 BODY_TYPE_IDS 顺序；边界输入可能有多个。 */
  neighbors: BodyTypeId[];
}

/** 一次确定的分类结果。 */
export interface Classification {
  /** 命中的体型标识，恒为规则判定值，不受 nearestShift 影响。 */
  id: BodyTypeId;
  /** 参与判定的比例指标。 */
  ratios: Ratios;
  /** 稳定半径与可达分类，供结果卡与导出图片共用的几何信息。 */
  nearestShift: NearestShift;
}

/** 解析测量输入文本的结果。 */
export type ParseResult =
  | {
      /** 解析成功。 */
      ok: true;
      /** 换算后的厘米值。 */
      cm: number;
    }
  | {
      /** 解析失败。 */
      ok: false;
      /** 失败原因：空值、非数字或超出公开范围。 */
      reason: "empty" | "invalid" | "range";
    };

/** 分享链接解析结果。 */
export interface ShareParseResult {
  /** 版本与单位是否可用于恢复计算。 */
  ok: boolean;
  /** 链接声明的单位，缺省为厘米。 */
  unit: Unit;
  /** 通过白名单与范围校验的原始输入文本。 */
  fields: Partial<Record<FieldId, string>>;
  /** 链接中声明的结果标识，仅用于与重算结果比对。 */
  claimedResult: BodyTypeId | null;
  /** 面向用户的提示文本。 */
  issues: string[];
}

/** 已保存的一次计算结果快照。 */
export interface SavedResult {
  /** 分类结果。 */
  classification: Classification;
  /** 计算时使用的四项厘米值。 */
  measurements: MeasurementsCm;
  /** 计算时页面显示的原始输入文本。 */
  display: Record<FieldId, string>;
  /** 计算时使用的单位。 */
  unit: Unit;
}
