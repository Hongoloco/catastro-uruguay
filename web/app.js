/* global L */

const statusEl = document.getElementById('status');
function setStatus(msg) {
  statusEl.textContent = msg || '';
}

// Crear mapa centrado en Uruguay con límites fijados
const URUGUAY_BOUNDS = L.latLngBounds([-35.8, -59.5], [-29.0, -51.0]);
const map = L.map('map', {
  preferCanvas: true, // mejor performance con muchas geometrías
  maxBounds: URUGUAY_BOUNDS,
  maxBoundsViscosity: 0.8,
});
map.fitBounds(URUGUAY_BOUNDS);
map.setMinZoom(map.getZoom());

// Pane específico para etiquetas de padrón
map.createPane('padron-labels');
map.getPane('padron-labels').style.zIndex = 650;

const base = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

// Capas de trabajo
let layerDeptos = null;
let layerCatas0 = null;
let layerCatas1 = null;
let snigLayer = null;
let identifyOn = false;
let searchLayer = null;
let padronLabelsOn = false;
const padronMarkers = new Map();
const PADRON_MIN_ZOOM = 12;
const PADRON_STYLE = { color: '#666', weight: 0.5, opacity: 0.9, fillOpacity: 0 };
const geocodeGroup = L.layerGroup().addTo(map);
const geocodeMarkers = [];
let geocodeCandidatesCache = [];

const styleDeptos = {
  color: '#333',
  weight: 1,
  fill: false
};

function onEachFeaturePopup(f, layer) {
  const props = f.properties || {};
  const keys = Object.keys(props);
  const rows = keys.slice(0, 20).map(k => `<tr><th>${k}</th><td>${props[k]}</td></tr>`).join('');
  layer.bindPopup(`<div style="max-height:220px;overflow:auto"><table class="popup">${rows}</table></div>`);
}

async function loadGeoJSON(path, layerRefSetter, style) {
  setStatus(`Cargando ${path} ...`);
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Esto puede tardar mucho si el archivo es grande
    const data = await res.json();
    const layer = L.geoJSON(data, { style, onEachFeature: onEachFeaturePopup });
    layer.addTo(map);
    layerRefSetter(layer);
    setStatus(`Capa cargada: ${path} (features: ${data.features?.length ?? 'N/D'})`);
    try { map.fitBounds(layer.getBounds(), { padding: [20,20] }); } catch {}
  } catch (e) {
    console.error(e);
    setStatus(`Error cargando ${path}: ${e.message}`);
  }
}

function setLayerDeptos(l) { layerDeptos = l; }
function setLayerCatas0(l) { layerCatas0 = l; }
function setLayerCatas1(l) { layerCatas1 = l; }

function clearLayers() {
  [layerDeptos, layerCatas0, layerCatas1].forEach(l => { if (l) { map.removeLayer(l); } });
  layerDeptos = layerCatas0 = layerCatas1 = null;
  setStatus('Capas removidas.');
}

// Botones
const btnDeptos = document.getElementById('btn-deptos');
btnDeptos.addEventListener('click', () => {
  loadGeoJSON('../outputs/departamentos.geojson', setLayerDeptos, styleDeptos);
});

const btnC0 = document.getElementById('btn-carga-0');
btnC0.addEventListener('click', () => {
  if (!confirm('La capa Catastro Rural es muy grande (~1 GB). Esto puede congelar el navegador. ¿Continuar?')) return;
  loadGeoJSON('../outputs/catastro_rural.geojson', setLayerCatas0, { color: '#cc3300', weight: 0.5, fillOpacity: 0.1 });
});

const btnC1 = document.getElementById('btn-carga-1');
btnC1.addEventListener('click', () => {
  if (!confirm('La capa Catastro Rural y Urbano es muy grande (~1 GB). Esto puede congelar el navegador. ¿Continuar?')) return;
  loadGeoJSON('../outputs/catastro_rural_urbano.geojson', setLayerCatas1, { color: '#0066cc', weight: 0.5, fillOpacity: 0.1 });
});

const btnClear = document.getElementById('btn-limpiar');
btnClear.addEventListener('click', clearLayers);

setStatus('Listo. Carga Departamentos para empezar.');

// Cargar automáticamente el contorno de Uruguay al iniciar
loadGeoJSON('../outputs/departamentos.geojson', setLayerDeptos, styleDeptos);

