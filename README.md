# Exportar SNIG Catastro a local

Este proyecto descarga los datos del servicio ArcGIS MapServer:

https://web.snig.gub.uy/arcgisserver/rest/services/Uruguay/SNIG_Catastro_Dos/MapServer

Capas incluidas:
- 0: Catastro Rural (polígonos)
- 1: Catastro Rural y Urbano (polígonos)
- 2: Departamentos (polígonos)
- 3: tblLocalidadCatastral (tabla)

Salidas:
- GeoJSON (EPSG:4326) para las capas 0,1,2 en `outputs/*.geojson`
- CSV para la tabla 3 en `outputs/*.csv`

## Requisitos
- Python 3.9+ (probado con 3.13)
- Paquetes: `requests`

## Instalación rápida (Windows PowerShell)

```powershell
# Crear y activar un entorno virtual (opcional pero recomendado)
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# Instalar dependencias
pip install -r requirements.txt

# Exportar solo capas livianas primero (evita 0 y 1 inicialmente)
python scripts\export_snig_catastro.py --skip-large

# Exportar todo (puede tardar bastante, especialmente la capa 0)
python scripts\export_snig_catastro.py

# Exportar solo una capa por ID (ejemplo: Departamentos = 2)
python scripts\export_snig_catastro.py --layers 2

```

### Generar ejecutable standalone

```powershell
# (una vez) instalar la herramienta de empaquetado
pip install pyinstaller

# Construir el ejecutable (crea dist/export_snig_catastro.exe)
pyinstaller --onefile --name export_snig_catastro scripts\export_snig_catastro.py

# Ejecutarlo (las salidas se guardan en dist\outputs\)
cd dist
.\export_snig_catastro.exe --layers 2


```


## Ejecutar un mapa local con Leaflet

Incluí una vista simple en `web/` que carga los GeoJSON locales.

1) Inicia un servidor HTTP local en la raíz del proyecto:

```powershell
python -m http.server 8000
```

2) Abre en el navegador:

```
http://localhost:8000/web/
```

Notas:
- `Departamentos` se carga rápido; las capas catastrales (0 y 1) son muy grandes y pueden tardar mucho o congelar el navegador. Cárgalas solo si lo necesitas.
- Para rendimiento serio, considera convertir a tiles vectoriales (p.ej., Tippecanoe -> MBTiles -> Tileserver) o usar GeoServer.
- El visor permite activar el MapServer oficial, buscar padrones, buscar direcciones (geocoder SNIG) y mostrar números de padrón (zoom ≥ 13) usando el servicio online.

### Exportar padrones a CSV

El script `scripts/export_padrones.py` genera un CSV con los números de padrón (capa 1 del SNIG).

```powershell
# Todos los padrones (grande, tarda)
python scripts\export_padrones.py

# Solo un departamento
python scripts\export_padrones.py --depto 1

# Departamento + localidad (usar codLocCat tal como viene en el CSV, ej. BA, AA, etc.)
python scripts\export_padrones.py --depto 1 --localidad BA

# Guardado en outputs/padrones_<filtros>.csv
```
```

## Notas
- El servicio usa SRID 32721 (UTM 21S). El script reproyecta al vuelo a WGS84 (EPSG:4326) usando `outSR=4326` de ArcGIS.
- El servidor limita el tamaño por solicitud (`MaxRecordCount = 1000`). El script pagina y descarga en lotes de 1000 por `OBJECTID`.
- La capa 0 (Catastro Rural) es grande (>250k registros). La descarga completa puede demorar y generar archivos grandes.
- Si necesitas Shapefile/GeoPackage, puedes convertir los GeoJSON con GDAL/OGR.

Ejemplo (opcional) de conversión si tienes GDAL instalado:

```powershell
# GeoJSON -> GeoPackage
ogr2ogr -f GPKG outputs\catastro.gpkg outputs\catastro_rural.geojson -nln catastro_rural
```

## Estructura
- `scripts/export_snig_catastro.py`: script principal de exportación
- `scripts/export_padrones.py`: exporta números de padrón (CSV) por departamento y localidad
- `outputs/`: directorio destino de archivos
- `requirements.txt`: dependencias

## Licencia y uso
Respeta los términos de uso del SNIG. Este script realiza consultas públicas sin autenticación y está destinado a uso técnico para cache local.
