#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Exporta números de padrón desde la capa Catastro Rural y Urbano (ID 1).

Uso básico:
  python scripts/export_padrones.py                # todos los padrones (puede tardar)
    python scripts/export_padrones.py --depto 10     # solo departamento 10
    python scripts/export_padrones.py --depto 10 --localidad 10101

Salida: CSV en outputs/padrones_[depto|all].csv con columnas:
- cod_departamento
- nro_padron
- depto_padron (texto "DeptoPadron")

Nota: el proceso consulta el servicio en lotes de 1000 y evita duplicados en
memoria. Descargar todos los padrones puede llevar bastante tiempo y memoria.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from typing import Dict, Iterable, Optional, Set, Tuple

import requests

BASE_URL = "https://web.snig.gub.uy/arcgisserver/rest/services/Uruguay/SNIG_Catastro_Dos/MapServer/1/query"
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "outputs")
CHUNK_SIZE = 1000
RETRY = 3
SLEEP = 0.5

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "snig-padrones-export/1.0 (+https://github.com/)"
})


def _post(data: Dict[str, str]) -> Dict:
    last_exc = None
    for attempt in range(1, RETRY + 1):
        try:
            resp = SESSION.post(BASE_URL, data=data, timeout=120)
            resp.raise_for_status()
            data_json = resp.json()
            if isinstance(data_json, dict) and "error" in data_json:
                raise RuntimeError(data_json["error"])
            return data_json
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if attempt < RETRY:
                time.sleep(SLEEP * attempt)
            else:
                raise
    # no se debería llegar aquí
    raise RuntimeError(last_exc)  # type: ignore[misc]


def fetch_padrones(where: str) -> Iterable[Tuple[int, int, str]]:
    offset = 0
    seen: Set[Tuple[int, int]] = set()
    while True:
        payload = {
            "where": where,
            "outFields": "CodDepartamento,NroPadron,DeptoPadron,codLocCat,nomLocCat",
            "f": "json",
            "returnGeometry": "false",
            "resultOffset": str(offset),
            "resultRecordCount": str(CHUNK_SIZE),
            "orderByFields": "CodDepartamento ASC,NroPadron ASC",
            "returnDistinctValues": "false",
        }
        data = _post(payload)
        features = data.get("features", [])
        if not features:
            break
        for feat in features:
            attrs: Dict = feat.get("attributes", {})
            cod = attrs.get("CodDepartamento")
            nro = attrs.get("NroPadron")
            depto_padron = attrs.get("DeptoPadron", "")
            if cod is None or nro is None:
                continue
            key = (int(cod), int(nro))
            if key in seen:
                continue
            seen.add(key)
            yield int(cod), int(nro), str(depto_padron or ""), str(attrs.get("codLocCat", "")), str(attrs.get("nomLocCat", ""))
        offset += CHUNK_SIZE
        if not data.get("exceededTransferLimit") and len(features) < CHUNK_SIZE:
            break


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Exportar números de padrón desde SNIG Catastro (capa 1)")
    parser.add_argument("--depto", type=int, help="Código de departamento (1-19). Si se omite, exporta todos.")
    parser.add_argument("--localidad", help="Código de localidad catastral (codLocCat). Requiere --depto.")
    args = parser.parse_args(list(argv) if argv is not None else None)

    where = "NroPadron IS NOT NULL"
    suffix_parts = []
    if args.depto is not None:
        if not (1 <= args.depto <= 19):
            print("--depto debe estar entre 1 y 19", file=sys.stderr)
            return 2
        where += f" AND CodDepartamento = {args.depto}"
        suffix_parts.append(f"depto_{args.depto}")
    else:
        if args.localidad:
            print("Para filtrar por localidad es necesario indicar --depto.", file=sys.stderr)
            return 2

    if args.localidad:
        where += f" AND codLocCat = '{args.localidad}'"
        suffix_parts.append(f"loc_{args.localidad}")

    suffix = "_".join(suffix_parts) if suffix_parts else "all"
    if args.depto is not None:
        if not (1 <= args.depto <= 19):
            print("--depto debe estar entre 1 y 19", file=sys.stderr)
            return 2
        where += f" AND CodDepartamento = {args.depto}"
        suffix = f"depto_{args.depto}"

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    out_path = os.path.join(OUTPUT_DIR, f"padrones_{suffix}.csv")
    print(f"Consultando padrones ({suffix})...")

    count = 0
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["cod_departamento", "nro_padron", "depto_padron", "cod_localidad", "nombre_localidad"])
        for cod, nro, depto_padron, cod_loc, nom_loc in fetch_padrones(where):
            writer.writerow([cod, nro, depto_padron, cod_loc, nom_loc])
            count += 1
            if count % 5000 == 0:
                print(f"  {count} registros exportados...")

    print(f"Listo. Se exportaron {count} padrones a {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
