from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler
import os

_GDRIVE_CSV = "/content/drive/My Drive/243 Group 2/Module 2/data/merged_rent_311.csv"
_LOCAL_CSV = "/Users/kylechang/Documents/Claude Projects/Urban-Service-Equity/merged_rent_311.csv"

try:
    from google.colab import drive
    drive.mount('/content/drive')
except ImportError:
    pass


# -----------------------------
# Defaults (mirrors DB_MVP.ipynb)
# -----------------------------

def _resolve_default_csv() -> str:
    if env := os.environ.get("MERGED_RENT_311_CSV"):
        return env
    if os.path.isfile(_GDRIVE_CSV):
        return _GDRIVE_CSV
    return _LOCAL_CSV

DEFAULT_INPUT_CSV = _resolve_default_csv()

CLUSTER_FEATURES_DEFAULT: List[str] = [
    "median_rent",  # Economic baseline
    "median_resolution_days",  # Service efficiency
    "median_property_age",  # Infrastructure health
    "request_intensity",  # Systemic service load per unit
    "pct_311_external_request",  # Bureaucratic friction / referral rate
    "pct_street_and_sidewalk_cleaning",  # High-effort task share
]

SERVICE_COLS_DEFAULT: List[str] = [
    "total_311_requests",
    "avg_resolution_days",
    "median_resolution_days",
    "num_unique_services",
    "pct_street_and_sidewalk_cleaning",
    "pct_tree_maintenance",
    "pct_streetlights",
    "pct_rec_and_park_requests",
    "pct_graffiti",
    "pct_encampments",
    "pct_illegal_postings",
    "pct_abandoned_vehicle",
    "pct_noise_report",
]

NEED_COLS_DEFAULT: List[str] = [
    "unit_count_clean",
    "bedrooms_for_ratio",
    "sqft_avg",
    "sqft_per_resident",
    "bathrooms_per_resident",
    "property_age",
    "likely_rent_controlled",
    "monthly_rent_clean",
    "occupancy_duration_years",
]

CLUSTER_NAMES_DEFAULT: Dict[int, str] = {
    0: "Cluster A — High-Rent, Low Service Volume",
    1: "Cluster B — Dominant Residential",
    2: "Cluster C — High-Density Outlier",
    3: "Cluster D — Slow Resolution Hotspot",
}

