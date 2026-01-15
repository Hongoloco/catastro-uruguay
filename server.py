"""
Servidor Flask para el visor de Catastro SNIG.
Sirve archivos estáticos y actúa como proxy para evitar CORS.
"""

from flask import Flask, request, Response, send_from_directory
from flask_cors import CORS
import requests
import os
import logging

# Suprimir logs de Werkzeug para evitar problemas con PowerShell
log = logging.getLogger('werkzeug')
log.setLevel(logging.ERROR)

app = Flask(__name__)
CORS(app)

# Configuración - usar variable de entorno PORT para Render, o 5000 local
PORT = int(os.environ.get('PORT', 5000))
WEB_DIR = os.path.join(os.path.dirname(__file__), 'web')
OUTPUTS_DIR = os.path.join(os.path.dirname(__file__), 'outputs')

# URLs del SNIG
GEOCODE_URL = "https://web.snig.gub.uy/arcgisserver/rest/services/LocatorUY/GeocodeServer"
MAPSERVER_URL = "https://web.snig.gub.uy/arcgisserver/rest/services/Uruguay/SNIG_Catastro_Dos/MapServer"


@app.route('/')
def index():
    """Sirve el archivo index.html"""
    return send_from_directory(WEB_DIR, 'index.html')


@app.route('/<path:filename>')
def serve_web(filename):
    """Sirve archivos estáticos desde web/"""
    return send_from_directory(WEB_DIR, filename)


@app.route('/outputs/<path:filename>')
def serve_outputs(filename):
    """Sirve archivos desde outputs/"""
    return send_from_directory(OUTPUTS_DIR, filename)


@app.route('/proxy/nominatim/search', methods=['GET'])
def proxy_nominatim():
    """Proxy para Nominatim (OpenStreetMap geocoder) - más confiable para Uruguay"""
    q = request.args.get('q', '')
    limit = request.args.get('limit', '8')
    
    # Agregar Uruguay al final de la búsqueda si no lo tiene
    if 'uruguay' not in q.lower():
        q = f"{q}, Uruguay"
    
    url = "https://nominatim.openstreetmap.org/search"
    params = {
        'q': q,
        'format': 'json',
        'limit': limit,
        'countrycodes': 'uy',
        'addressdetails': '1'
    }
    headers = {'User-Agent': 'CatastroVisor/1.0 (Windows)'}
    
    try:
        resp = requests.get(url, params=params, headers=headers, timeout=10)
        return Response(resp.content, resp.status_code, mimetype='application/json')
    except Exception as e:
        return Response(f'{{"error": "{str(e)}"}}', 502, mimetype='application/json')


@app.route('/proxy/geocode/<path:endpoint>', methods=['GET', 'POST'])
def proxy_geocode(endpoint):
    """Proxy para el geocoder SNIG"""
    url = f"{GEOCODE_URL}/{endpoint}"
    return proxy_request(url)


@app.route('/proxy/mapserver/<path:endpoint>', methods=['GET', 'POST'])
def proxy_mapserver(endpoint):
    """Proxy para el MapServer SNIG"""
    url = f"{MAPSERVER_URL}/{endpoint}"
    return proxy_request(url)


def proxy_request(url):
    """Realiza la petición proxy y devuelve la respuesta"""
    try:
        # Pasar los parámetros de query
        params = request.args.to_dict()
        
        if request.method == 'POST':
            resp = requests.post(url, params=params, data=request.form, timeout=30)
        else:
            resp = requests.get(url, params=params, timeout=30)
        
        # Crear respuesta con los mismos headers relevantes
        excluded_headers = ['content-encoding', 'content-length', 'transfer-encoding', 'connection']
        headers = [(name, value) for name, value in resp.raw.headers.items()
                   if name.lower() not in excluded_headers]
        
        response = Response(resp.content, resp.status_code, headers)
        response.headers['Content-Type'] = resp.headers.get('Content-Type', 'application/json')
        
        return response
        
    except requests.exceptions.RequestException as e:
        return Response(
            f'{{"error": "Proxy error: {str(e)}"}}',
            status=502,
            mimetype='application/json'
        )


if __name__ == '__main__':
    import sys
    
    # Suprimir el warning de desarrollo
    cli = sys.modules['flask.cli']
    cli.show_server_banner = lambda *x: None
    
    print(f"""
╔════════════════════════════════════════════════════════════╗
║         Servidor Catastro SNIG - Flask                     ║
╠════════════════════════════════════════════════════════════╣
║  Visor:     http://localhost:{PORT}/                          ║
║  Geocoder:  http://localhost:{PORT}/proxy/geocode/...         ║
║  MapServer: http://localhost:{PORT}/proxy/mapserver/...       ║
╠════════════════════════════════════════════════════════════╣
║  Presiona Ctrl+C para detener el servidor                  ║
╚════════════════════════════════════════════════════════════╝
""")
    
    app.run(host='0.0.0.0', port=PORT, debug=False, threaded=True)
