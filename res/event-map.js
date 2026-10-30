/** Converts either column labels or the events sheet's first-row headers into records. */
function sheetRecords(table, columns) {
    const hasLabels = table.cols.some(column => column.label);
    const names = table.cols.map((column, index) =>
        (hasLabels ? column.label : table.rows[0]?.c[index]?.v) || columns[index]);
    return table.rows.slice(hasLabels ? 0 : 1).map(row => Object.fromEntries(
        names.map((name, index) => [name, row.c?.[index]?.v ?? null])));
}

/** Joins normalized location names and rejects missing coordinates or malformed intervals. */
function geocodedEvents(eventsTable, locationsTable) {
    const locations = new Map();
    const records = sheetRecords(locationsTable, ['locname', 'lat', 'lng']);
    const normalizeLocation = name => typeof name == 'string' ? name.trim().toLowerCase() : '';

    // Load location records into a map
    for (const location of records) {
        const name = normalizeLocation(location.locname);
        const { lat, lng } = location;
        if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 &&
            Math.abs(lng) <= 180 && name)
            locations.set(name, [lat, lng]);
    }

    // Load events in database with location coordinates
    // Drop events with missing location or geocoding data
    const columns = ['start', 'end', 'summary', 'location', 'description', 'calendarId'];
    const now = Date.now();
    return sheetRecords(eventsTable, columns).flatMap(event => {
        const start = Date.parse(event.start), end = Date.parse(event.end);
        if (end <= now)
            return [];
        const name = normalizeLocation(event.location);
        if (!name)
            return [];
        if (!locations.has(name)) {
            console.warn(`No geocoding entry found for event location: ${event.location}!`);
            return [];
        }
        const coordinates = locations.get(name);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
            console.warn(`Invalid event interval for event: ${event.summary}!`);
            return [];
        }
        return [{ ...event, calendarId: event[Object.keys(event)[5]], start, end, coordinates }];
    });
}

/** Extends Leaflet's Canvas renderer to draw custom 12px event pins. */
const CanvasPinRenderer = L.Canvas.extend({
    _updateCircle(pin) {
        if (!this._drawing || pin._empty())
            return;
        const context = this._ctx;
        const { x, y } = pin._point;
        context.beginPath();
        context.moveTo(x, y + 6);
        context.bezierCurveTo(x - 2, y + 3, x - 4, y, x - 4, y - 2);
        context.arc(x, y - 2, 4, Math.PI, 0);
        context.bezierCurveTo(x + 4, y, x + 2, y + 3, x, y + 6);
        context.closePath();
        this._fillStroke(context, pin);
    }
});

/** Extends Leaflet's CircleMarker to create custom event pins with adjusted projection and popup anchor. */
const CanvasPin = L.CircleMarker.extend({
    _project() {
        L.CircleMarker.prototype._project.call(this);
        this._point.y -= 6;
        this._updateBounds();
    },
    _getPopupAnchor() {
        return [0, -12];
    }
});

/** Displays geocoded events inside the calendar iframe using huroutes' Leaflet setup. */
class EventMap {
    /** Distance slider value meaning no distance limit. */
    static Inf = '401';

    /** Metres the user must move before marker distances are recalculated. */
    static MoveThreshold = 500;

    /** Creates map controls immediately; only this iframe requests event and geocoding data. */
    constructor() {
        this._calendars = new Map();
        this._events = [];
        this._map = L.map('map', { zoomControl: false })
            .fitBounds([[48.509, 15.659], [45.742, 23.193]]);
        this._map.createPane('eventDotPane').classList.add('event-dot-pane');
        this._dotRenderer = new CanvasPinRenderer({ pane: 'eventDotPane', tolerance: 10 });
        this._markers = L.layerGroup().addTo(this._map);
        this._map.on('zoomend', () => {
            if (this._usingDots != (this._map.getZoom() < 10))
                this._render();
            else
                this._updateLabels();
        });
        this._map.on('moveend', () => this._updateLabels());
        this._map.on('resize', () => this._markers.eachLayer(m => m.getPopup().update()));
        this._status = document.getElementById('map-status');
        this._initLayers();
        this._initDates();
        this._initDistance();
        this._initLocation();
        this._initReference();

        // Update the dark/light theme now and on changes
        const theme = matchMedia('(prefers-color-scheme: dark)');
        const updateTheme = () => {
            document.documentElement.classList.toggle('theme-dark', theme.matches);
            document.documentElement.classList.toggle('theme-light', !theme.matches);
            // Black border always, but map colour inversion must be corrected
            this._dotBorderColor = theme.matches ? '#fff' : '#000';
            if (this._usingDots)
                this._markers.eachLayer(dot => dot.setStyle({ color: this._dotBorderColor }));
        };
        theme.addEventListener('change', updateTheme);
        updateTheme();

        // Handle the calendar subscription link in the parent page
        document.getElementById('map-subscribe').addEventListener('click', event => {
            event.preventDefault();
            parent.calendars.openSubscription();
        });

        this._load();
    }

