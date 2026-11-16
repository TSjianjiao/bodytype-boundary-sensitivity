/**
 * 分类阈值与展示分档的唯一来源。
 * 算法、页面规则表、内容文案与测试都必须引用这里的常量，不得各自写死数字。
 */

/**
 * 算法版本号，改变阈值、判定顺序或测量口径时必须提升。
 * v2 将四项测量口径对齐 ASTM D5219-25 的 3.3–3.5，阈值本身未改。
 */
export const ALGORITHM_VERSION = "2";

/** 胸围与臀围相差不超过该比例视为均衡。 */
export const BUST_BALANCE = 0.05;

/** 腰臀比不大于该值视为腰线明确。 */
export const WAIST_DEFINED = 0.8;

/** 腰臀比不小于该值视为腰线不明显。 */
export const WAIST_UNDEFINED = 0.88;

/** 上臀围不大于臀围的该比例视为髋部下方仍有明显外扩。 */
export const HIGH_HIP_CURVE = 0.95;

/** 稳定半径小于该值（厘米）时，结果卡使用“非常接近”措辞。 */
export const VERY_CLOSE_CM = 1;

/** 稳定半径不小于该值（厘米）时，结果卡不展示可达分类一行。 */
export const HIDE_PROXIMITY_CM = 3;

/** 稳定半径搜索的偏移上限（厘米），超过即视为各分类之间不可达。 */
export const MAX_STABILITY_CM = 60;

/** 稳定半径量化精度（厘米），小于一半精度视为 0，表示输入本身在边界上。 */
export const RADIUS_PRECISION_CM = 0.01;
