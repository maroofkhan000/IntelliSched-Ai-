"""Read and write timetable workbooks (one sheet per table, app sheet names)."""
from pathlib import Path

import pandas as pd

from .schema import TABLE_ORDER, columns


def load_workbook(path):
    """Workbook -> {table: DataFrame}. Missing sheets become empty frames, missing columns NaN.

    Every value is read as text first (object dtype) so the cleaning step sees exactly what was
    typed — ' cse', '60', 'sixty' — and decides what to do with it.
    """
    sheets = pd.read_excel(path, sheet_name=None, dtype=object)
    data = {}
    for name in TABLE_ORDER:
        df = sheets.get(name, pd.DataFrame())
        df = df.dropna(how="all")
        for c in columns(name):
            if c not in df.columns:
                df[c] = None
        extra = [c for c in df.columns if c not in columns(name)]
        data[name] = df[columns(name) + extra].reset_index(drop=True).astype(object)
    return data


def save_workbook(data, path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(path, engine="openpyxl") as xw:
        for name in TABLE_ORDER:
            df = data.get(name, pd.DataFrame(columns=columns(name)))
            df.to_excel(xw, sheet_name=name, index=False)
    return path