# Heuristic archetypes (mirrors DB_MVP.ipynb Cell 10)
#
# Each cluster's intervention plan is structured so every recommendation is
# concrete enough to assign tomorrow:
#   • title   — <=5 words, action-led
#   • desc    — one sentence tying the fix to the observed data signal
#   • actions — <=14 words each, naming the lead agency + threshold/timeframe
#   • owner   — single accountable department
#   • kpi     — one measurable success metric
# The queue is a 30/60/90-day sprint: (day, action, rationale).
HEURISTICS_DEFAULT: Dict[int, dict] = {
    0: {
        "archetype": "High-Rent, Low Service Volume",
        "signal": "Low 311 volume in high-rent zones — under-reporting, not satisfaction",
        "needs": [
            {
                "rank": 1,
                "priority": "HIGH",
                "title": "Surface hidden maintenance gaps",
                "desc": "High rent and aging stock with a thin 311 signal suggests tenants fear retaliation more than they lack issues.",
                "owner": "DBI",
                "kpi": "+25% habitability complaints from rent-controlled units within 6 months (reporting uplift is success)",
                "actions": [
                    "DBI: annual proactive habitability inspection for rent-controlled buildings 40+ years old",
                    "Publish a landlord-level 311 scorecard on DataSF, refreshed monthly",
                    "Open an anonymous 311 channel through 211 and community orgs",
                ],
            },
            {
                "rank": 2,
                "priority": "HIGH",
                "title": "Protect reporters from retaliation",
                "desc": "High rent and low volume track the displacement corridor — residents trade service for tenancy.",
                "owner": "Rent Board + MOHCD",
                "kpi": "Zero cases where tenant identity is disclosed to landlord; 90% outreach coverage in top displacement ZIPs",
                "actions": [
                    "Fund multilingual Tenants' Rights outreach in top-10 displacement ZIPs (Cantonese, Spanish, Tagalog, Russian)",
                    "Require 311 supervisors to seal case IDs tied to active eviction filings",
                    "Cross-match 311 gaps with Rent Board petitions quarterly",
                ],
            },
            {
                "rank": 3,
                "priority": "MED",
                "title": "Benchmark equity inside the cluster",
                "desc": "Cluster averages mask internal gaps — low-income renters inside high-rent zones are the blind spot.",
                "owner": "Controller + DataSF",
                "kpi": "Income-tiered benchmark adopted; <10% p90/p10 gap in response time within cluster",
                "actions": [
                    "Split cluster reporting by income tertile and publish quarterly",
                    "Pair each grid cell with a building-age p90 infrastructure-risk score",
                    "Controller's Office approves the new equity benchmark by Q3",
                ],
            },
        ],
        "queue": [
            (
                "30d",
                "DBI launches habitability inspection sweep of rent-controlled buildings 40+ years old",
                "Inspection, not enforcement — the fastest way to see what silent tenants can't report.",
            ),
            (
                "60d",
                "Anonymous 311 channel live; outreach active in top-10 displacement ZIPs",
                "Trusted reporting paths come before volume — otherwise the data stays skewed.",
            ),
            (
                "90d",
                "Controller publishes income-tiered equity benchmark and landlord scorecard",
                "What gets measured changes; publishing creates the accountability the cluster lacks.",
            ),
        ],
    },
    1: {
        "archetype": "Dominant Residential",
        "signal": "High-volume residential core — cleaning, tree care, and density pressure",
        "needs": [
            {
                "rank": 1,
                "priority": "HIGH",
                "title": "Scale cleaning to match demand",
                "desc": "Street and sidewalk cleaning is the top citywide request — this is a staffing and routing problem, not a behavior one.",
                "owner": "DPW",
                "kpi": "Median cleaning-request resolution <3 days; repeat-request rate <20%",
                "actions": [
                    "DPW: add one weekly sweep on streets with 10+ cleaning requests per month",
                    "Install 300 corner bins at the top-50 litter hotspots by Q3",
                    "Push 'sweep day' 311-app notifications 24 hours before arrival",
                ],
            },
            {
                "rank": 2,
                "priority": "MED",
                "title": "Shorten the tree-care cycle",
                "desc": "Tree requests cluster on the aging canopy — deferred trimming drives liability and sidewalk damage.",
                "owner": "DPW Bureau of Urban Forestry",
                "kpi": "p90 time-to-trim under 120 days; trip-and-fall tree claims <5 per 1,000 trees per year",
                "actions": [
                    "Shift BUF trim cycle from 10 to 5 years on trees 40+ years old",
                    "Open StreetTreeSF geolocation reporting to any resident without a login",
                    "Fund 20 neighborhood stewardship micro-grants at $5k each",
                ],
            },
            {
                "rank": 3,
                "priority": "HIGH",
                "title": "Release density pressure lawfully",
                "desc": "High occupancy and long tenure signal crowding; enforcement alone displaces without increasing supply.",
                "owner": "Planning + DBI + MOHCD",
                "kpi": "+20% ADU permits filed vs. prior year; zero tenants displaced by overcrowding referrals",
                "actions": [
                    "Planning: expedite ADU permits to 90 days in this cluster",
                    "DBI: route overcrowding inspections from tenant tips, not landlord calls",
                    "MOHCD: publish a cluster infill-parcel inventory within 6 months",
                ],
            },
        ],
        "queue": [
            (
                "30d",
                "DPW adds weekly sweep plus top-50 hotspot bin installation plan",
                "Cleaning is the loudest signal — solving it first buys credibility for the rest.",
            ),
            (
                "60d",
                "BUF trim cycle shortened on 40+ year trees across the cluster",
                "Canopy debt compounds; shortening the cycle is cheaper than claims payouts.",
            ),
            (
                "90d",
                "Planning publishes ADU fast-track and infill inventory for the cluster",
                "Density pressure is a supply problem; inspections alone just relocate it.",
            ),
        ],
    },
    2: {
        "archetype": "High-Density Outlier",
        "signal": "5σ volume + severe crowding + minimal resolution — treat as an incident, not a baseline",
        "needs": [
            {
                "rank": 1,
                "priority": "CRITICAL",
                "title": "Stand up an incident response",
                "desc": "A single cell at 5σ sustained is a service incident, not a baseline — it needs incident command, not quarterly review.",
                "owner": "Office of the City Administrator",
                "kpi": "Zero tickets older than 30 days by Day 45; incident closed or elevated to CAD by Day 90",
                "actions": [
                    "Open a cross-agency incident command (DPW, DBI, HSOC, DPH) for 90 days",
                    "Day 1: age-triage every open ticket; reassign or close anything over 30 days",
                    "Daily standup with the Controller's Office reporting out",
                ],
            },
            {
                "rank": 2,
                "priority": "CRITICAL",
                "title": "Verify what's inside the buildings",
                "desc": "Severe crowding signals undocumented units or SRO conditions — a life-safety audit is overdue.",
                "owner": "DBI + DPH",
                "kpi": "100% parcels inspected; zero unpermitted units unresolved by Day 120",
                "actions": [
                    "DBI: egress and occupancy audit on every parcel in the cell within 60 days",
                    "DPH: offer on-site tenant health screenings during the audit window",
                    "Freeze new certificates of occupancy in the cell until the audit clears",
                ],
            },
            {
                "rank": 3,
                "priority": "HIGH",
                "title": "Restore livability bandwidth",
                "desc": "A cell this dense with no positive-service signal is starved for public space and dedicated attention.",
                "owner": "RPD + DPW",
                "kpi": "Positive-service request share reaches the citywide median by Day 180",
                "actions": [
                    "RPD: fund a parklet or plaza activation within three blocks",
                    "DPW: daily cleaning and bi-weekly graffiti abatement for 6 months",
                    "Assign a 0.5 FTE community liaison for 12 months",
                ],
            },
        ],
        "queue": [
            (
                "30d",
                "Incident command stood up; age-triage of open tickets completed",
                "5σ cells cannot be fixed by routine ops; command structure is the unlock.",
            ),
            (
                "60d",
                "DBI occupancy audit complete; community liaison in place",
                "You cannot plan services until you know who is living where and how.",
            ),
            (
                "90d",
                "Parklet/plaza funded; cell reviewed by the Board of Supervisors",
                "Formal supervisorial escalation keeps the fix durable past election cycles.",
            ),
        ],
    },
    3: {
        "archetype": "Slow Resolution Hotspot",
        "signal": "Resolution time 5.5σ above city mean — a routing failure, not a workload spike",
        "needs": [
            {
                "rank": 1,
                "priority": "CRITICAL",
                "title": "Break the 30-day backlog",
                "desc": "Resolution this far above the mean points to stuck handoffs, not volume — fix the routing first.",
                "owner": "311 Customer Service Center",
                "kpi": "p90 resolution under 14 days by Day 90",
                "actions": [
                    "Auto-escalate any ticket open more than 14 days to the department head with SLA timer",
                    "Clear the cluster's 30-day backlog within 45 days",
                    "Pause new low-priority intake until the backlog is under 100 tickets",
                ],
            },
            {
                "rank": 2,
                "priority": "HIGH",
                "title": "Stabilize negative-signal complaints",
                "desc": "Encampments, graffiti, and abandoned vehicles compound each other — batched response beats siloed dispatch.",
                "owner": "HSOC + DPW",
                "kpi": "Repeat-complaint rate within the same block drops 40% in 6 months",
                "actions": [
                    "HSOC + DPW co-deploy with a housing navigator on the same day",
                    "Graffiti abatement SLA of 48 hours from report",
                    "Abandoned-vehicle auto-tow at 72 hours with no hold exception",
                ],
            },
            {
                "rank": 3,
                "priority": "MED",
                "title": "Fix inter-agency routing",
                "desc": "Handoffs between agencies are where time is lost — this is fixable with data, not staffing.",
                "owner": "311 + DataSF",
                "kpi": "Zero tickets with more than 3 inter-agency handoffs; median handoff time under 24 hours",
                "actions": [
                    "Publish a 311 routing-log audit and a handoff dashboard by Q3",
                    "Switch case ownership to supervisor district, not service type",
                    "Send a monthly SLA scorecard to every department head",
                ],
            },
        ],
        "queue": [
            (
                "30d",
                "14-day auto-escalation rule live; backlog triage begins",
                "The backlog isn't workload — it's absence of escalation pressure. Fix that first.",
            ),
            (
                "60d",
                "HSOC/DPW co-deployment piloted; graffiti 48-hour SLA enforced",
                "Batched response on compounding complaints breaks the repeat-call feedback loop.",
            ),
            (
                "90d",
                "Routing-log audit published; case ownership switched to supervisor district",
                "Handoff accountability is the only durable fix for institutional slowness.",
            ),
        ],
    },
}


