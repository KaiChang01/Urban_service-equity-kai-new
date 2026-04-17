# Housing equity & 311 service analysis

This project turns **unit-level housing and 311 request data** into **grid-level** metrics, then combines two views of the city:

1. **Clusters (K-Means)** — groups of grid cells with similar rent, resolution time, property age, request intensity, and request-type mix. These clusters support a narrative about *where* patterns repeat.
2. **Equity score (0–100)** — a composite index built from **service performance** (volume, speed, diversity, positive vs. negative request mix) and **service need** (density, crowding, age/rent control, affordability stress, tenure). PCA on standardized sub-indicators supplies the weights; the score is normalized for comparison across the city.

**Root-cause layer:** For each cluster, z-scores highlight which indicators differ most from the city average. Notebook-derived **heuristics** (dire needs + intervention queue) give a policy-facing story that matches each cluster archetype.

The **web dashboard** (`docs/`) is a static site: a map (equity or cluster coloring) and, on the same page, a cluster report with charts and heuristics. It reads CSV/JSON/GeoJSON produced by the pipeline—nothing is computed in the browser.

---

## Repository layout

| Path | Purpose |
|------|---------|
| `run_pipeline.py` | End-to-end pipeline: load CSV → aggregate to grid → cluster → equity score → export artifacts |
| `DB_MVP.ipynb` | Original exploratory notebook (same logic as the script) |
| `docs/` | Static dashboard (`index.html`, assets). **Do not commit** generated data under `docs/outputs/` (see below). |
| `requirements.txt` | Python dependencies |

Generated files are **not** checked into git. You create them locally or in Colab after running the pipeline.

---

## Do I need to keep `outputs/`?

**No.** Folders like `outputs/`, `outputs_full/`, and `docs/outputs/` are **build artifacts**. They are listed in `.gitignore`. You regenerate them whenever you:

- refresh the analysis, or  
- want the website to show maps and charts (the site expects files under `docs/outputs/` when you deploy).

**What gets written** (typical `run_pipeline.py` run):

- `grid_results.csv` — Scored grid cells with cluster, equity score, performance/need scores, indicators  
- `cluster_summary.csv` — Per-cluster counts and equity summaries  
- `cluster_feature_zscores.csv` — Cluster vs. city z-scores for root-cause charts  
- `metadata.json` — PCA weights, top features per cluster, cluster heuristics  
- `grid_points.geojson` — (optional, `--write-geojson`) Points for the map  
- `grid_place_map.csv` — Grid-to-place lookup (`neighborhood` + `supervisor district`) for place-aware chat queries

### Rebuild place mapping after data updates

If you update any of the files below:

- `docs/outputs/grid_points.geojson`
- `docs/outputs/sf_neighborhoods.geojson`
- `docs/outputs/sf_supervisor_districts.geojson`

rebuild the lookup table with:

```bash
python3 scripts/build_grid_place_map.py
```

This rewrites `docs/outputs/grid_place_map.csv` so chat/location lookups stay in sync with the latest boundaries and grid points.

---

## Setup

```bash
python -m pip install -r requirements.txt
```

Python 3.10+ recommended.

---

## Running the pipeline

### Default input (Google Colab + Drive)

The default path matches a typical **Colab notebook** with Drive mounted:

`/content/drive/My Drive/243 Group 2/Module 2/data/merged_rent_311.csv`

If you run **without** `--input`, that path is used. You can also set:

```bash
export MERGED_RENT_311_CSV="/full/path/to/your/merged_rent_311.csv"
python run_pipeline.py --output-dir outputs --write-geojson
```

### Local or custom path

```bash
python run_pipeline.py --input ./merged_rent_311.csv --output-dir outputs --write-geojson
```

### Build artifacts for the GitHub Pages site

Write into `docs/outputs/` so the dashboard can load them:

```bash
python run_pipeline.py --input /path/to/merged_rent_311.csv --output-dir docs/outputs --write-geojson
```

Then serve the site locally (example):

```bash
python -m http.server 5173 --directory docs
```

Open `http://localhost:5173/`. For GitHub Pages, configure the repo to publish the **`/docs`** folder on your default branch; the **first** push should include the pipeline outputs you generated (or CI can run the pipeline—optional).

---

## Web dashboard behavior

- **Map:** Equity-first coloring (gradient) or cluster colors; filters and cluster selection.  
- **Click a grid:** Updates the cluster report below and scrolls to it.  
- **Report:** Summary stats, z-score chart, dire needs + intervention queue, PCA weights.

---

## Input data

The CSV must match the schema expected by `DB_MVP.ipynb` / `run_pipeline.py` (unit-level rows with `grid_id`, lat/lon, rent, 311 request counts and percent mixes, etc.). Use your team’s merged `merged_rent_311.csv` or a sample with the same columns.

**GitHub:** `merged_rent_311.csv` is listed in `.gitignore` because full datasets often exceed GitHub’s per-file size limit (~100MB). Keep the file locally (or in cloud storage) and pass it with `--input` or `MERGED_RENT_311_CSV`. For [Git LFS](https://git-lfs.com/) or a public download URL, you can remove that line if your policy allows versioning large data.

---

## License / attribution

Add your course or team attribution here if required.