    /** Matches huroutes' base layers, optional overlays, and satellite-only road overlay. */
    _initLayers() {
        const google = (type, className) => L.tileLayer(
            `https://{s}.google.com/vt/lyrs=${type}&x={x}&y={y}&z={z}`, {
                attribution: '&copy; Google Maps', minZoom: 5, maxZoom: 18,
                subdomains: ['mt0', 'mt1', 'mt2', 'mt3'], className
            });
        const tourist = (url, className, zIndex) => L.tileLayer(url, {
            attribution: '&copy; turistautak.hu', minZoom: 5, maxZoom: 18, className, zIndex
        });
        const tiles = {
            Map: L.tileLayer.provider('OpenStreetMap', { className: 'tile-openstreetmap' }),
            Terrain: L.tileLayer.provider('OpenTopoMap', { className: 'tile-opentopomap' }),
            Satellite: L.tileLayer.provider('Esri.WorldImagery', { className: 'tile-satellite' }),
            'Google Map': google('m', 'tile-googlemap'),
            'Google Terrain': google('p', 'tile-googleterrain'),
            'Google Satellite': google('s,h', 'tile-googlesatellite')
        };
        const overlays = {
            'Elevation Shading': tourist(
                'https://map.turistautak.hu/tiles/shading/{z}/{x}/{y}.png', 'overlay-dem', 5),
            Turistautak: tourist('https://{s}.tile.openstreetmap.hu/tt/{z}/{x}/{y}.png',
                'overlay-turistautak', 100)
        };
        const roads = tourist('https://map.turistautak.hu/tiles/lines/{z}/{x}/{y}.png',
            'overlay-satelliteroads', 10);
        const labels = {
            Map: 'Térkép', Terrain: 'Domborzat', Satellite: 'Műhold',
            'Google Map': 'Google Térkép', 'Google Terrain': 'Google Domborzat',
            'Google Satellite': 'Google Műhold', 'Elevation Shading': 'Domborzat Kiemelés'
        };
        const localized = layers => Object.fromEntries(Object.entries(layers)
            .map(([id, layer]) => {
                layer.id = id;
                return [labels[id] || id, layer];
            }));

        // Initialize map controls
        L.control.layers(localized(tiles), localized(overlays), { position: 'bottomleft' })
            .addTo(this._map);
        L.control.scale({ position: 'bottomright', imperial: false }).addTo(this._map);
        L.control.zoom({ position: 'bottomright', zoomInTitle: 'Térkép nagyítása',
            zoomOutTitle: 'Térkép kicsinyítése' }).addTo(this._map);
        const attribution = this._map.attributionControl.getContainer();
        new ResizeObserver(() => this._map.getContainer().style
            .setProperty('--attribution-height', attribution.offsetHeight + 'px'))
            .observe(attribution);

        // Load the user's preferred base layer
        const selected = localStorage.eventMapStyle || 'Map';
        (tiles[selected] || tiles.Map).addTo(this._map);

        // Automatically show roads for the satellite layer
        if (selected == 'Satellite')
            roads.addTo(this._map);
        this._map.on('baselayerchange', event => {
            localStorage.eventMapStyle = event.layer.id;
            if (event.layer.id == 'Satellite')
                roads.addTo(this._map);
            else
                roads.remove();
        });

        // Load and persist map overlays
        for (const id of (localStorage.eventMapOverlays || '').split('|'))
            overlays[id]?.addTo(this._map);
        this._map.on('overlayadd overlayremove', () => {
            localStorage.eventMapOverlays = Object.keys(overlays)
                .filter(id => this._map.hasLayer(overlays[id])).join('|');
        });
    }