// -------------------- Vista online (SNIG) --------------------
const SNIG_URL = 'https://web.snig.gub.uy/arcgisserver/rest/services/Uruguay/SNIG_Catastro_Dos/MapServer';
const SNIG_URL_PROXY = '/proxy/mapserver';  // Proxy local para evitar CORS
const LOCATOR_URL = 'https://web.snig.gub.uy/arcgisserver/rest/services/LocatorUY/GeocodeServer';
const LOCATOR_URL_PROXY = '/proxy/geocode';  // Proxy local para geocoder

// Siempre usar proxy - funciona tanto local como en Render
const USE_PROXY = true;

function enableSnig() {
  try {
    if (snigLayer) return;
    if (!(window.L && L.esri)) {
      setStatus('Esri Leaflet no cargó todavía. Recarga la página o espera un momento.');
      return;
    }
    snigLayer = L.esri.dynamicMapLayer({
      url: SNIG_URL,
      opacity: 0.8,
      useCors: true,
      // Dejar que el servicio maneje visibilidad/escala; opcionalmente podríamos especificar layers: [1,2]
    }).addTo(map);
    setStatus('SNIG (MapServer) activado.');
  } catch (e) {
    console.error(e);
    setStatus('No se pudo activar SNIG: ' + e.message);
  }
}

function disableSnig() {
  if (snigLayer) {
    map.removeLayer(snigLayer);
    snigLayer = null;
  }
  setStatus('SNIG (MapServer) desactivado.');
}

// Identify al clic usando el servicio
map.on('click', async (e) => {
  if (!identifyOn || !snigLayer) return;
  setStatus('Consultando información...');
  try {
    const identify = L.esri.identifyFeatures({ url: SNIG_URL })
      .on(map)
      .at(e.latlng)
      .tolerance(5)
      .returnGeometry(false)
      .layers('visible:0,1,2')
      .run((err, resp) => {
        if (err) {
          console.error(err);
          setStatus('Error en identify: ' + err.message);
          return;
        }
        const features = resp?.features || [];
        if (!features.length) {
          setStatus('Sin resultados.');
          return;
        }
        const rows = [];
        // Mostrar algunos atributos relevantes
        const props = features[0].properties || {};
        Object.keys(props).slice(0, 25).forEach(k => rows.push(`<tr><th>${k}</th><td>${props[k]}</td></tr>`));
        L.popup()
          .setLatLng(e.latlng)
          .setContent(`<div style="max-height:240px;overflow:auto"><table class="popup">${rows.join('')}</table></div>`)
          .openOn(map);
        setStatus(`Identify: ${features.length} resultado(s)`);
      });
  } catch (ex) {
    console.error(ex);
    setStatus('Error en identify: ' + ex.message);
  }
});

// Botones SNIG (compatibilidad con interfaz vieja y nueva)
document.getElementById('btn-snig-on')?.addEventListener('click', enableSnig);
document.getElementById('btn-snig-off')?.addEventListener('click', disableSnig);
document.getElementById('btn-identify')?.addEventListener('click', () => {
  identifyOn = !identifyOn;
  setStatus('Identify ' + (identifyOn ? 'activado' : 'desactivado'));
});

// -------------------- Etiquetas de padrón (usando fetch directo) --------------------
const btnPadrones = document.getElementById('btn-padrones');
let padronGeoJSONLayer = null;
let padronFetchController = null;

function getPadronTexto(props) {
  if (props.Codigo) return props.Codigo;
  if (props.NroPadron) return `N-${props.NroPadron}`;
  if (props.DeptoPadron) return props.DeptoPadron;
  return '';
}

