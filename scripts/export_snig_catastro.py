#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Descarga capas del servicio ArcGIS MapServer SNIG_Catastro_Dos a archivos locales.
- Capas 0,1,2 -> GeoJSON (WGS84 / EPSG:4326)
- Tabla 3 -> CSV

Uso rápido:
  python scripts/export_snig_catastro.py

Requisitos:
  pip install -r requirements.txt
"""
import csv
import json
import math
import os
import sys
from typing import Dict, List, Any
import time
import argparse

import requests


def _resolve_base_dir() -> str:
    """Determina la carpeta raíz para salidas, compatible con PyInstaller."""
    if getattr(sys, "frozen", False):  # ejecutable empaquetado
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.dirname(__file__))


BASE_URL = "https://web.snig.gub.uy/arcgisserver/rest/services/Uruguay/SNIG_Catastro_Dos/MapServer"
BASE_DIR = _resolve_base_dir()
OUTPUT_DIR = os.path.join(BASE_DIR, "outputs")
TMP_DIR = os.path.join(OUTPUT_DIR, "tmp")

# Capas a exportar: (id, nombre_salida, tipo)
# tipo: 'feature' o 'table'
LAYERS = [
    (0, "catastro_rural", "feature"),
    (1, "catastro_rural_urbano", "feature"),
    (2, "departamentos", "feature"),
    (3, "tblLocalidadCatastral", "table"),
]

SESSION = requests.Session()
SESSION.headers.update({
    "User-Agent": "snig-catastro-export/1.0 (+https://github.com/)"
})
TIMEOUT = 60
CHUNK_SIZE = 1000  # coherente con MaxRecordCount: 1000
RETRY = 3
SLEEP_BETWEEN = 0.5


def _get(url: str, params: Dict[str, Any]) -> requests.Response:
    last_exc = None
    for attempt in range(1, RETRY + 1):
        try:
            r = SESSION.get(url, params=params, timeout=TIMEOUT)
            r.raise_for_status()
            # ArcGIS devuelve JSON de error dentro de 200 OK; detectarlo
            if r.headers.get("Content-Type", "").lower().startswith("application/json"):
                data = r.json()
                if isinstance(data, dict) and "error" in data:
                    raise RuntimeError(f"Error REST: {data['error']}")
            return r
        except Exception as e:
            last_exc = e
            if attempt < RETRY:
                time.sleep(SLEEP_BETWEEN * attempt)
            else:
                raise
    assert False, last_exc  # no se alcanza


def _post(url: str, data: Dict[str, Any]) -> requests.Response:
    """POST con reintentos; útil para payloads grandes (evita límites de URL)."""
    last_exc = None
    for attempt in range(1, RETRY + 1):
        try:
            r = SESSION.post(url, data=data, timeout=TIMEOUT)
            r.raise_for_status()
            if r.headers.get("Content-Type", "").lower().startswith("application/json"):
                d = r.json()
                if isinstance(d, dict) and "error" in d:
                    raise RuntimeError(f"Error REST: {d['error']}")
            return r
        except Exception as e:
            last_exc = e
            if attempt < RETRY:
                time.sleep(SLEEP_BETWEEN * attempt)
            else:
                raise
    assert False, last_exc


def get_object_id_field(layer_id: int) -> str:
    url = f"{BASE_URL}/{layer_id}?f=json"
    r = _get(url, params={})
    data = r.json()
    oid_field = data.get("objectIdField") or _find_oid_field(data.get("fields", []))
    if not oid_field:
        raise RuntimeError(f"No se pudo determinar el campo OID para la capa {layer_id}")
    return oid_field


def _find_oid_field(fields: List[Dict[str, Any]]) -> str:
    for f in fields:
        if f.get("type") == "esriFieldTypeOID":
            return f.get("name")
    return ""


def query_ids(layer_id: int, where: str = "1=1") -> List[int]:
    url = f"{BASE_URL}/{layer_id}/query"
    params = {
        "where": where,
        "returnIdsOnly": "true",
        "f": "json",
    }
    r = _get(url, params)
    data = r.json()
    ids = data.get("objectIds", [])
    if not isinstance(ids, list):
        raise RuntimeError(f"Respuesta inesperada de IDs para capa {layer_id}: {data}")
    ids.sort()
    return ids


def query_features_by_ids(layer_id: int, ids: List[int], out_sr: int = 4326) -> Dict[str, Any]:
    url = f"{BASE_URL}/{layer_id}/query"
    data = {
        "objectIds": ",".join(map(str, ids)),
        "outFields": "*",
        "where": "1=1",
        "f": "geojson",
        "outSR": out_sr,
        "returnGeometry": "true",
    }
    # Usar POST para evitar límites de longitud de URL con listas grandes de IDs
    r = _post(url, data)
    return r.json()


def query_table_page(layer_id: int, offset: int, page_size: int = CHUNK_SIZE) -> Dict[str, Any]:
    url = f"{BASE_URL}/{layer_id}/query"
    params = {
        "where": "1=1",
        "outFields": "*",
        "f": "json",
        "returnGeometry": "false",
        "resultOffset": offset,
        "resultRecordCount": page_size,
        "orderByFields": "OBJECTID ASC",
    }
    r = _get(url, params)
    return r.json()


def merge_feature_collections(collections: List[Dict[str, Any]]) -> Dict[str, Any]:
    merged = {
        "type": "FeatureCollection",
        "name": "merged",
        "features": [],
    }
    for c in collections:
        feats = c.get("features", [])
        if not isinstance(feats, list):
            continue
        merged["features"].extend(feats)
    return merged


def write_geojson(path: str, data: Dict[str, Any]):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


def write_csv(path: str, rows: List[Dict[str, Any]]):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not rows:
        # crear CSV vacío con cabeceras mínimas
        with open(path, "w", newline="", encoding="utf-8") as f:
            f.write("")
        return
    fieldnames = sorted({k for row in rows for k in row.keys()})
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def export_feature_layer(layer_id: int, out_name: str):
    print(f"Exportando capa {layer_id} -> {out_name}.geojson ...")
    oid_field = get_object_id_field(layer_id)
    ids = query_ids(layer_id)
    if not ids:
        print("  No hay registros.")
        write_geojson(os.path.join(OUTPUT_DIR, f"{out_name}.geojson"), {
            "type": "FeatureCollection",
            "features": [],
        })
        return

    # Preparar directorio temporal por capa
    layer_tmp_dir = os.path.join(TMP_DIR, out_name)
    os.makedirs(layer_tmp_dir, exist_ok=True)

    total = len(ids)
    chunk_index = 0
    written_features = 0
    # Descargar por chunks a archivos temporales individuales
    for i in range(0, total, CHUNK_SIZE):
        chunk_ids = ids[i:i+CHUNK_SIZE]
        chunk_path = os.path.join(layer_tmp_dir, f"chunk_{chunk_index}.geojson")
        if os.path.exists(chunk_path):
            # Reanudar: si el chunk ya existe, saltar
            try:
                with open(chunk_path, "r", encoding="utf-8") as cf:
                    data = json.load(cf)
                    count = len(data.get("features", []))
                    written_features += count
            except Exception:
                # Si está corrupto, volver a descargar
                pass
            print(f"  Chunk {chunk_index} ya existe, saltando.")
            chunk_index += 1
            print(f"  Progreso estimado: {min(i+CHUNK_SIZE, total)}/{total} registros")
            continue

        fc = query_features_by_ids(layer_id, chunk_ids, out_sr=4326)
        with open(chunk_path, "w", encoding="utf-8") as cf:
            json.dump(fc, cf, ensure_ascii=False)
        count = len(fc.get("features", []))
        written_features += count
        print(f"  Descargados {min(i+CHUNK_SIZE, total)}/{total} registros (chunk {chunk_index}, features: {count})")
        chunk_index += 1

    # Unir chunks en un único GeoJSON final
    out_path = os.path.join(OUTPUT_DIR, f"{out_name}.geojson")
    print("  Uniendo chunks en archivo final...")
    first_feature = True
    total_features = 0
    with open(out_path, "w", encoding="utf-8") as out:
        out.write('{"type":"FeatureCollection","features":[')
        for idx in range(chunk_index):
            chunk_path = os.path.join(layer_tmp_dir, f"chunk_{idx}.geojson")
            if not os.path.exists(chunk_path):
                continue
            with open(chunk_path, "r", encoding="utf-8") as cf:
                data = json.load(cf)
                feats = data.get("features", [])
                for feat in feats:
                    if not first_feature:
                        out.write(',')
                    out.write(json.dumps(feat, ensure_ascii=False))
                    first_feature = False
                    total_features += 1
        out.write(']}')
    print(f"  Guardado: {out_path} (features: {total_features})")
    # Limpieza de temporales
    try:
        for idx in range(chunk_index):
            chunk_path = os.path.join(layer_tmp_dir, f"chunk_{idx}.geojson")
            if os.path.exists(chunk_path):
                os.remove(chunk_path)
        # eliminar carpeta si queda vacía
        if os.path.isdir(layer_tmp_dir) and not os.listdir(layer_tmp_dir):
            os.rmdir(layer_tmp_dir)
    except Exception:
        # no bloquear por limpieza
        pass


def export_table(layer_id: int, out_name: str):
    print(f"Exportando tabla {layer_id} -> {out_name}.csv ...")
    all_rows: List[Dict[str, Any]] = []
    offset = 0
    while True:
        page = query_table_page(layer_id, offset)
        rows = [f.get("attributes", {}) for f in page.get("features", [])]
        all_rows.extend(rows)
        got = len(rows)
        print(f"  Descargados {offset + got} registros")
        if got < CHUNK_SIZE:
            break
        offset += CHUNK_SIZE
    out_path = os.path.join(OUTPUT_DIR, f"{out_name}.csv")
    write_csv(out_path, all_rows)
    print(f"  Guardado: {out_path} (filas: {len(all_rows)})")


def main():
    parser = argparse.ArgumentParser(description="Exportar capas de SNIG_Catastro_Dos a archivos locales")
    parser.add_argument(
        "--layers",
        help="IDs de capa a exportar separados por coma (por defecto: todas). Ej: 2 o 0,2",
        default="",
    )
    parser.add_argument(
        "--skip-large",
        help="Omitir capas potencialmente grandes (0 y 1)",
        action="store_true",
    )
    args = parser.parse_args()

    selected_ids: List[int] = []
    if args.layers:
        try:
            selected_ids = [int(x.strip()) for x in args.layers.split(",") if x.strip() != ""]
        except ValueError:
            print("--layers debe contener enteros separados por coma, p.ej. 2 o 0,2")
            return 2

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    for layer_id, name, kind in LAYERS:
        if selected_ids and layer_id not in selected_ids:
            continue
        if args.skip_large and layer_id in (0, 1):
            print(f"Saltando capa grande {layer_id} ({name}) por --skip-large")
            continue
        try:
            if kind == "feature":
                export_feature_layer(layer_id, name)
            elif kind == "table":
                export_table(layer_id, name)
            else:
                print(f"Tipo desconocido: {kind} para {name}")
        except Exception as e:
            print(f"Error exportando {name} (id {layer_id}): {e}")


if __name__ == "__main__":
    sys.exit(main())