@dataclass(frozen=True)
class Config:
    k: int = 4
    random_state: int = 42
    cluster_features: Tuple[str, ...] = tuple(CLUSTER_FEATURES_DEFAULT)
    service_cols: Tuple[str, ...] = tuple(SERVICE_COLS_DEFAULT)
    need_cols: Tuple[str, ...] = tuple(NEED_COLS_DEFAULT)
    cluster_names: Dict[int, str] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.cluster_names is None:
            object.__setattr__(self, "cluster_names", dict(CLUSTER_NAMES_DEFAULT))


def _ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def _write_json(path: str, payload: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)


def _require_columns(df: pd.DataFrame, required: List[str], context: str) -> None:
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"Missing required columns for {context}: {missing}")


def load_and_aggregate_to_grid(csv_path: str) -> pd.DataFrame:
    """
    Unit-level CSV -> grid-level dataframe, matching DB_MVP.ipynb Cell 3.
    """
    df = pd.read_csv(csv_path, low_memory=False)

    _require_columns(df, ["grid_id", "lat", "lon"], context="grid aggregation")

    pct_cols = [c for c in df.columns if c.startswith("pct_")]

    agg_dict: Dict[str, str] = {
        "lat": "mean",
        "lon": "mean",
        "monthly_rent_clean": "median",
        "avg_resolution_days": "median",
        "median_resolution_days": "median",
        "total_311_requests": "sum",
        "num_unique_services": "median",
        "property_age": "median",
        "likely_rent_controlled": "mean",
        "sqft_avg": "median",
        "sqft_per_resident": "median",
        "bathrooms_per_resident": "median",
        "unit_count_clean": "sum",
        "bedrooms_for_ratio": "median",
        "occupancy_duration_years": "median",
    }

    # Only aggregate columns that exist in the input schema
    agg_dict = {k: v for k, v in agg_dict.items() if k in df.columns}
    for c in pct_cols:
        agg_dict[c] = "mean"

    # Dominant administrative neighborhood per grid cell (mode of labels).
    # Stored separately because mode() isn't supported by the standard
    # DataFrame.agg() dict path.
    if "analysis_neighborhood" in df.columns:
        nbhd = (
            df.dropna(subset=["analysis_neighborhood"])
              .groupby("grid_id")["analysis_neighborhood"]
              .agg(lambda s: s.mode().iat[0] if not s.mode().empty else np.nan)
              .rename("neighborhood")
        )
    else:
        nbhd = None

    grid_df = df.groupby("grid_id").agg(agg_dict).reset_index()

    if nbhd is not None:
        grid_df = grid_df.merge(nbhd, on="grid_id", how="left")

    # Convenience aliases for clustering feature names
    if "monthly_rent_clean" in grid_df.columns:
        grid_df["median_rent"] = grid_df["monthly_rent_clean"]
    if "property_age" in grid_df.columns:
        grid_df["median_property_age"] = grid_df["property_age"]
    if "unit_count_clean" in grid_df.columns:
        grid_df["housing_density"] = grid_df["unit_count_clean"]

    # Derived feature: 311 requests per housing unit (systemic load indicator)
    if "total_311_requests" in grid_df.columns and "housing_density" in grid_df.columns:
        denom = grid_df["housing_density"].replace(0, 1)
        grid_df["request_intensity"] = grid_df["total_311_requests"] / denom

    # Parse row/col from grid_id (format: 'row_col')
    parts = grid_df["grid_id"].astype(str).str.split("_", expand=True)
    if parts.shape[1] >= 2:
        grid_df["grid_row"] = pd.to_numeric(parts[0], errors="coerce")
        grid_df["grid_col"] = pd.to_numeric(parts[1], errors="coerce")

    return grid_df