async function fetchPadronesInBounds() {
  const bounds = map.getBounds();
  const zoom = map.getZoom();
  
  if (zoom < PADRON_MIN_ZOOM) {
    setStatus(`Acércate más (zoom ≥ ${PADRON_MIN_ZOOM}) para ver padrones.`);
    return;
  }
  
  // Cancelar petición anterior si la hay
  if (padronFetchController) {
    padronFetchController.abort();
  }
  padronFetchController = new AbortController();
  
  // Convertir bounds a envelope para ArcGIS (en coordenadas 4326)
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const geometry = JSON.stringify({
    xmin: sw.lng,
    ymin: sw.lat,
    xmax: ne.lng,
    ymax: ne.lat,
    spatialReference: { wkid: 4326 }
  });
  
  // Usar proxy si está disponible
  const baseUrl = USE_PROXY ? SNIG_URL_PROXY : SNIG_URL;
  const url = `${baseUrl}/1/query`;
  const params = new URLSearchParams({
    where: '1=1',
    geometry: geometry,
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'OBJECTID,DeptoPadron,Codigo,NroPadron',
    returnGeometry: 'true',
    f: 'geojson',
    outSR: '4326',
    resultRecordCount: '2000'  // Limitar para no saturar
  });
  
  setStatus('Cargando padrones...');
  try {
    const res = await fetch(`${url}?${params.toString()}`, {
      signal: padronFetchController.signal,
      cache: 'no-cache'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    
    // Limpiar capa anterior
    clearPadronLayer();
    
    if (!data.features || data.features.length === 0) {
      setStatus('Sin padrones en esta zona.');
      return;
    }
    
    // Crear capa GeoJSON con polígonos
    padronGeoJSONLayer = L.geoJSON(data, {
      style: PADRON_STYLE,
      onEachFeature: (feature, layer) => {
        const props = feature.properties || {};
        const texto = getPadronTexto(props);
        
        // Popup con info
        const rows = Object.keys(props).map(k => `<tr><th>${k}</th><td>${props[k]}</td></tr>`).join('');
        layer.bindPopup(`<div style="max-height:180px;overflow:auto"><table class="popup">${rows}</table></div>`);
        
        // Etiqueta centrada
        if (texto) {
          try {
            const center = layer.getBounds().getCenter();
            const marker = L.marker(center, {
              icon: L.divIcon({ className: 'padron-label', html: texto }),
              interactive: false,
              pane: 'padron-labels'
            });
            padronMarkers.set(props.OBJECTID || L.stamp(feature), marker);
            marker.addTo(map);
          } catch (e) {
            // Ignorar si no se puede calcular centro
          }
        }
      }
    }).addTo(map);
    
    setStatus(`Padrones cargados: ${data.features.length} polígonos.`);
  } catch (e) {
    if (e.name === 'AbortError') {
      // Cancelado intencionalmente
      return;
    }
    console.error(e);
    setStatus('Error cargando padrones: ' + e.message);
  }
}

function clearPadronLayer() {
  if (padronGeoJSONLayer) {
    map.removeLayer(padronGeoJSONLayer);
    padronGeoJSONLayer = null;
  }
  padronMarkers.forEach((marker) => map.removeLayer(marker));
  padronMarkers.clear();
}

function onMapMoveEndPadrones() {
  if (padronLabelsOn) {
    fetchPadronesInBounds();
  }
}

function enablePadronLabels() {
  if (padronLabelsOn) return;
  padronLabelsOn = true;
  btnPadrones.textContent = 'Ocultar números de padrón';
  map.on('moveend', onMapMoveEndPadrones);
  fetchPadronesInBounds();
}

function disablePadronLabels() {
  if (!padronLabelsOn) return;
  padronLabelsOn = false;
  btnPadrones.textContent = 'Mostrar números de padrón';
  map.off('moveend', onMapMoveEndPadrones);
  if (padronFetchController) {
    padronFetchController.abort();
    padronFetchController = null;
  }
  clearPadronLayer();
  setStatus('Números de padrón desactivados.');
}

btnPadrones?.addEventListener('click', () => {
  if (padronLabelsOn) {
    disablePadronLabels();
  } else {
    enablePadronLabels();
  }
});

// -------------------- Búsqueda de padrón --------------------
const inPadron = document.getElementById('in-padron');
const inDepto = document.getElementById('in-depto');
const inDireccion = document.getElementById('in-direccion');
const autocompleteList = document.getElementById('autocomplete-list');
const geocodeResultadosEl = document.getElementById('geocode-resultados');

// Variables para autocompletado
let autocompleteTimeout = null;
let autocompleteCache = [];
let selectedAutocompleteIdx = -1;

function highlightPadronFeatures(data) {
  if (!data || !Array.isArray(data.features) || !data.features.length) {
    return 0;
  }
  if (searchLayer) {
    map.removeLayer(searchLayer);
    searchLayer = null;
  }
  searchLayer = L.geoJSON(data, {
    style: { color: '#ffcc00', weight: 2, fillOpacity: 0.15 },
    onEachFeature: onEachFeaturePopup
  }).addTo(map);
  try {
    map.fitBounds(searchLayer.getBounds(), { padding: [20, 20] });
  } catch (err) {
    // ignorar si no se puede calcular bounds (p.ej. geometría puntual)
  }
  return data.features.length;
}

async function buscarPadron() {
  const padron = parseInt(inPadron.value, 10);
  const depto = parseInt(inDepto.value, 10);
  if (!padron || padron <= 0) {
    setStatus('Ingrese un número de padrón válido.');
    return;
  }
  let where = `NroPadron = ${padron}`;
  if (!Number.isNaN(depto)) {
    where += ` AND CodDepartamento = ${depto}`;
  }
  setStatus('Buscando padrón ...');
  try {
    // Consultamos la capa 1 (Rural y Urbano) para cubrir ambos casos
    const baseUrl = USE_PROXY ? SNIG_URL_PROXY : SNIG_URL;
    const url = `${baseUrl}/1/query`;
    const params = new URLSearchParams({
      where,
      outFields: '*',
      returnGeometry: 'true',
      f: 'geojson',
      outSR: '4326'
    });
    const res = await fetch(`${url}?${params.toString()}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const count = highlightPadronFeatures(data);
    if (!count) {
      setStatus('Sin resultados para ese padrón.');
      return;
    }
    setStatus(`Encontrados ${count} polígono(s) para padrón ${padron}${!Number.isNaN(depto) ? ' (depto '+depto+')' : ''}.`);
  } catch (e) {
    console.error(e);
    setStatus('Error en la búsqueda: ' + e.message);
  }
}

function limpiarBusqueda() {
  if (searchLayer) { map.removeLayer(searchLayer); searchLayer = null; }
  setStatus('Resultado de búsqueda eliminado.');
}

function limpiarGeocodeResultados() {
  geocodeGroup.clearLayers();
  geocodeMarkers.length = 0;
  geocodeCandidatesCache = [];
  if (geocodeResultadosEl) {
    geocodeResultadosEl.innerHTML = '';
  }
}

function renderGeocodeResultados(candidates) {
  if (!geocodeResultadosEl) return;
  geocodeResultadosEl.innerHTML = '';
  geocodeCandidatesCache = candidates;
  candidates.forEach((cand, idx) => {
    const item = document.createElement('div');
    item.className = 'geocode-item';
    const titulo = document.createElement('strong');
    titulo.textContent = cand.address || 'Dirección sin nombre';
    const score = document.createElement('span');
    score.textContent = `Puntaje: ${Math.round(cand.score ?? 0)}`;
    const boton = document.createElement('button');
    boton.textContent = 'Ver padrón';
    boton.addEventListener('click', () => mostrarPadronParaCandidato(idx));
    item.appendChild(titulo);
    item.appendChild(score);
    item.appendChild(boton);
    geocodeResultadosEl.appendChild(item);
  });
}

async function mostrarPadronParaCandidato(idx) {
  const cand = geocodeCandidatesCache[idx];
  if (!cand) {
    setStatus('Candidato no disponible.');
    return;
  }
  const loc = cand.location;
  if (!loc) {
    setStatus('Candidato sin ubicación.');
    return;
  }
  const latlng = L.latLng(loc.y, loc.x);
  map.setView(latlng, Math.max(map.getZoom(), 17));
  const marker = geocodeMarkers[idx];
  if (marker) {
    marker.openPopup();
  }
  setStatus('Consultando padrón para la dirección seleccionada...');
  try {
    const geometry = JSON.stringify({ x: loc.x, y: loc.y, spatialReference: { wkid: 4326 } });
    const body = new URLSearchParams({
      geometry,
      geometryType: 'esriGeometryPoint',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: '*',
      returnGeometry: 'true',
      outSR: '4326',
      f: 'geojson'
    });
    const baseUrl = USE_PROXY ? SNIG_URL_PROXY : SNIG_URL;
    const res = await fetch(`${baseUrl}/1/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const count = highlightPadronFeatures(data);
    if (!count) {
      setStatus('No se encontró padrón en esa ubicación.');
      return;
    }
    const etiqueta = cand.address || 'Dirección';
    setStatus(`Dirección: ${etiqueta}. Padrones intersectados: ${count}.`);
  } catch (e) {
    console.error(e);
    setStatus('Error al consultar el padrón: ' + e.message);
  }
}

// -------------------- Autocompletado de direcciones --------------------
function closeAutocomplete() {
  if (autocompleteList) {
    autocompleteList.classList.remove('show');
    autocompleteList.innerHTML = '';
  }
  selectedAutocompleteIdx = -1;
}

function renderAutocomplete(candidates) {
  if (!autocompleteList) return;
  autocompleteList.innerHTML = '';
  autocompleteCache = candidates;
  
  if (!candidates.length) {
    closeAutocomplete();
    return;
  }
  
  candidates.forEach((cand, idx) => {
    const item = document.createElement('div');
    item.className = 'autocomplete-item';
    item.innerHTML = `<span class="addr-main">${cand.address || 'Sin nombre'}</span><span class="addr-score">${Math.round(cand.score ?? 0)}%</span>`;
    item.addEventListener('click', () => selectAutocompleteItem(idx));
    item.addEventListener('mouseenter', () => {
      selectedAutocompleteIdx = idx;
      highlightAutocompleteItem();
    });
    autocompleteList.appendChild(item);
  });
  
  autocompleteList.classList.add('show');
}

function highlightAutocompleteItem() {
  const items = autocompleteList?.querySelectorAll('.autocomplete-item') || [];
  items.forEach((item, idx) => {
    item.classList.toggle('active', idx === selectedAutocompleteIdx);
  });
}

async function selectAutocompleteItem(idx) {
  const cand = autocompleteCache[idx];
  if (!cand || !cand.location) return;
  
  // Poner la dirección en el input
  inDireccion.value = cand.address || '';
  closeAutocomplete();
  
  // Mover el mapa a la ubicación
  const latlng = L.latLng(cand.location.y, cand.location.x);
  map.setView(latlng, 17);
  
  // Poner un marcador
  geocodeGroup.clearLayers();
  const marker = L.circleMarker(latlng, {
    radius: 8,
    color: '#0066cc',
    weight: 2,
    fillColor: '#66a3ff',
    fillOpacity: 0.8
  }).addTo(geocodeGroup);
  marker.bindPopup(cand.address || 'Ubicación').openPopup();
  
  setStatus(`Mostrando: ${cand.address}`);
  
  // Buscar el padrón en esa ubicación
  try {
    const geometry = JSON.stringify({ x: cand.location.x, y: cand.location.y, spatialReference: { wkid: 4326 } });
    const body = new URLSearchParams({
      geometry,
      geometryType: 'esriGeometryPoint',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: '*',
      returnGeometry: 'true',
      outSR: '4326',
      f: 'geojson'
    });
    const baseUrl2 = USE_PROXY ? SNIG_URL_PROXY : SNIG_URL;
    const res = await fetch(`${baseUrl2}/1/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body
    });
    if (res.ok) {
      const data = await res.json();
      const count = highlightPadronFeatures(data);
      if (count > 0) {
        setStatus(`${cand.address} - Padrón encontrado (${count} polígono/s)`);
      }
    }
  } catch (e) {
    console.error('Error buscando padrón:', e);
  }
}

async function fetchAutocomplete(texto) {
  if (!texto || texto.length < 2) {
    closeAutocomplete();
    return;
  }
  
  try {
    // Usar Nominatim (OpenStreetMap) que es más confiable para Uruguay
    const url = `/proxy/nominatim/search?q=${encodeURIComponent(texto)}&limit=8`;
    
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) {
      console.warn('Nominatim respondió:', res.status);
      return;
    }
    
    const data = await res.json();
    if (data.error) {
      console.warn('Error de Nominatim:', data.error);
      return;
    }
    
    // Nominatim devuelve array directamente con lat/lon
    const candidates = (data || []).filter(c => c && c.lat && c.lon).map(c => ({
      address: c.display_name,
      location: { x: parseFloat(c.lon), y: parseFloat(c.lat) },
      score: Math.round(100 - (c.place_rank || 30)),
      type: c.type,
      class: c.class
    }));
    
    renderAutocomplete(candidates);
  } catch (e) {
    console.error('Error en autocompletado:', e);
  }
}

// Event listeners para autocompletado
if (inDireccion) {
  inDireccion.addEventListener('input', (e) => {
    const texto = e.target.value.trim();
    
    // Cancelar timeout anterior
    if (autocompleteTimeout) {
      clearTimeout(autocompleteTimeout);
    }
    
    // Debounce: esperar 300ms después de que el usuario deje de escribir
    autocompleteTimeout = setTimeout(() => {
      fetchAutocomplete(texto);
    }, 300);
  });
  
  // Navegación con teclado
  inDireccion.addEventListener('keydown', (e) => {
    const items = autocompleteList?.querySelectorAll('.autocomplete-item') || [];
    if (!items.length) return;
    
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedAutocompleteIdx = Math.min(selectedAutocompleteIdx + 1, items.length - 1);
      highlightAutocompleteItem();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedAutocompleteIdx = Math.max(selectedAutocompleteIdx - 1, 0);
      highlightAutocompleteItem();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedAutocompleteIdx >= 0) {
        selectAutocompleteItem(selectedAutocompleteIdx);
      } else if (autocompleteCache.length > 0) {
        selectAutocompleteItem(0);
      }
    } else if (e.key === 'Escape') {
      closeAutocomplete();
    }
  });
  
  // Cerrar al hacer clic fuera
  document.addEventListener('click', (e) => {
    if (!inDireccion.contains(e.target) && !autocompleteList?.contains(e.target)) {
      closeAutocomplete();
    }
  });
}

// La función buscarDireccion ya no es necesaria con autocompletado,
// pero la mantenemos por si acaso
async function buscarDireccion() {
  const texto = (inDireccion?.value || '').trim();
  if (!texto) {
    setStatus('Ingrese una dirección (ej. calle y número).');
    return;
  }
  // Simplemente disparar el autocompletado
  fetchAutocomplete(texto);
}

document.getElementById('btn-buscar').addEventListener('click', buscarPadron);
document.getElementById('btn-borrar-busqueda').addEventListener('click', limpiarBusqueda);

inPadron?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    buscarPadron();
  }
});

// ==================== NUEVA INTERFAZ ====================

// Toggle sidebar
document.getElementById('toggle-sidebar')?.addEventListener('click', () => {
  document.querySelector('.sidebar')?.classList.toggle('collapsed');
});

// Acordeón - toggle para mostrar/ocultar contenido
document.querySelectorAll('.accordion-header').forEach(header => {
  header.addEventListener('click', function() {
    // Toggle del header actual
    this.classList.toggle('active');
    const content = this.nextElementSibling;
    if (content) {
      content.classList.toggle('show');
    }
  });
});

// Checkbox toggle para SNIG
document.getElementById('chk-snig')?.addEventListener('change', (e) => {
  if (e.target.checked) {
    enableSnig();
  } else {
    disableSnig();
  }
});

// Checkbox toggle para padrones
document.getElementById('chk-padrones')?.addEventListener('change', (e) => {
  if (e.target.checked) {
    padronLabelsOn = true;
    if (map.getZoom() >= PADRON_MIN_ZOOM) {
      showPadronLabels();
    } else {
      setStatus(`Haz zoom (nivel ${PADRON_MIN_ZOOM}+) para ver padrones`);
    }
  } else {
    padronLabelsOn = false;
    hidePadronLabels();
  }
});

// Checkbox toggle para identificar
document.getElementById('chk-identify')?.addEventListener('change', (e) => {
  identifyOn = e.target.checked;
  setStatus(identifyOn ? 'Haz clic en el mapa para identificar parcela' : '');
  map.getContainer().style.cursor = identifyOn ? 'crosshair' : '';
});

// Botón Mi ubicación
document.getElementById('btn-locate')?.addEventListener('click', () => {
  setStatus('Buscando ubicación...');
  map.locate({ setView: true, maxZoom: 16 });
});

map.on('locationfound', (e) => {
  L.circleMarker(e.latlng, {
    radius: 10,
    color: '#2563eb',
    fillColor: '#3b82f6',
    fillOpacity: 0.8
  }).addTo(geocodeGroup).bindPopup('Tu ubicación').openPopup();
  setStatus('Ubicación encontrada');
});

map.on('locationerror', () => {
  setStatus('No se pudo obtener la ubicación');
});

// Botón pantalla completa
document.getElementById('btn-fullscreen')?.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
});
