// 将边界敏感性全量 CSV 转为 Hugging Face 发布用 parquet，并写入校验值。
// CSV 由 scripts/analysis/boundary-sensitivity.mjs 生成；本脚本只做格式转换，不改动任何数值。
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** 项目根目录；脚本固定从项目根目录运行。 */
const ROOT = process.cwd();

/** 本地全量数据目录，与 02 工作稿的记录日期一致。 */
const RUN_DIR = path.join(ROOT, "data", "boundary-sensitivity", "v2", "2026-11-16");

/** 输入 CSV 与输出 parquet 的固定路径。 */
const INPUT_CSV = path.join(RUN_DIR, "grid.csv");
const OUTPUT_PARQUET = path.join(RUN_DIR, "grid.parquet");
const OUTPUT_HASH = path.join(RUN_DIR, "SHA256SUMS.parquet");

/**
 * 字段定义：按 CSV 列顺序声明 parquet 类型。
 * stability_radius_cm 用字符串保留 Infinity 的原始写法，避免不同读取器对浮点特殊值的处理差异。
 */
const COLUMNS = [
  { name: "id", type: "STRING" },
  { name: "hips_cm", type: "INT32" },
  { name: "bust_cm", type: "DOUBLE" },
  { name: "waist_cm", type: "DOUBLE" },
  { name: "high_hips_cm", type: "DOUBLE" },
  { name: "bust_to_hip", type: "DOUBLE" },
  { name: "waist_to_hip", type: "DOUBLE" },
  { name: "high_hip_to_hip", type: "DOUBLE" },
  { name: "base_label", type: "STRING" },
  { name: "stability_radius_cm", type: "STRING" },
  { name: "neighbor_labels", type: "STRING" },
  { name: "proximity_tier", type: "STRING" },
  { name: "nearest_threshold", type: "STRING" },
  { name: "nearest_threshold_distance", type: "DOUBLE" },
  { name: "flip_any_0_5cm", type: "BOOLEAN" },
  { name: "flip_any_1cm", type: "BOOLEAN" },
  { name: "flip_any_2cm", type: "BOOLEAN" },
  { name: "flip_fields_1cm", type: "STRING" },
  { name: "flip_labels_1cm", type: "STRING" },
  { name: "round_0_5_label", type: "STRING" },
  { name: "round_1cm_label", type: "STRING" },
  { name: "round_0_1in_label", type: "STRING" },
  { name: "unit_round_trip_label", type: "STRING" },
  { name: "unit_round_trip_changed", type: "BOOLEAN" },
  { name: "at_boundary", type: "BOOLEAN" },
  { name: "skipped_out_of_range", type: "BOOLEAN" },
];

/** 数值字段集合，用于批量转换为 number。 */
const NUMERIC_COLUMNS = new Set([
  "hips_cm",
  "bust_cm",
  "waist_cm",
  "high_hips_cm",
  "bust_to_hip",
  "waist_to_hip",
  "high_hip_to_hip",
  "nearest_threshold_distance",
]);

/** 布尔字段集合，用于把 true/false 文本转为布尔值。 */
const BOOLEAN_COLUMNS = new Set([
  "flip_any_0_5cm",
  "flip_any_1cm",
  "flip_any_2cm",
  "unit_round_trip_changed",
  "at_boundary",
  "skipped_out_of_range",
]);

/** 计算文件 SHA-256，返回小写十六进制字符串。 */
function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** 按字段类型转换 CSV 文本；空字符串在布尔与数值列中按 null 处理。 */
function convertValue(column, raw) {
  if (BOOLEAN_COLUMNS.has(column)) {
    return raw === "" ? null : raw === "true";
  }
  if (NUMERIC_COLUMNS.has(column)) {
    return raw === "" ? null : Number(raw);
  }
  return raw;
}

/** 主流程：读取 CSV、按列构建数组、写出 parquet 与 SHA-256。 */
async function main() {
  const csvBuffer = await readFile(INPUT_CSV);
  const text = csvBuffer.toString("utf8");
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();

  const header = lines[0].split(",");
  const expectedHeader = COLUMNS.map((column) => column.name);
  if (header.join(",") !== expectedHeader.join(",")) {
    throw new Error(`CSV 表头与数据字典不一致：${header.join(",")}`);
  }

  const data = Object.fromEntries(COLUMNS.map((column) => [column.name, []]));
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const values = lines[lineIndex].split(",");
    if (values.length !== COLUMNS.length) {
      throw new Error(`第 ${lineIndex + 1} 行列数为 ${values.length}，应为 ${COLUMNS.length}`);
    }
    for (let columnIndex = 0; columnIndex < COLUMNS.length; columnIndex += 1) {
      const column = COLUMNS[columnIndex].name;
      data[column].push(convertValue(column, values[columnIndex]));
    }
  }

  const { parquetWriteFile } = await import("hyparquet-writer");
  parquetWriteFile({
    filename: OUTPUT_PARQUET,
    columnData: COLUMNS.map((column) => ({
      name: column.name,
      type: column.type,
      data: data[column.name],
    })),
    // 元数据随 parquet 一起分发，保证数据文件脱离网页也能说明来源与许可。
    kvMetadata: [
      { key: "title", value: "Bodytype boundary sensitivity v2 synthetic rule-space grid" },
      {
        key: "description",
        value:
          "Deterministic synthetic scan of the Bodytype v2 four-girth classification rules. Not a population sample, not an accuracy study and not medical data.",
      },
      { key: "license", value: "CC BY 4.0" },
      { key: "attribution", value: "Bodytype.org - https://bodytype.org" },
      {
        key: "source",
        value: "https://bodytype.org/research/boundary-sensitivity-body-type-calculator",
      },
      { key: "algorithm_version", value: "2" },
      { key: "row_count", value: String(lines.length - 1) },
    ],
    createdBy: "bodytype boundary-sensitivity converter",
  });

  const parquetBuffer = await readFile(OUTPUT_PARQUET);
  const hash = sha256(parquetBuffer);
  await writeFile(OUTPUT_HASH, `${hash}  grid.parquet\n`, "utf8");

  console.log(
    JSON.stringify(
      {
        input: INPUT_CSV,
        output: OUTPUT_PARQUET,
        rows: lines.length - 1,
        csvBytes: csvBuffer.length,
        parquetBytes: parquetBuffer.length,
        sha256: hash,
      },
      null,
      2,
    ),
  );
}

await main();