def run_kmeans(
    grid_df: pd.DataFrame, *, cfg: Config
) -> Tuple[pd.DataFrame, KMeans, StandardScaler]:
    """
    Match DB_MVP.ipynb Cell 4: standardize CLUSTER_FEATURES and KMeans(K=4).
    """
    _require_columns(grid_df, list(cfg.cluster_features), context="clustering")

    df_clust = grid_df.dropna(subset=list(cfg.cluster_features)).copy()
    scaler_c = StandardScaler()
    scaled_c = scaler_c.fit_transform(df_clust[list(cfg.cluster_features)])

    kmeans = KMeans(n_clusters=cfg.k, random_state=cfg.random_state, n_init=10)
    df_clust["cluster"] = kmeans.fit_predict(scaled_c)

    return df_clust, kmeans, scaler_c


def equity_feature_engineering(df_clust: pd.DataFrame, *, cfg: Config) -> pd.DataFrame:
    """
    Match DB_MVP.ipynb Cell 6.

    Also carries the administrative `neighborhood` label through to the final
    equity dataframe. Neighborhood is a passthrough descriptor (not a numeric
    input) so we include it in the projection but exclude it from the
    equity-score dropna so that a missing neighborhood on some grids never
    disqualifies those grids from being scored.
    """
    all_eq_cols = list(cfg.service_cols) + list(cfg.need_cols)
    _require_columns(df_clust, ["grid_id", "cluster", "lat", "lon"], context="equity scoring base")
    _require_columns(df_clust, all_eq_cols, context="equity scoring inputs")

    # Passthrough descriptors — always carried, but their NaNs never drop rows.
    passthrough_cols = ["grid_id", "cluster", "lat", "lon"]
    if "neighborhood" in df_clust.columns:
        passthrough_cols.append("neighborhood")

    df_eq = (
        df_clust[passthrough_cols + all_eq_cols]
        .dropna(subset=all_eq_cols)
        .copy()
    )

    # Service Performance sub-indicators
    df_eq["S1"] = np.log1p(df_eq["total_311_requests"])
    df_eq["S2"] = (-0.5 * df_eq["avg_resolution_days"]) + (-0.5 * df_eq["median_resolution_days"])
    df_eq["S3"] = df_eq["num_unique_services"]
    df_eq["S4_pos"] = df_eq[
        [
            "pct_street_and_sidewalk_cleaning",
            "pct_tree_maintenance",
            "pct_streetlights",
            "pct_rec_and_park_requests",
        ]
    ].sum(axis=1)
    df_eq["S4_neg"] = df_eq[
        [
            "pct_encampments",
            "pct_graffiti",
            "pct_illegal_postings",
            "pct_abandoned_vehicle",
            "pct_noise_report",
        ]
    ].sum(axis=1)

    # Service Need sub-indicators
    df_eq["N1"] = (df_eq["unit_count_clean"] * df_eq["bedrooms_for_ratio"]) / df_eq["sqft_avg"].replace(
        0, np.nan
    )
    df_eq["N2"] = (1 / df_eq["sqft_per_resident"].replace(0, np.nan)) + (
        1 / df_eq["bathrooms_per_resident"].replace(0, np.nan)
    )
    df_eq["N3"] = df_eq["property_age"] + df_eq["likely_rent_controlled"]
    df_eq["N4"] = 1 / df_eq["monthly_rent_clean"].replace(0, np.nan)
    df_eq["N5"] = 1 / df_eq["occupancy_duration_years"].replace(0, np.nan)

    s_cols = ["S1", "S2", "S3", "S4_pos", "S4_neg"]
    n_cols = ["N1", "N2", "N3", "N4", "N5"]

    # Project to scoring columns but keep the neighborhood passthrough.
    projection = passthrough_cols + s_cols + n_cols
    df_eq = df_eq[projection]
    # Only drop rows with inf/NaN in the scoring inputs — neighborhood nulls
    # are fine and must not remove a grid from the output.
    df_eq = df_eq.replace([np.inf, -np.inf], np.nan).dropna(subset=s_cols + n_cols)
    return df_eq


