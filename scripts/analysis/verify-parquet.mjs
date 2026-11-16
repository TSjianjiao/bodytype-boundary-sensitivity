// 校验全量 parquet 与源 CSV 的行数、列顺序和首尾行一致。
// 只读校验，不修改数据；用于发布前确认 parquet 没有在转换中丢失或错列。
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  asyncBufferFromFile,
  parquetMetadataAsync,
  parquetReadObjects,
  parquetSchema,
} from "hyparquet";

/** 项目根目录。 */
const ROOT = process.cwd();

/** 记录运行日期对应的全量数据目录。 */
const RUN_DIR = path.join(ROOT, "data", "boundary-sensitivity", "v2", "2026-11-16");

/** 源 CSV 与待校验 parquet 的固定路径。 */
const CSV_PATH = path.join(RUN_DIR, "grid.csv");
const PARQUET_PATH = path.join(RUN_DIR, "grid.parquet");

/** 数值列集合，按数值而不是文本比较，避免显示格式差异造成误报。 */
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

/** 比较 CSV 文本与 parquet 值；数值列允许浮点表示差异，其余按字符串比较。 */
function valuesMatch(column, csvValue, parquetValue) {
  if (NUMERIC_COLUMNS.has(column)) {
    return Math.abs(Number(csvValue) - Number(parquetValue)) < 1e-9;
  }
  return String(parquetValue) === csvValue;
}

/** 主流程：读取 CSV 首尾行与 parquet 元数据，逐项比较并输出结果。 */
async function main() {
  const csvText = await readFile(CSV_PATH, "utf8");
  const csvLines = csvText.trimEnd().split(/\r?\n/);
  const header = csvLines[0].split(",");
  const firstCsv = Object.fromEntries(
    header.map((column, index) => [column, csvLines[1].split(",")[index]]),
  );
  const lastCsv = Object.fromEntries(
    header.map((column, index) => [
      column,
      csvLines[csvLines.length - 1].split(",")[index],
    ]),
  );

  const file = await asyncBufferFromFile(PARQUET_PATH);
  const metadata = await parquetMetadataAsync(file);
  const schema = parquetSchema(metadata);
  const columns = schema.children.map((child) => child.element.name);
  const totalRows = Number(metadata.num_rows);
  const expectedRows = csvLines.length - 1;
  const firstParquet = (await parquetReadObjects({ file, rowStart: 0, rowEnd: 1 }))[0];
  const lastParquet = (
    await parquetReadObjects({
      file,
      rowStart: totalRows - 1,
      rowEnd: totalRows,
    })
  )[0];

  const checks = [
    {
      name: "row count",
      ok: totalRows === expectedRows,
      detail: `${totalRows} vs ${expectedRows}`,
    },
    {
      name: "column order",
      ok: columns.join(",") === header.join(","),
      detail: columns.join(","),
    },
    {
      name: "first row",
      ok: header.every((column) => valuesMatch(column, firstCsv[column], firstParquet[column])),
      detail: firstParquet.id,
    },
    {
      name: "last row",
      ok: header.every((column) => valuesMatch(column, lastCsv[column], lastParquet[column])),
      detail: lastParquet.id,
    },
  ];

  const ok = checks.every((check) => check.ok);
  console.log(
    JSON.stringify(
      {
        parquet: PARQUET_PATH,
        rows: totalRows,
        columns: columns.length,
        checks,
        ok,
      },
      null,
      2,
    ),
  );
  if (!ok) process.exit(1);
}

await main();
