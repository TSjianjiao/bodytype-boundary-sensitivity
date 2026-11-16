# Full grid parquet

- Source CSV: `grid.csv` (669,858 data rows)
- Parquet rows: 669,858
- Columns: 26
- Parquet size: 3,172,344 bytes
- SHA-256: `b8ee9a697797bde6fe5b4da20723f6333f6ae35a7d263e249bde9e906aac0fde`
- Source CSV SHA-256: `5686a25e25bf5e20c90d90ca060e7b8bfbd5e5da128c1724f573c4975003973c`
- Compression: SNAPPY (writer default)
- Converter: `pnpm analysis:parquet` in the site repository
- License: CC BY 4.0
- Required attribution: Bodytype.org, https://bodytype.org

The parquet file is the full synthetic rule-space grid. It is produced by
converting the CSV without changing values. `stability_radius_cm` is stored as
a string so that `Infinity` and `0` keep their exact notation across readers.

The file is not part of the site repository. Upload it as the full-grid asset
of the Hugging Face dataset release. The site snapshot keeps only the sample,
summary, aggregate tables and figures.

Embedded parquet key-value metadata:

| Key | Value |
| --- | --- |
| title | Bodytype boundary sensitivity v2 synthetic rule-space grid |
| description | Deterministic synthetic scan of the Bodytype v2 four-girth classification rules. Not a population sample, not an accuracy study and not medical data. |
| license | CC BY 4.0 |
| attribution | Bodytype.org - https://bodytype.org |
| source | https://bodytype.org/research/boundary-sensitivity-body-type-calculator |
| algorithm_version | 2 |
| row_count | 669858 |

The row schema is documented in `../schema.json`.