def compute_equity_scores(df_eq: pd.DataFrame) -> Tuple[pd.DataFrame, dict]:
    """
    Match DB_MVP.ipynb Cell 7: PCA(n_components=1) per block, weighted sums,
    raw_equity ratio, log+clip+minmax -> 0-100 equity_score.
    """
    s_cols = ["S1", "S2", "S3", "S4_pos", "S4_neg"]
    n_cols = ["N1", "N2", "N3", "N4", "N5"]

    scaler_s = StandardScaler()
    scaler_n = StandardScaler()
    X_s = scaler_s.fit_transform(df_eq[s_cols])
    X_n = scaler_n.fit_transform(df_eq[n_cols])

    pca_s = PCA(n_components=1).fit(X_s)
    pca_n = PCA(n_components=1).fit(X_n)

    ws = pca_s.components_[0]
    wn = pca_n.components_[0]

    df_eq = df_eq.copy()
    df_eq["performance_score"] = (
        ws[0] * df_eq["S1"]
        + ws[1] * df_eq["S2"]
        + ws[2] * df_eq["S3"]
        + ws[3] * df_eq["S4_pos"]
        - ws[4] * df_eq["S4_neg"]
    )
    df_eq["need_score"] = (
        wn[0] * df_eq["N1"]
        + wn[1] * df_eq["N2"]
        + wn[2] * df_eq["N3"]
        + wn[3] * df_eq["N4"]
        + wn[4] * df_eq["N5"]
    )
    # Percentage Transformation here - Kai
    # try 4: log + clip + minmax -> 0-100
    df_eq["raw_equity"] = df_eq["performance_score"] / (df_eq["need_score"] + 1e-6)
    upper = np.percentile(df_eq["raw_equity"], 99)
    clipped = np.clip(df_eq["raw_equity"], df_eq["raw_equity"].min(), upper)
    df_eq["equity_score"] = ((clipped - clipped.min()) / (clipped.max() - clipped.min() + 1e-6)) * 100.0

    meta = {
        "pca_weights": {
            "service_performance": dict(zip(s_cols, ws.tolist())),
            "service_need": dict(zip(n_cols, wn.tolist())),
        }
    }
    return df_eq, meta