    /** Uses huroutes' high-accuracy location control and stops following after pan or zoom. */
    _initLocation() {
        this._locationControl = L.control.locate({
            cacheLocation: false,
            clickBehavior: { inView: 'stop', outOfView: 'setView', inViewNotFollowing: 'setView' },
            initialZoomLevel: 16, keepCurrentZoomLevel: true, position: 'bottomright',
            flyTo: true, locateOptions: { enableHighAccuracy: true },
            setView: 'untilPanOrZoom', showPopup: false,
            strings: { title: 'Az aktuális pozícióm mutatása.' },
            onLocationError: () => {
                localStorage.removeItem('eventMapLocation');
                const message = 'A helyzeted nem határozható meg.';
                this._setLocation(null, message);
                this._status.textContent = message;
            }
        }).addTo(this._map);
        this._map.on('locateactivate', () => localStorage.eventMapLocation = 'true');
        this._map.on('locatedeactivate', () => {
            localStorage.removeItem('eventMapLocation');
            this._setLocation(null, 'A helymeghatározás leállt.');
        });
        this._map.on('locationfound', event => {
            this._setLocation(event.latlng);
        });
        if (localStorage.eventMapLocation) {
            this._locationControl.options.setView = false;
            this._locationControl.start();
            this._locationControl.options.setView = 'untilPanOrZoom';
            try {
                this._locationControl.stopFollowing();
            } catch { }
        }
    }