def zscore_feature_importance(df_eq: pd.DataFrame) -> Tuple[pd.DataFrame, dict]:
    """
    Root-cause style signals: cluster mean z-scores vs global mean/std.
    Returns a z-score matrix (cluster x feature) and top-3 per cluster.
    """
    features = ["S1", "S2", "S3", "S4_pos", "S4_neg", "N1", "N2", "N3", "N4", "N5"]
    mu = df_eq[features].mean()
    sd = df_eq[features].std(ddof=0).replace(0, np.nan)

    z_by_cluster = {}
    top_by_cluster = {}
    for c, sub in df_eq.groupby("cluster"):
        cm = sub[features].mean()
        z = ((cm - mu) / sd).replace([np.inf, -np.inf], np.nan)
        z_by_cluster[int(c)] = z

        top = (
            z.abs()
            .sort_values(ascending=False)
            .head(3)
            .index.tolist()
        )
        top_by_cluster[int(c)] = [
            {
                "feature": feat,
                "z": float(z[feat]) if pd.notna(z[feat]) else None,
                "direction": "above_city_avg" if pd.notna(z[feat]) and z[feat] > 0 else "below_city_avg",
            }
            for feat in top
        ]

    z_df = pd.DataFrame.from_dict(z_by_cluster, orient="index")
    z_df.index.name = "cluster"
    return z_df, {"top3_features_per_cluster": top_by_cluster}


def make_cluster_summary(df_eq: pd.DataFrame, *, cfg: Config) -> pd.DataFrame:
    """
    Dashboard-friendly cluster summary: counts + equity distribution + means.
    """
    grp = df_eq.groupby("cluster")
    summary = pd.DataFrame(
        {
            "n_grids_scored": grp.size(),
            "equity_mean": grp["equity_score"].mean(),
            "equity_median": grp["equity_score"].median(),
            "equity_p10": grp["equity_score"].quantile(0.10),
            "equity_p90": grp["equity_score"].quantile(0.90),
            "performance_mean": grp["performance_score"].mean(),
            "need_mean": grp["need_score"].mean(),
        }
    ).reset_index()

    summary["cluster_name"] = summary["cluster"].map(cfg.cluster_names)
    return summary


def points_to_geojson(df: pd.DataFrame, *, id_col: str = "grid_id") -> dict:
    """
    Minimal GeoJSON FeatureCollection of Point features (no geopandas needed).
    """
    feats = []
    for row in df.itertuples(index=False):
        props = row._asdict()
        lon = props.pop("lon", None)
        lat = props.pop("lat", None)
        if lon is None or lat is None or pd.isna(lon) or pd.isna(lat):
            continue
        feats.append(
            {
                "type": "Feature",
                "id": props.get(id_col),
                "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]},
                "properties": {k: (None if pd.isna(v) else v) for k, v in props.items()},
            }
        )
    return {"type": "FeatureCollection", "features": feats}