    // Keeps distance transient and waits for a location before accepting finite ranges.
    _initDistance() {
        this._distance = document.getElementById('distance');
        this._distanceLabel = document.getElementById('distance-value');
        this._distanceStatus = document.getElementById('filter-status');
        this._distanceLimit = Infinity;
        this._distanceJobId = 0;
        this._distance.value = EventMap.Inf;
        this._updateDistanceLabel();

        const requestLocation = () => {
            if (!this._location)
                this.requestLocation();
        };
        this._distance.addEventListener('pointerdown', requestLocation);
        this._distance.addEventListener('keydown', event => {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
                'Home', 'End', 'PageUp', 'PageDown'].includes(event.key))
                requestLocation();
        });
        const updateDistance = immediate => {
            if (!this._location) {
                this._distance.value = EventMap.Inf;
                requestLocation();
                this._updateDistanceLabel();
                return;
            }
            if (this._distance.value == EventMap.Inf) {
                this._resetDistance();
                return;
            }
            this._distanceLimit = Number(this._distance.value);
            this._distanceStatus.hidden = true;
            this._updateDistanceLabel();
            this._updateDistances(true);
            if (immediate && this._distances)
                this._renderDistance(true);
        };
        this._distance.addEventListener('input', () => updateDistance(false));
        this._distance.addEventListener('change', () => updateDistance(true));

        window.addEventListener('pagehide', () => {
            clearTimeout(this._distanceRenderTimer);
            this._distanceRenderTimer = null;
            this._map.stopLocate();
            this._setLocation(null);
            this._invalidateDistances();
            this._closeReferenceResults();
        });
        window.addEventListener('pageshow', event => {
            if (!event.persisted)
                return;
            this._resetDistance();
            this._updateDistances();
            const resume = localStorage.eventMapLocation;
            this._locationControl.stop();
            if (resume)
                this.requestLocation();
        });
    }

    /** Requests the existing location control without changing the map camera. */
    requestLocation() {
        if (this._locationRequested)
            return;
        this._locationRequested = true;
        const setView = this._locationControl.options.setView;
        this._locationControl.options.setView = false;
        try {
            this._locationControl.start();
            this._locationControl.stopFollowing();
        } finally {
            this._locationControl.options.setView = setView;
        }
    }

    /** GPS remains available underneath the manual origin, including when tracking stops.
     * @param location The new location to set. `null` clears the location.
     * @param error An optional error message to display.
     * @param force If `true`, forces the update even if a reference location exists.
    */
    _setLocation(location, error = '', force = false) {
        this._locationRequested = false;
        this._actualLocation = location;
        if (this._referenceLocation && !force)
            return;
        this._location = this._referenceLocation || location;
        if (force)
            this._invalidateDistances();
        if (!this._location)
            this._resetDistance(error);
        else {
            this._distanceStatus.hidden = true;
            if (force)
                this._renderDistance(true);
            this._updateDistances();
        }
    }

    /** Discards cached distances and stops any running distance worker. */
    _invalidateDistances() {
        this._distances = null;
        this._distanceOrigin = null;
        this._distanceJob = null;
        this._distanceWorker?.terminate();
        this._distanceWorker = null;
    }

    /** Updates the distance label based on the current distance value. */
    _updateDistanceLabel() {
        const label = (this._distance.value == EventMap.Inf ? '\u221e' : this._distance.value) +
            ' km';
        this._distanceLabel.textContent = label;
        this._distance.setAttribute('aria-valuetext', label);
        this._updateFilterSummary();
    }

    /** Resets the distance display and terminates any ongoing distance calculation. */
    _resetDistance(message = '') {
        this._distanceLimit = Infinity;
        this._distance.value = EventMap.Inf;
        if (!this._location || message)
            this._invalidateDistances();
        this._distanceStatus.textContent = message;
        this._distanceStatus.hidden = !message;
        this._updateDistanceLabel();
        this._renderDistance(true);
    }

    /** Coalesces live range changes so marker rebuilds do not run on every input event. */
    _renderDistance(immediate = false) {
        if (immediate) {
            clearTimeout(this._distanceRenderTimer);
            this._distanceRenderTimer = null;
            this._render();
        } else if (this._distanceRenderTimer == null) {
            // When the user drags the distance slider, delay rendering to avoid excessive updates
            this._distanceRenderTimer = setTimeout(() => {
                this._distanceRenderTimer = null;
                this._render();
            }, 100);
        }
    }

    /** Reuses distances until the user moves MoveThreshold; only one worker job runs at a time. */
    _updateDistances(updateRange = false) {
        if (!this._location || !this._loaded || this._distanceJob)
            return;
        if (this._distances &&
            this._distanceOrigin.distanceTo(this._location) < EventMap.MoveThreshold
        ) {
            if (updateRange)
                this._renderDistance();
            return;
        }
        try {
            if (!this._distanceWorker) {
                this._distanceWorker = new Worker('event-map-distance.js');
                this._distanceWorker.onmessage = ({ data }) => {
                    if (data.id != this._distanceJob)
                        return;
                    // The last distance job has completed; update event distances
                    this._distanceJob = null;
                    this._distances = data.distances;
                    this._distanceOrigin = L.latLng(...data.location);
                    this._events.forEach((event, index) => event.distance = data.distances[index]);

                    // Without distance filter, only update labels; otherwise, re-render distances
                    if (this._distanceLimit == Infinity)
                        this._updateLabels();
                    else
                        this._renderDistance(true);

                    // If the user moved 1km, trigger another distance update
                    if (this._distanceOrigin.distanceTo(this._location) >= EventMap.MoveThreshold)
                        this._updateDistances();
                };
                this._distanceWorker.onerror = () =>
                    this._resetDistance('A távolságszűrő nem indítható el.');
            }
            // Run the distance calculation job in the background worker
            this._distanceJob = ++this._distanceJobId;
            this._distanceWorker.postMessage({
                id: this._distanceJob,
                location: [this._location.lat, this._location.lng],
                coordinates: this._events.map(event => event.coordinates)
            });
        } catch {
            this._resetDistance('A távolságszűrő nem indítható el.');
        }
    }

    /** Keeps a draggable manual distance origin independent of GPS tracking. */
    _initReference() {
        this._referenceAddress = document.getElementById('reference-address');
        this._referenceResults = document.getElementById('reference-results');
        this._referenceStatus = document.getElementById('reference-status');
        this._referenceSearch = document.getElementById('reference-search');
        this._geocoder = new EventMapGeocoder();
        this._referenceSearchId = 0;
        this._referenceSearch.addEventListener('click', () => this._searchReference());
        document.getElementById('reference-clear').addEventListener('click', () =>
            this._clearReference()
        );
        this._referenceAddress.addEventListener('keydown', event => {
            if (event.key == 'Enter') {
                event.preventDefault();
                this._searchReference();
            }
        });
        this._referenceAddress.addEventListener('input', () => this._closeReferenceResults());
        document.getElementById('date-filter').addEventListener('toggle', event => {
            if (!event.target.open)
                this._closeReferenceResults();
        });
        if (localStorage.eventMapReference) {
            try {
                const { lat, lng, name } = JSON.parse(localStorage.eventMapReference);
                if (typeof name != 'string' ||!EventMapGeocoder.isValidCoordinate(lat, lng))
                    throw new Error('Invalid saved reference location.');
                this._setReference(L.latLng(lat, lng), name, false);
            } catch (error) {
                console.error('Cannot restore reference location.', error);
                localStorage.removeItem('eventMapReference');
                this._showReferenceStatus('A mentett viszonyítási hely nem állítható vissza.');
            }
        }
    }

    /** Shows or hides the reference search status message. */
    _showReferenceStatus(message = '') {
        this._referenceStatus.textContent = message;
        this._referenceStatus.hidden = !message;
    }

    /** Hides reference search results and invalidates pending searches. */
    _closeReferenceResults() {
        ++this._referenceSearchId;
        this._referenceResults.replaceChildren();
        this._referenceResults.hidden = true;
        this._referenceAddress.setAttribute('aria-expanded', 'false');
        this._showReferenceStatus();
    }

    /** Geocodes the reference address and applies a single match or lists several. */
    async _searchReference() {
        const query = this._referenceAddress.value.trim();
        if (this._referenceSearch.disabled)
            return;
        this._closeReferenceResults();
        if (!query) {
            this._showReferenceStatus('Adj meg egy helynevet vagy címet.');
            this._referenceAddress.focus();
            return;
        }
        const id = this._referenceSearchId;
        this._referenceSearch.disabled = true;
        this._showReferenceStatus('Hely keresése...');
        try {
            // Do the geocoding search
            const results = await this._geocoder.search(query);
            if (id != this._referenceSearchId)
                return; // The filter panel was closed, this search was invalidated
            this._showReferenceStatus();
            if (!results.length)
                this._showReferenceStatus('Nincs találat. Próbálj pontosabb címet megadni.');
            else if (results.length == 1)
                this._setReference(L.latLng(results[0].lat, results[0].lng), results[0].name);
            else {
                // List multiple search results for the user to choose from
                for (const result of results) {
                    const item = document.createElement('li');
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.textContent = result.name;
                    const details = document.createElement('small');
                    details.textContent = [result.type,
                        `${result.lat.toFixed(5)}, ${result.lng.toFixed(5)}`].filter(Boolean).join(' · ');
                    button.append(details);
                    button.addEventListener('click', () => {
                        this._setReference(L.latLng(result.lat, result.lng), result.name);
                        this._referenceAddress.focus();
                    });
                    item.append(button);
                    this._referenceResults.append(item);
                }
                this._referenceResults.hidden = false;
                this._referenceAddress.setAttribute('aria-expanded', 'true');
                this._showReferenceStatus('Válassz egy helyszínt a találatok közül.');
            }
        } catch (error) {
            console.error('Reference location search failed.', error);
            if (id == this._referenceSearchId)
                this._showReferenceStatus('A helykeresés sikertelen. Próbáld újra később.');
        } finally {
            this._referenceSearch.disabled = false;
        }
    }

    /** Stores the reference location, updates its marker, and refreshes distances. */
    _setReference(location, name, zoom = true) {
        this._closeReferenceResults();
        this._referenceLocation = location;
        this._referenceAddress.value = name;
        localStorage.eventMapReference = JSON.stringify({ lat: location.lat, lng: location.lng, name });
        if (!this._referenceMarker) {
            this._referenceMarker = L.marker(location, {
                draggable: true, autoPan: true, zIndexOffset: 1000,
                title: 'Viszonyítási hely: húzással áthelyezhető, kattintással törölhető.',
                alt: 'Viszonyítási hely',
                icon: L.divIcon({
                    className: 'reference-marker', iconSize: [32, 40], iconAnchor: [16, 40],
                    html: '<i class="fa-solid fa-map-pin" aria-hidden="true"></i>'
                })
            }).addTo(this._map);
            // Drag the marker to change the reference location
            this._referenceMarker.on('dragstart', () => this._closeReferenceResults());
            this._referenceMarker.on('dragend', () => {
                const point = this._referenceMarker.getLatLng().wrap();
                this._setReference(point, `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`, false);
            });
            // Click the marker to clear the reference location
            this._referenceMarker.on('click', () => this._clearReference());
        } else
            this._referenceMarker.setLatLng(location);
        this._setLocation(this._actualLocation, '', true);
        if (zoom)
            this._map.setView(location, Math.max(17, this._map.getZoom()));
    }

    /** Removes the reference location and falls back to the GPS position. */
    _clearReference() {
        this._closeReferenceResults();
        this._referenceMarker?.remove();
        this._referenceMarker = null;
        this._referenceLocation = null;
        this._referenceAddress.value = '';
        localStorage.removeItem('eventMapReference');
        this._setLocation(this._actualLocation, '', true);
    }

    /** Keeps empty start at now and empty end unbounded; end dates are inclusive. */
    _initDates() {
        this._start = document.getElementById('date-start');
        this._end = document.getElementById('date-end');

        // Native picker action labels follow browser settings rather than the page language.
        flatpickr([this._start, this._end], {
            locale: 'hu',
            dateFormat: 'Y-m-d',
            altInput: true,
            altFormat: 'Y. m. d.',
            allowInput: true,
            disableMobile: true,
            static: true,
            minDate: 'today',
            onReady: (dates, value, picker) => {
                // Add "clear" and "today" buttons to the panel
                picker.altInput.id = picker.input.id + '-display';
                const actions = document.createElement('div');
                actions.className = 'date-actions';
                for (const [label, action] of [
                    ['Törlés', () => picker.clear()],
                    ['Ma', () => picker.setDate(new Date(), true)]
                ]) {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.textContent = label;
                    button.addEventListener('click', () => { action(); picker.close(); });
                    actions.append(button);
                }
                picker.calendarContainer.append(actions);
            }
        });

        const filter = document.getElementById('date-filter');
        const form = document.getElementById('date-form');

        // Prevent the default form submission and handle reset manually.
        form.addEventListener('submit', event => event.preventDefault());
        form.addEventListener('reset', event => {
            event.preventDefault();
            this._start._flatpickr.clear(false);
            endPicker.clear(false);
            endPicker.set('minDate', 'today');
            endPicker.altInput.setCustomValidity('');
            filter.open = false;
            this._resetDistance();
        });

        // Limit the end time picker to dates after the start date.
        const endPicker = this._end._flatpickr;
        const dateInputs = [
            this._start, this._end,
            this._start._flatpickr.altInput, endPicker.altInput
        ];
        form.addEventListener('change', event => {
            if (!dateInputs.includes(event.target))
                return;
            const reversed = this._end.value && this._start.value > this._end.value;
            endPicker.altInput.setCustomValidity(
                reversed ? 'A záródátum nem előzheti meg a kezdődátumot.' : ''
            );
            if (!form.reportValidity())
                return;
            endPicker.set('minDate', this._start.value || 'today');
            this._render();
        });

        // Close the filter when clicking outside of it or pressing Escape.
        const closeFilter = () => {
            filter.open = false;
            this._closeReferenceResults();
            this._start._flatpickr.close();
            endPicker.close();
        };
        document.addEventListener('pointerdown', event => {
            if (!filter.querySelector('summary').contains(event.target) &&
                !form.contains(event.target))
                closeFilter();
        });
        // Pointer events do not cross iframe boundaries; clean up on iframe navigation.
        parent.document.addEventListener('pointerdown', closeFilter, true);
        window.addEventListener('pagehide', () =>
            parent.document.removeEventListener('pointerdown', closeFilter, true));
        window.addEventListener('pageshow', event => {
            if (event.persisted)
                parent.document.addEventListener('pointerdown', closeFilter, true);
        });
        document.addEventListener('keydown', event => {
            if (event.key == 'Escape')
                closeFilter();
        });
    }

    /** Loads cached tables from the parent. */
    async _load() {
        this._status.textContent = 'Események betöltése...';
        try {
            const tables = await parent.calendars.loadMapData();
            this._events = geocodedEvents(...tables).sort((a, b) => a.start - b.start);
            this._loaded = true;
            this._render();
            this._updateDistances();
        } catch (error) {
            console.error('Failed to load event map.', error);
            this._status.textContent = 'Az események betöltése sikertelen.';
        }
    }

    /** Receives only the active page's selected calendar IDs, including Celica Club calendars. */
    setCalendars(calendars) {
        this._calendars = new Map(calendars.map(calendar => [calendar.id, calendar.clr]));
        this._render();
    }

    /** Updates the filter summary displayed on the dropdown control. */
    _updateFilterSummary() {
        const formatDate = value => new Date(value + 'T00:00:00').toLocaleDateString('hu-HU');
        document.getElementById('date-range').textContent =
            (this._start.value ? formatDate(this._start.value) : 'Mostantól') + ' \u2013 ' +
            (this._end.value ? formatDate(this._end.value) : 'Bármeddig');
        document.getElementById('distance-range').textContent =
            '\u2022 ' + this._distanceLabel.textContent;
    }

    /** Render map markers.
     * This function runs on init, when filters change or when zooming past "dot" view.
    */
    _render() {
        this._updateFilterSummary();

        if (!this._loaded)
            return;

        const { groups, count } = this._groupEvents();

        // Refresh map markers
        const usingDots = this._map.getZoom() < 10;
        const openMarker = this._markers.getLayers().find(marker => marker.isPopupOpen());
        const openPopupEvents = new Set(openMarker?.events);
        const scrollTop = openMarker?.getPopup().getElement()
            ?.querySelector('.event-details')?.scrollTop ?? 0;
        let replacement;
        this._usingDots = usingDots;
        this._markers.clearLayers();
        for (const { events } of groups) {
            const calendars = [...new Set(events.map(event => event.calendarId))];
            const colors = calendars.map(id => this._calendars.get(id));
            let marker;
            if (this._usingDots) {
                // Draw pins onto the canvas at high zoom levels for performance
                const color = colors.length > 1 ? '#' + [1, 3, 5].map(offset =>
                    Math.round(colors.reduce((sum, color) =>
                        sum + parseInt(color.slice(offset, offset + 2), 16), 0) / colors.length)
                        .toString(16).padStart(2, '0')).join('') : colors[0];
                marker = new CanvasPin(events[0].coordinates, {
                    renderer: this._dotRenderer, radius: 6,
                    color: this._dotBorderColor, weight: 0.5, opacity: 1,
                    stroke: true, fillColor: color, fillOpacity: 1
                });
            } else {
                // Overlay DOM Pins at low zoom levels for better interactivity
                const icon = L.divIcon({
                    className: 'event-marker',
                    iconSize: [24, 30],
                    iconAnchor: [12, 30],
                    popupAnchor: [0, -26],
                    html: `<i class="fa-solid fa-location-dot" aria-hidden="true"></i> ${
                        events.length > 1 ? `<span class="event-count">${events.length}</span>` : ''
                    }`
                });
                marker = L.marker(events[0].coordinates, { icon, title: events[0].location });
                const stops = colors.map((color, index) =>
                    color + (index == 0 ? ' 25%' : index == colors.length - 1 ? ' 90%' : ''));
                const color = colors.length > 1
                    ? `linear-gradient(135deg, ${stops.join(', ')})`
                    : colors[0];
                marker.on('add', () => marker.getElement().style.setProperty('--event-color', color));
            }
            marker.summary = events.length == 1 ? events[0].summary : null;
            marker.events = events;
            marker.bindPopup(() => this._popup(events), {
                className: 'event-popup', maxWidth: 550, minWidth: 220
            });

            this._markers.addLayer(marker);
            if (!replacement && events.some(event => openPopupEvents.has(event)))
                replacement = marker;
        }

        // Restore the popup as before the re-rendering
        if (replacement) {
            const popup = replacement.getPopup();
            const autoPan = popup.options.autoPan;
            popup.options.autoPan = false;
            replacement.openPopup();
            popup.getElement().querySelector('.event-details').scrollTop = scrollTop;
            popup.options.autoPan = autoPan;
        }

        this._updateLabels();
        this._status.textContent = `${count} esemény · ${groups.length} helyszín`;
    }

    /** Filters events and groups nearby locations for marker rendering. */
    _groupEvents() {
        // Calculate date filter time range
        const start = Math.max(
            Date.now(),
            this._start.value ? new Date(this._start.value + 'T00:00:00').getTime() : 0
        );
        const endDate = this._end.value ? new Date(this._end.value + 'T00:00:00') : null;
        // Advance a calendar day to preserve inclusive ends through daylight saving changes.
        endDate?.setDate(endDate.getDate() + 1);
        const end = endDate?.getTime() ?? Infinity;

        // Apply event marker filters
        const groups = [];
        const cells = new Map();
        let count = 0;
        for (const [index, event] of this._events.entries()) {
            // Apply user filters
            const tooFar = this._distanceLimit !== Infinity &&
                (!this._distances || this._distances[index] > this._distanceLimit * 1000);
            const outsideDates = event.end <= start || event.start >= end;
            const hiddenCategory = !this._calendars.has(event.calendarId);
            if (tooFar || outsideDates || hiddenCategory)
                continue;

            // Convert event coordinates to approximate 20-metre grid units for clustering
            const north = event.coordinates[0] * (111000 / 20);
            const east = event.coordinates[1] * (75000 / 20);
            // Index location into ~20-metre cells
            const row = Math.floor(north), column = Math.floor(east);
            // Scan the 3x3 neighborhood of cells for an existing group within 1 cell distance
            let group;
            for (let rowOffset = -1; rowOffset <= 1 && !group; ++rowOffset) {
                for (let columnOffset = -1; columnOffset <= 1 && !group; ++columnOffset) {
                    const nearby = cells.get(`${row + rowOffset},${column + columnOffset}`);
                    // Pythagoras distance is ok for such short distances
                    group = nearby?.find(candidate =>
                        (candidate.north - north) ** 2 + (candidate.east - east) ** 2 <= 1
                    );
                }
            }

            // Create a new event group
            if (!group) {
                group = { north, east, events: [] };
                groups.push(group);
                const key = `${row},${column}`;
                if (!cells.has(key))
                    cells.set(key, []);
                cells.get(key).push(group);
            }
            group.events.push(event);
            ++count;
        }
        return { groups, count };
    }

    /** Allocates labels only for visible event pins at town zoom or closer. */
    _updateLabels() {
        const closeZoom = this._map.getZoom() >= 10;
        const bounds = this._map.getBounds();
        this._markers.eachLayer(marker => {
            if (!closeZoom || !bounds.contains(marker.getLatLng())) {
                // Hide tooltips at high zoom levels and out of viewport.
                if (marker.getTooltip())
                    marker.unbindTooltip();
                return;
            }
            const text = [
                this._distances ? Math.round(marker.events[0].distance / 1000) + ' km' : '',
                marker.summary
            ].filter(Boolean).join(' · ');
            if (!marker.getTooltip()) {
                const label = document.createElement('span');
                label.textContent = text;
                marker.bindTooltip(label, {
                    permanent: true,
                    direction: 'bottom',
                    offset: [0, -5],
                    className: 'event-label',
                    interactive: false
                });
            } else if (marker.getTooltip().getContent().textContent != text) {
                marker.getTooltip().getContent().textContent = text;
                marker.getTooltip().update();
            }
        });
    }

    /** Builds icon-aligned details with safe Maps/source links and Budapest times. */
    _popup(events) {
        const container = $('<div>', { class: 'event-details' });
        const date = new Intl.DateTimeFormat('hu-HU', {
            dateStyle: 'long',
            timeStyle: 'short',
            timeZone: 'Europe/Budapest'
        });
        for (const event of events) {
            const locHref = new URL('https://maps.google.com/maps');
            locHref.search = new URLSearchParams({ q: event.location, source: 'calendar' }).toString();

            const details = $(`
<section style="--event-color: ${this._calendars.get(event.calendarId)};">
  <span class="event-calendar-color" aria-hidden="true"></span>
  <h2>summary</h2>
  <p class="event-time">${date.format(event.start)} &ndash; ${date.format(event.end)}</p>
  <a class="event-location" href="${locHref.href}" target="_blank" rel="noopener noreferrer">
    <i class="fa-solid fa-location-dot"></i> <span>location</span>
  </a>
  <i class="fa-solid fa-align-left"></i> <div class="event-description"></div>
</section>
`);

            details.find('h2').text(event.summary);
            details.find('.event-location span').text(event.location);
            const description = details.find('.event-description').html(
                DOMPurify.sanitize(event.description || '', {
                    ALLOWED_TAGS: ['a', 'p', 'br', 'ul', 'ol', 'li', 'b', 'strong', 'i', 'em'],
                    ALLOWED_ATTR: ['href', 'title']
                }));
            description.find('a').attr({ target: '_blank', rel: 'noopener noreferrer' });

            details.appendTo(container);
        }
        return container[0];
    }
}

window.eventMap = new EventMap();