def main() -> None:
    parser = argparse.ArgumentParser(description="Run clustering + equity scoring pipeline and export dashboard artifacts.")
    parser.add_argument(
        "--input",
        default=DEFAULT_INPUT_CSV,
        help=(
            "Path to merged rent + 311 CSV (unit-level, same schema as DB_MVP.ipynb). "
            f"Default: Colab Drive path, or set MERGED_RENT_311_CSV. Default value: {DEFAULT_INPUT_CSV!r}"
        ),
    )
    parser.add_argument("--output-dir", default="outputs", help="Directory to write outputs.")
    parser.add_argument("--k", type=int, default=4, help="KMeans clusters (default 4).")
    parser.add_argument("--random-state", type=int, default=42, help="Random seed (default 42).")
    parser.add_argument("--write-geojson", action="store_true", help="Also write GeoJSON point layers.")
    args = parser.parse_args()

    cfg = Config(k=args.k, random_state=args.random_state)
    _ensure_dir(args.output_dir)

    input_path = args.input
    if not os.path.isfile(input_path):
        if input_path != _LOCAL_CSV and os.path.isfile(_LOCAL_CSV):
            print(f"Google Drive path not accessible ({input_path!r}), falling back to local file.")
            input_path = _LOCAL_CSV
        else:
            raise FileNotFoundError(
                f"Input CSV not found: {input_path!r}\n"
                "  • On Colab: mount Drive and ensure the file exists at the default path, or pass --input.\n"
                "  • Locally: pass your file explicitly, e.g. --input ./merged_rent_311.csv\n"
                "  • Or set environment variable MERGED_RENT_311_CSV to the full path."
            )

    grid_df = load_and_aggregate_to_grid(input_path)
    df_clust, kmeans, scaler_c = run_kmeans(grid_df, cfg=cfg)

    df_eq_base = equity_feature_engineering(df_clust, cfg=cfg)
    df_eq, meta = compute_equity_scores(df_eq_base)

    z_df, z_meta = zscore_feature_importance(df_eq)
    cluster_summary = make_cluster_summary(df_eq, cfg=cfg)

    # Join top-3 features onto scored grids (for map tooltips)
    top_map = z_meta["top3_features_per_cluster"]
    df_eq["top3_features"] = df_eq["cluster"].astype(int).map(
        lambda c: ", ".join([d["feature"] for d in top_map.get(int(c), [])])
    )

    # Exports
    grid_results_path = os.path.join(args.output_dir, "grid_results.csv")
    cluster_summary_path = os.path.join(args.output_dir, "cluster_summary.csv")
    zscores_path = os.path.join(args.output_dir, "cluster_feature_zscores.csv")
    metadata_path = os.path.join(args.output_dir, "metadata.json")

    df_eq.to_csv(grid_results_path, index=False)
    cluster_summary.to_csv(cluster_summary_path, index=False)
    z_df.to_csv(zscores_path)

    _write_json(
        metadata_path,
        {
            "config": {
                "k": cfg.k,
                "random_state": cfg.random_state,
                "cluster_features": list(cfg.cluster_features),
                "service_cols": list(cfg.service_cols),
                "need_cols": list(cfg.need_cols),
                "cluster_names": cfg.cluster_names,
            },
            "pca_weights": meta["pca_weights"],
            "top3_features_per_cluster": z_meta["top3_features_per_cluster"],
            "heuristics": HEURISTICS_DEFAULT,
            "artifacts": {
                "grid_results_csv": os.path.basename(grid_results_path),
                "cluster_summary_csv": os.path.basename(cluster_summary_path),
                "cluster_feature_zscores_csv": os.path.basename(zscores_path),
            },
        },
    )

    if args.write_geojson:
        geo_cols = ["grid_id", "lat", "lon", "cluster", "equity_score", "performance_score", "need_score", "top3_features"]
        if "neighborhood" in df_eq.columns:
            geo_cols.append("neighborhood")
        geo_df = df_eq[geo_cols].copy()
        geojson = points_to_geojson(geo_df)
        _write_json(os.path.join(args.output_dir, "grid_points.geojson"), geojson)

    # Lightweight console summary (so you can sanity-check large runs)
    print(f"Input: {input_path}")
    print(f"Aggregated grids: {len(grid_df):,}")
    print(f"Clustered grids (complete features): {len(df_clust):,}")
    print(f"Equity-scored grids: {len(df_eq):,}")
    print(f"Wrote: {grid_results_path}")
    print(f"Wrote: {cluster_summary_path}")
    print(f"Wrote: {zscores_path}")
    print(f"Wrote: {metadata_path}")


if __name__ == "__main__":
    main()

